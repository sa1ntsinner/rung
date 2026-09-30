// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Generic;
using Rung.Bridge.Core.Model;

namespace Rung.Bridge.Core.Protocol
{
    /// <summary>
    /// Handles one JSON-lines request and returns one JSON response line.
    /// Stateless apart from the lazily created session; call it from the owner thread only.
    /// </summary>
    public sealed class RpcDispatcher
    {
        public static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            IncludeFields = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        readonly Func<ITiaSession> _factory;
        readonly BridgeInfo _info;
        readonly int _maxLineLength;
        ITiaSession _session;

        public RpcDispatcher(Func<ITiaSession> sessionFactory, BridgeInfo info, int maxLineLength = RpcConstants.DefaultMaxLineLength)
        {
            _factory = sessionFactory;
            _info = info;
            _maxLineLength = maxLineLength;
        }

        /// <summary>Written to stderr for unexpected exceptions; never to the protocol stream.</summary>
        public TextWriter Diagnostics { get; set; } = TextWriter.Null;

        ITiaSession Session => _session ?? (_session = _factory());

        public string Handle(string line)
        {
            JsonElement id = default;
            var hasId = false;
            try
            {
                if (line == null || line.Length > _maxLineLength) throw new RpcException(ErrorCodes.BadRequest, "Frame missing or too large.");
                JsonDocument doc;
                try { doc = JsonDocument.Parse(line); }
                catch (JsonException) { throw new RpcException(ErrorCodes.BadRequest, "Malformed JSON."); }
                using (doc)
                {
                    var root = doc.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) throw new RpcException(ErrorCodes.BadRequest, "Request must be an object.");
                    if (root.TryGetProperty("id", out var idEl) && (idEl.ValueKind == JsonValueKind.Number || idEl.ValueKind == JsonValueKind.String))
                    {
                        id = idEl.Clone();
                        hasId = true;
                    }
                    if (!root.TryGetProperty("method", out var m) || m.ValueKind != JsonValueKind.String)
                        throw new RpcException(ErrorCodes.BadRequest, "Missing method.");
                    var p = root.TryGetProperty("params", out var pe) && pe.ValueKind == JsonValueKind.Object ? pe : default;
                    var result = Dispatch(m.GetString(), p);
                    return Write(hasId, id, w => { w.WritePropertyName("result"); JsonSerializer.Serialize(w, result, result?.GetType() ?? typeof(object), Json); });
                }
            }
            catch (RpcException e)
            {
                return Error(hasId, id, e.Code, TiaText.Clean(e.Message));
            }
            catch (Exception e)
            {
                Diagnostics.WriteLine(e.ToString());
                return Error(hasId, id, ErrorCodes.Internal, e.Message);
            }
        }

