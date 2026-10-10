// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
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
        public static readonly JsonSerializerOptions Json = RpcWire.Json;

        readonly Func<ITiaSession> _factory;
        readonly BridgeInfo _info;
        readonly int _maxLineLength;
        ITiaSession _session;
        bool _released;

        public RpcDispatcher(Func<ITiaSession> sessionFactory, BridgeInfo info, int maxLineLength = RpcConstants.DefaultMaxLineLength)
        {
            _factory = sessionFactory;
            _info = info;
            _maxLineLength = maxLineLength;
        }

        /// <summary>Written to stderr for unexpected exceptions; never to the protocol stream.</summary>
        public TextWriter Diagnostics { get; set; } = TextWriter.Null;

        ITiaSession Session => _released ? throw new RpcException(ErrorCodes.PortalDisposed, "The project was released; reconnect to use TIA Portal again.") : _session ?? (_session = _factory());

        /// <summary>Enumerates processes without attaching or starting TIA Portal.</summary>
        public Func<SessionState> SessionProbe { get; set; }
        /// <summary>Attaches for release with all opening flags disabled.</summary>
        public Func<ITiaSession> SessionAttach { get; set; }

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
            catch (Exception e) when (PortalGone(e))
            {
                // the bridge keeps no Disposed handler (see OpennessSession.Listen): a closed TIA Portal shows here
                return Error(hasId, id, ErrorCodes.PortalDisposed, "TIA Portal was closed. " + TiaText.Clean(e.Message));
            }
            catch (Exception e)
            {
                Diagnostics.WriteLine(e.ToString());
                return Error(hasId, id, ErrorCodes.Internal, e.Message);
            }
        }

        /// <summary>
        /// TIA Portal ended under a request (closed by hand, crashed): a disposed project or portal, or any disposed object
        /// whose cause is the remoting connection to TIA Portal (V20 writes it into the message). A disposed block alone
        /// is not it: the engineer deleted that block in a running TIA Portal. Clients drop the bridge and connect again.
        /// </summary>
        public static bool PortalGone(Exception e)
        {
            for (var x = e; x != null; x = x.InnerException)
            {
                var name = x.GetType().Name;
                if (name == "RemotingException") return true;
                // the remoting proxy of a TIA Portal that ended (not a block deleted in a running one: that is Engineering's own type)
                if (x is ObjectDisposedException od && (od.ObjectName ?? "").StartsWith("Siemens.Engineering", StringComparison.Ordinal)) return true;
                if (name != "EngineeringObjectDisposedException") continue;
                if (x.Message.Contains("Siemens.Engineering.Project") || x.Message.Contains("Siemens.Engineering.TiaPortal")) return true;
                if (x.Message.Contains("RemotingException") || x.Message.Contains("no longer running")) return true;
            }
            return false;
        }

        object Dispatch(string method, JsonElement p)
        {
            switch (method)
            {
                case "bridge.hello":
                    return new { protocol = RpcConstants.ProtocolVersion, tiaVersion = _info.TiaVersion, bridgeVersion = _info.BridgeVersion, capabilities = _info.Capabilities };
                case "project.info":
                    return Session.GetProjectInfo();
                case "session.state":
                    return _session != null ? _session.GetSessionState() : SessionProbe != null ? SessionProbe() : throw new RpcException(ErrorCodes.UnsupportedCapability, "Session inspection is unavailable.");
                case "session.release":
                case "session.discard":
                    if (_released) throw new RpcException(ErrorCodes.PortalDisposed, "The project was already released.");
                    if (Bool(p, "save") && (method == "session.discard" || Bool(p, "discard"))) throw new RpcException(ErrorCodes.BadRequest, "save and discard cannot be used together.");
                    if (_session == null) _session = (SessionAttach ?? _factory)();
                    _session.ReleaseSession(Bool(p, "save"), method == "session.discard" || Bool(p, "discard"));
                    _released = true; // requests already queued by other owner clients must never reopen TIA
                    _session = null;
                    return new { released = true };
                case "objects.list":
                    return Session.ListObjects(Str(p, "device"), Obj<Dictionary<string, KnownRevision>>(p, "known"));
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
                case "safety.observe":
                    LibraryParams(p,"device");var safetyDevice=Str(p,"device");if(safetyDevice.Length>128||safetyDevice.Any(char.IsControl))throw new RpcException(ErrorCodes.BadRequest,"Invalid safety PLC name");return Session.ObserveSafety(safetyDevice);
                case "artifact.export":
                case "artifact.preview":
                case "artifact.import":
                    {
                        LibraryParams(p,method=="artifact.export"?new[]{"kind","device","name"}:method=="artifact.preview"?new[]{"kind","device","name","contentBase64"}:new[]{"kind","device","name","contentBase64","expectedRevision","expectedArtifactRevision","operationId"});
                        var artifactKind=Str(p,"kind");var artifactDevice=Str(p,"device");var artifactName=artifactKind=="technology"?Str(p,"name"):null;
                        if((artifactKind!="alarms"&&artifactKind!="technology")||string.IsNullOrWhiteSpace(artifactDevice)||artifactDevice.Length>128||artifactDevice.Any(char.IsControl)||(artifactKind=="alarms"?p.TryGetProperty("name",out _):string.IsNullOrWhiteSpace(artifactName)||artifactName.Length>128||artifactName.Any(char.IsControl)))throw new RpcException(ErrorCodes.BadRequest,"Artifact requires alarms or technology, explicit PLC and technology object name");
                        if(method=="artifact.export")return Session.ExportProjectArtifact(artifactKind,artifactDevice,artifactName);
                        var encoded=Str(p,"contentBase64");if(encoded==null||encoded.Length>5592408)throw new RpcException(ErrorCodes.BadRequest,"Missing/oversized artifact");byte[] artifactBytes;
                        try{artifactBytes=Convert.FromBase64String(encoded);}catch(FormatException){throw new RpcException(ErrorCodes.BadRequest,"Invalid artifact base64");}
                        if(artifactBytes.Length==0||artifactBytes.Length>4*1048576||Convert.ToBase64String(artifactBytes)!=encoded)throw new RpcException(ErrorCodes.BadRequest,"Missing/oversized/noncanonical artifact");
                        if(method=="artifact.preview")return Session.PreviewProjectArtifact(artifactKind,artifactDevice,artifactName,artifactBytes);
                        var artifactRevision=Str(p,"expectedRevision");LibraryImportPlan.CheckRevision(artifactRevision);var artifactHash=Str(p,"expectedArtifactRevision");LibraryImportPlan.CheckRevision(artifactHash);if(Bundle.Sha256(artifactBytes)!=artifactHash)throw new RpcException(ErrorCodes.StaleRevision,"Artifact differs from preview");
                        if(!Guid.TryParseExact(Str(p,"operationId"),"D",out var artifactId)||artifactId==Guid.Empty)throw new RpcException(ErrorCodes.BadRequest,"Artifact operationId must be a UUID");
                        return Session.ImportProjectArtifact(artifactKind,artifactDevice,artifactName,artifactBytes,artifactRevision,artifactId.ToString("D"));
                    }
                case "hardware.snapshot":
                    var hardware = Session.Describe("hardware", 4096);
                    return new { version = 1, revision = HardwarePlan.Revision(hardware), tree = hardware };
                case "library.inspect":
                    LibraryParams(p,"stem","files");
                    return LibraryPackage.Check(LibraryFiles(p), Str(p, "stem"));
                case "library.preview":
                case "library.import":
                    LibraryParams(p,method == "library.preview" ? new[] { "stem","files","device" }
                        : new[] { "stem","files","device","expectedRevision","expectedPackageRevision","operationId" });
                    var libraryFiles = LibraryFiles(p); var libraryStem = Str(p, "stem");
                    var libraryPackage = LibraryPackage.Check(libraryFiles, libraryStem, true);
                    var libraryDevice = Str(p, "device");
                    if (string.IsNullOrEmpty(libraryDevice) || libraryDevice.Length > 128)
                        throw new RpcException(ErrorCodes.BadRequest, "Library import preview requires a PLC name");
                    if (method == "library.preview") return Session.PreviewLibrary(libraryPackage, libraryDevice);
                    var libraryRevision = Str(p,"expectedRevision"); var packageRevision = Str(p,"expectedPackageRevision");
                    LibraryImportPlan.CheckRevision(libraryRevision); LibraryImportPlan.CheckRevision(packageRevision);
                    if (packageRevision != libraryPackage.Revision) throw new RpcException(ErrorCodes.StaleRevision,"Library package differs from the preview");
                    var libraryOperation = Str(p,"operationId");
                    if (!Guid.TryParseExact(libraryOperation,"D",out var importId) || importId == Guid.Empty)
                        throw new RpcException(ErrorCodes.BadRequest,"Library operationId must be a UUID");
                    return InTempDir(dir => {
                        foreach (var file in libraryFiles) File.WriteAllBytes(Path.Combine(dir,file.Key),file.Value);
                        return Session.ImportLibrary(libraryPackage,libraryDevice,dir,libraryStem,libraryRevision,importId.ToString("D"));
                    });
                case "library.export":
                    LibraryParams(p,"typeGuid","versionGuid");
                    var typeGuid = Str(p, "typeGuid"); var versionGuid = Str(p, "versionGuid");
                    if (!Guid.TryParseExact(typeGuid, "D", out var typeId) || typeId == Guid.Empty
                        || !Guid.TryParseExact(versionGuid, "D", out var versionId) || versionId == Guid.Empty)
                        throw new RpcException(ErrorCodes.BadRequest, "Library export requires type and version UUIDs");
                    return InTempDir(dir => {
                        var files = Session.ExportLibrary(typeId.ToString("D"), versionId.ToString("D"), dir);
                        var metadata = LibraryPackage.Check(files, "type");
                        if (metadata.TypeGuid != typeId.ToString("D") || metadata.SourceVersionGuid != versionId.ToString("D"))
                            throw new RpcException(ErrorCodes.BadRequest, "Native export identity differs from the requested library version");
                        return new { metadata, files = new[] {
                            new { name = "type.xml", contentBase64 = Convert.ToBase64String(files["type.xml"]) },
                            new { name = "type.libinfo", contentBase64 = Convert.ToBase64String(files["type.libinfo"]) } } };
                    });
                case "library.release.preview":
                case "library.update.preview":
                case "library.update":
                    if(method.StartsWith("library.update",StringComparison.Ordinal)){
                        LibraryParams(p,method=="library.update.preview"?new[]{"typeGuid","versionGuid","device"}:new[]{"typeGuid","versionGuid","device","expectedRevision","operationId"});
                        var updateRequest=new LibraryUpdateRequest{TypeGuid=Str(p,"typeGuid"),VersionGuid=Str(p,"versionGuid"),Device=Str(p,"device")};LibraryUpdatePlan.Check(updateRequest);
                        updateRequest.TypeGuid=Guid.Parse(updateRequest.TypeGuid).ToString("D");updateRequest.VersionGuid=Guid.Parse(updateRequest.VersionGuid).ToString("D");
                        if(method=="library.update.preview")return Session.PreviewLibraryUpdate(updateRequest);
                        var updateRevision=Str(p,"expectedRevision");LibraryImportPlan.CheckRevision(updateRevision);
                        if(!Guid.TryParseExact(Str(p,"operationId"),"D",out var updateId)||updateId==Guid.Empty)throw new RpcException(ErrorCodes.BadRequest,"Library operationId must be a UUID");
                        return Session.UpdateLibrary(updateRequest,updateRevision,updateId.ToString("D"));
                    }
                    goto case "library.release";
                case "library.release":
                    LibraryParams(p,method=="library.release.preview" ? new[] {"typeGuid","versionGuid","versionNumber","author","comment"}
                        : new[] {"typeGuid","versionGuid","versionNumber","author","comment","expectedRevision","operationId"});
                    var releaseRequest=new LibraryReleaseRequest { TypeGuid=Str(p,"typeGuid"),VersionGuid=Str(p,"versionGuid"),VersionNumber=Str(p,"versionNumber"),Author=Str(p,"author"),Comment=Str(p,"comment") };
                    LibraryReleasePlan.Check(releaseRequest);
                    releaseRequest.TypeGuid=Guid.Parse(releaseRequest.TypeGuid).ToString("D");releaseRequest.VersionGuid=Guid.Parse(releaseRequest.VersionGuid).ToString("D");
                    if(method=="library.release.preview")return Session.PreviewLibraryRelease(releaseRequest);
                    var releaseRevision=Str(p,"expectedRevision");LibraryImportPlan.CheckRevision(releaseRevision);
                    if(!Guid.TryParseExact(Str(p,"operationId"),"D",out var releaseId)||releaseId==Guid.Empty)throw new RpcException(ErrorCodes.BadRequest,"Library operationId must be a UUID");
                    return Session.ReleaseLibrary(releaseRequest,releaseRevision,releaseId.ToString("D"));
                case "hardware.preview":
                case "hardware.apply":
                    var patchText = Str(p, "patchText");
                    if (patchText == null || patchText.Length > 1048576)
                        throw new RpcException(ErrorCodes.BadRequest, "Hardware preview requires a patch");
                    JsonDocument patch;
                    try { patch = JsonDocument.Parse(patchText); }
                    catch (JsonException) { throw new RpcException(ErrorCodes.BadRequest, "Malformed hardware patch JSON"); }
                    using (patch)
                    {
                        var parsedPatch = HardwarePlan.Parse(patch.RootElement);
                        return method == "hardware.apply" ? Session.ApplyHardware(parsedPatch, Str(p, "operationId"))
                            : Session.PreviewHardware(parsedPatch);
                    }
                case "objects.identify":
                    return Session.Identify(StrArray(p, "addresses"));
                case "xref.get":
                    return Session.XRef(Str(p, "address"));
                case "plc.compile":
                    return Bool(p, "hardware") ? Session.CompileHardware(Str(p, "device")) : Session.Compile(Str(p, "device"), StrArray(p, "addresses"));
                case "plc.online":
                    return Session.Online(Str(p, "device"), Str(p, "action"), Obj<ConnectionTarget>(p, "target"), Obj<OnlineCredentialsInput>(p, "credentials"));
                case "plc.compare":
                    return Session.Compare(Str(p, "device"), Obj<ConnectionTarget>(p, "target"), Obj<OnlineCredentialsInput>(p, "credentials"));
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
                    Session.Show(Str(p, "address"), Bool(p, "save"));
                    return new { shown = true };
                case "project.archive":
                    return Session.Archive(OptStr(p, "dir"), p.ValueKind == JsonValueKind.Object && p.TryGetProperty("keep", out var keep) && keep.ValueKind == JsonValueKind.Number ? keep.GetInt32() : 10);
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
        static void LibraryParams(JsonElement p, params string[] allowed)
        {
            if (p.ValueKind != JsonValueKind.Object) throw new RpcException(ErrorCodes.BadRequest,"Library parameters must be an object");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in p.EnumerateObject())
                if (Array.IndexOf(allowed,field.Name) < 0 || !seen.Add(field.Name))
                    throw new RpcException(ErrorCodes.BadRequest,"Unknown or duplicate library parameter: " + field.Name);
        }
        static IReadOnlyDictionary<string, byte[]> LibraryFiles(JsonElement p)
        {
            if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array || files.GetArrayLength() != 2)
                throw new RpcException(ErrorCodes.BadRequest, "Library package requires two native files");
            var result = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in files.EnumerateArray())
            {
                if (file.ValueKind != JsonValueKind.Object) throw new RpcException(ErrorCodes.BadRequest, "Invalid library file");
                var fields = new HashSet<string>(StringComparer.Ordinal);
                foreach (var field in file.EnumerateObject())
                    if ((field.Name != "name" && field.Name != "contentBase64") || !fields.Add(field.Name)) throw new RpcException(ErrorCodes.BadRequest, "Unknown or duplicate library file field");
                var name = Str(file, "name"); var content = Str(file, "contentBase64");
                if (name.Length > 128 || content.Length > 5592408 || result.ContainsKey(name)) throw new RpcException(ErrorCodes.BadRequest, "Invalid or oversized library file");
                try { result.Add(name, Convert.FromBase64String(content)); }
                catch (FormatException) { throw new RpcException(ErrorCodes.BadRequest, "Malformed library file base64"); }
            }
            return result;
        }
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

        /// <summary>A string parameter the caller may leave out: null then.</summary>
        static string OptStr(JsonElement p, string name) =>
            p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString().Length > 0 ? v.GetString() : null;

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

        static string Error(bool hasId, JsonElement id, string code, string message) => RpcWire.Error(hasId, id, code, message);
        static string Write(bool hasId, JsonElement id, Action<Utf8JsonWriter> body) => RpcWire.Write(hasId, id, body);
        public static string Event(string name, object parameters) => RpcWire.Event(name, parameters);
    }
}