        object Dispatch(string method, JsonElement p)
        {
            switch (method)
            {
                case "bridge.hello":
                    return new { protocol = RpcConstants.ProtocolVersion, tiaVersion = _info.TiaVersion, bridgeVersion = _info.BridgeVersion, capabilities = _info.Capabilities };
                case "project.info":
                    return Session.GetProjectInfo();
                case "objects.list":
                    return Session.ListObjects(Str(p, "device"));
                case "objects.export":
                    if (Bool(p, "inline")) return InTempDir(dir => Inline(Session.Export(Str(p, "address"), Str(p, "form"), dir)));
                    return Session.Export(Str(p, "address"), Str(p, "form"), Str(p, "dir"));
                case "objects.import":
                    if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("files", out var sent))
                        return InTempDir(dir => Inline(Session.Import(Str(p, "address"), Str(p, "form"), WriteSent(dir, sent, Str(p, "primary")), Str(p, "expectedTiaRevision"), Str(p, "operationId"))));
                    return Session.Import(Str(p, "address"), Str(p, "form"), Str(p, "path"), Str(p, "expectedTiaRevision"), Str(p, "operationId"));
                case "objects.receipts":
                    return new { landed = Receipts.Landed(StrArray(p, "operationIds")) };
                case "objects.delete":
                    Session.Delete(Str(p, "address"), Str(p, "expectedTiaRevision"), Str(p, "operationId"));
                    return new { deleted = true };
                case "objects.rename":
                    return new { address = Session.Rename(Str(p, "address"), Str(p, "newName"), Str(p, "expectedTiaRevision"), Str(p, "operationId")) };
                case "model.describe":
                    return Session.Describe(Str(p, "scope"), p.ValueKind == JsonValueKind.Object && p.TryGetProperty("maxNodes", out var mn) && mn.ValueKind == JsonValueKind.Number ? mn.GetInt32() : 20000);
                case "xref.get":
                    return Session.XRef(Str(p, "address"));
                case "plc.compile":
                    return Bool(p, "hardware") ? Session.CompileHardware(Str(p, "device")) : Session.Compile(Str(p, "device"), StrArray(p, "addresses"));
                case "plc.online":
                    return Session.Online(Str(p, "device"), Str(p, "action"), Obj<ConnectionTarget>(p, "target"));
                case "plc.compare":
                    return Session.Compare(Str(p, "device"), Obj<ConnectionTarget>(p, "target"));
                case "plc.connections":
                    return Session.Connections(Str(p, "device"), Bool(p, "scan"));
                case "plc.download":
                {
                    var req = Obj<DownloadRequest>(p, "request") ?? throw new RpcException(ErrorCodes.BadRequest, "Missing request");
                    if (string.IsNullOrEmpty(req.Device)) throw new RpcException(ErrorCodes.BadRequest, "request.device is required");
                    return Session.Download(req);
                }
                case "plc.upload":
                {
                    var req = Obj<UploadRequest>(p, "request") ?? throw new RpcException(ErrorCodes.BadRequest, "Missing request");
                    if (string.IsNullOrEmpty(req.Address)) throw new RpcException(ErrorCodes.BadRequest, "request.address is required");
                    return Session.UploadStation(req);
                }
                case "objects.show":
                    Session.Show(Str(p, "address"));
                    return new { shown = true };
                default:
                    throw new RpcException(ErrorCodes.BadRequest, "Unknown method: " + method);
            }
        }

        // ---- files across the connection (a client on another machine, e.g. Linux over SSH): the bridge stages them itself

        static T InTempDir<T>(Func<string, T> work)
        {
            var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "rung-inline", Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(dir);
            try { return work(dir); }
            finally
            {
                try { System.IO.Directory.Delete(dir, true); } catch (System.IO.IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        /// <summary>The result's files as text, named instead of located.</summary>
        static ExportResult Inline(ExportResult r)
        {
            foreach (var f in r.Files ?? new ExportFile[0])
            {
                f.Content = System.IO.File.ReadAllText(f.Path, new System.Text.UTF8Encoding(false));
                f.Path = System.IO.Path.GetFileName(f.Path);
            }
            return r;
        }

        static readonly System.Text.RegularExpressions.Regex SentName = new System.Text.RegularExpressions.Regex(@"^[A-Za-z0-9_.%~ -]{1,200}$");

        /// <summary>Writes the sent bundle ([{name, content}]) into dir; returns the path of the primary file.</summary>
        static string WriteSent(string dir, JsonElement files, string primary)
        {
            if (files.ValueKind != JsonValueKind.Array) throw new RpcException(ErrorCodes.BadRequest, "files must be an array");
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in files.EnumerateArray())
            {
                var name = f.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                var content = f.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
                // plain file names only: nothing may land outside the staging folder
                if (name == null || content == null || !SentName.IsMatch(name) || name.Trim('.').Length == 0 || name.Contains("..") || !names.Add(name))
                    throw new RpcException(ErrorCodes.BadRequest, "Invalid file in files: " + (name ?? "(no name)"));
                System.IO.File.WriteAllText(System.IO.Path.Combine(dir, name), content, new System.Text.UTF8Encoding(false));
            }
            if (!names.Contains(primary)) throw new RpcException(ErrorCodes.BadRequest, "primary " + primary + " is not among the files");
            return System.IO.Path.Combine(dir, primary);
        }

        static string Str(JsonElement p, string name)
        {
            if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String || v.GetString().Length == 0)
                throw new RpcException(ErrorCodes.BadRequest, "Missing or invalid string parameter: " + name);
            return v.GetString();
        }

        static bool Bool(JsonElement p, string name) =>
            p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        static T Obj<T>(JsonElement p, string name) where T : class
        {
            if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
            if (v.ValueKind != JsonValueKind.Object) throw new RpcException(ErrorCodes.BadRequest, "Parameter must be an object: " + name);
            return JsonSerializer.Deserialize<T>(v.GetRawText(), Json);
        }

        static string[] StrArray(JsonElement p, string name)
        {
            if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return new string[0];
            if (v.ValueKind != JsonValueKind.Array) throw new RpcException(ErrorCodes.BadRequest, "Parameter must be an array of strings: " + name);
            var list = new System.Collections.Generic.List<string>();
            foreach (var e in v.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.String) throw new RpcException(ErrorCodes.BadRequest, "Parameter must be an array of strings: " + name);
                list.Add(e.GetString());
            }
            return list.ToArray();
        }

        static string Error(bool hasId, JsonElement id, string code, string message) =>
            Write(hasId, id, w =>
            {
                w.WritePropertyName("error");
                w.WriteStartObject();
                w.WriteString("code", code);
                w.WriteString("message", message ?? "");
                w.WriteEndObject();
            });

        static string Write(bool hasId, JsonElement id, Action<Utf8JsonWriter> body)
        {
            using (var ms = new MemoryStream())
            {
                using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
                {
                    w.WriteStartObject();
                    w.WritePropertyName("id");
                    if (hasId) id.WriteTo(w); else w.WriteNullValue();
                    body(w);
                    w.WriteEndObject();
                }
                return new UTF8Encoding(false).GetString(ms.ToArray());
            }
        }

        /// <summary>Serializes an unsolicited event line: {"event": name, "params": ...}.</summary>
        public static string Event(string name, object parameters)
        {
            using (var ms = new MemoryStream())
            {
                using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
                {
                    w.WriteStartObject();
                    w.WriteString("event", name);
                    w.WritePropertyName("params");
                    JsonSerializer.Serialize(w, parameters, parameters?.GetType() ?? typeof(object), Json);
                    w.WriteEndObject();
                }
                return new UTF8Encoding(false).GetString(ms.ToArray());
            }
        }
    }
}
