// SPDX-License-Identifier: BUSL-1.1
using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text.Json;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;

namespace Rung.Online;

public sealed class OnlineDispatcher(Func<ConnectRequest, IOnlineDriver>? factory = null, WriterConfiguration? writerConfiguration = null,
    Func<ConnectRequest, PreparedWrite, CancellationToken, Task<WriteResult>>? send = null) : IAsyncDisposable
{
    public static readonly string[] Capabilities = ["online.connect", "online.browse", "online.read", "online.state", "online.disconnect", "online.certificate", "online.subscribe", "online.unsubscribe", "online.watchTable", "online.alarms"];
    public event Action<string>? Event;
    readonly Dictionary<string, OnlineSession> sessions = new();
    long epoch;

    public static void ValidateTarget(string? address) {
        if (IPAddress.TryParse(address, out var target) && (target.IsIPv4MappedToIPv6 ? target.MapToIPv4() : target).Equals(IPAddress.Parse("192.168.1.1")))
            throw new RpcException(ErrorCodes.TargetRefused, "192.168.1.1 is refused before connection.");
        if (target == null || target.AddressFamily != AddressFamily.InterNetwork || target.ToString() != address)
            throw new RpcException(ErrorCodes.BadRequest, "Address must be a canonical IPv4 literal.");
    }

    public async Task<string> HandleAsync(string line, CancellationToken token = default)
    {
        JsonElement id = default;
        var hasId = false;
        try {
            if (line.Length > RpcConstants.DefaultMaxLineLength) throw new RpcException(ErrorCodes.ResourceLimit, "Frame too large.");
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new RpcException(ErrorCodes.BadRequest, "Request must be an object.");
            if (root.TryGetProperty("id", out var identifier) && identifier.ValueKind is JsonValueKind.Number or JsonValueKind.String) { id = identifier.Clone(); hasId = true; }
            if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String) throw new RpcException(ErrorCodes.BadRequest, "Missing method.");
            var parameters = root.TryGetProperty("params", out var p) && p.ValueKind == JsonValueKind.Object ? p : JsonSerializer.SerializeToElement(new { });
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(60));
            var result = await DispatchAsync(method.GetString()!, parameters, timeout.Token);
            return RpcWire.Result(hasId, id, result);
        } catch (RpcException ex) { return RpcWire.Error(hasId, id, ex.Code, ex.Message); }
        catch (Exception ex) when (ex is JsonException or ArgumentException or InvalidOperationException) { return RpcWire.Error(hasId, id, ErrorCodes.BadRequest, "Malformed request or parameters."); }
        catch (Exception ex) {
            var code = FailureCode(ex);
            // Driver exceptions can contain credentials: expose a stable code and safe text only.
            return RpcWire.Error(hasId, id, code, "Online request failed: " + code + ".");
        }
    }
    internal static string FailureCode(Exception ex) => ex switch {
                RpcException rpc => rpc.Code,
                AuthenticationException => ErrorCodes.CertificateUntrusted,
                S7CommPlusLegitimationException => ErrorCodes.AuthenticationFailed,
                S7CommPlusException s7 => s7.ErrorCode switch {
                    S7Consts.errS7CommPlusCertificate => ErrorCodes.CertificateUntrusted,
                    S7Consts.errCliNeedPassword => ErrorCodes.AuthenticationRequired,
                    S7Consts.errCliInvalidPassword => ErrorCodes.AuthenticationFailed,
                    S7Consts.errCliAccessDenied => ErrorCodes.AccessDenied,
                    S7Consts.errOpenSSL or S7Consts.errInitSslResponse => ErrorCodes.TlsUnsupported,
                    _ => ErrorCodes.OnlineFailed,
                },
                OperationCanceledException or TimeoutException => "TIMEOUT",
                IOException or SocketException => ErrorCodes.OnlineFailed,
                _ => ErrorCodes.Internal,
            };

    async Task<object> DispatchAsync(string method, JsonElement p, CancellationToken token)
    {
        if (method == "bridge.hello") return new { protocol = RpcConstants.ProtocolVersion, tiaVersion = "", bridgeVersion = "0.1.0", capabilities = writerConfiguration == null ? Capabilities : [..Capabilities, "online.prepare", "online.commit"] };
        if (!Capabilities.Contains(method) && !(writerConfiguration != null && method is "online.prepare" or "online.commit")) throw new RpcException(ErrorCodes.UnsupportedCapability, "Unsupported online method.");
        if (method == "online.watchTable") return WatchTable.Parse(String(p, "xml"));
        if (method == "online.certificate") {
            var address = String(p, "address");
            ValidateTarget(address);
            var leaf = await Probe.InspectAsync(new(address, false, true), token);
            if (leaf == null) throw new RpcException(ErrorCodes.TlsUnsupported, "No PLC certificate was presented.");
            return new { address, certificateSha256 = Convert.ToHexString(SHA256.HashData(leaf)), details = CertificateDiagnostics.Format(leaf) };
        }
        if (method == "online.connect") {
            var request = p.Deserialize<ConnectRequest>(RpcWire.Json) ?? throw new RpcException(ErrorCodes.BadRequest, "Missing connect parameters.");
            ValidateTarget(request.Address);
            if (string.IsNullOrWhiteSpace(request.Device)) throw new RpcException(ErrorCodes.BadRequest, "Missing device.");
            if (request.CertificateSha256 == null || request.CertificateSha256.Length != 64 || !request.CertificateSha256.All(Uri.IsHexDigit)) throw new RpcException(ErrorCodes.CertificateUntrusted, "Verify and pin the PLC certificate with rung live trust --device <PLC>.");
            if (sessions.Count >= 16) throw new RpcException(ErrorCodes.ResourceLimit, "At most 16 sessions per host.");
            writerConfiguration?.Verify(request);
            var session = new OnlineSession((factory ?? (r => new OnlineDriver(r)))(request), writerConfiguration, send);
            try { await session.ConnectAsync(request, token, ++epoch); }
            catch { await session.DisposeAsync(); throw; }
            sessions.Add(session.Info.SessionId, session);
            session.Values += values => Event?.Invoke(JsonSerializer.Serialize(new { @event = "online.values", @params = values }, RpcWire.Json));
            session.AlarmsChanged += alarms => Event?.Invoke(JsonSerializer.Serialize(new { @event = "online.alarms", @params = alarms }, RpcWire.Json));
            return session.Info;
        }
        if (method == "online.unsubscribe") {
            var subscriptionId = String(p, "subscriptionId");
            foreach (var session in sessions.Values) if (await session.UnsubscribeAsync(subscriptionId)) break;
            return new { unsubscribed = true };
        }
        var sessionId = String(p, "sessionId");
        if (method == "online.disconnect") {
            if (sessions.Remove(sessionId, out var removed)) await removed.DisposeAsync();
            return new { disconnected = true };
        }
        if (!sessions.TryGetValue(sessionId, out var active)) throw new RpcException(ErrorCodes.NotFound, "Online session not found.");
        switch (method) {
            case "online.alarms":
                return await active.AlarmsAsync(p.TryGetProperty("lcid", out var lcid) ? lcid.GetInt32() : 1033,
                    p.TryGetProperty("subscribe", out var subscribe) && subscribe.ValueKind == JsonValueKind.True, token);
            case "online.prepare":
                return await active.PrepareAsync(p.Deserialize<WriteAction>(RpcWire.Json) ?? throw new RpcException(ErrorCodes.BadRequest, "Missing action."), token);
            case "online.commit":
                return await active.CommitAsync(String(p, "operationId"), String(p, "preview"), p.TryGetProperty("confirmed", out var confirmed) && confirmed.ValueKind == JsonValueKind.True, token);
            case "online.subscribe":
                if (!p.TryGetProperty("names", out var subscribedNames) || subscribedNames.ValueKind != JsonValueKind.Array || subscribedNames.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String)) throw new RpcException(ErrorCodes.BadRequest, "names must be an array of strings.");
                var cycleMs = p.TryGetProperty("cycleMs", out var cycle) ? cycle.GetInt32() : 250;
                return await active.SubscribeAsync(subscribedNames.EnumerateArray().Select(v => v.GetString()!).ToArray(), cycleMs, token);
            case "online.read":
                if (!p.TryGetProperty("names", out var names) || names.ValueKind != JsonValueKind.Array || names.EnumerateArray().Any(v => v.ValueKind != JsonValueKind.String)) throw new RpcException(ErrorCodes.BadRequest, "names must be an array of strings.");
                var items = await active.ReadAsync(names.EnumerateArray().Select(v => v.GetString()!).ToArray(), token);
                return new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = active.Info.Scope, items };
            case "online.browse":
                var catalog = await active.BrowseAsync(token);
                var filter = p.TryGetProperty("filter", out var f) ? f.GetString() : null;
                var offset = p.TryGetProperty("offset", out var o) ? o.GetInt32() : 0;
                var limit = p.TryGetProperty("limit", out var l) ? l.GetInt32() : 1000;
                if (offset < 0 || limit < 1 || limit > 1000) throw new RpcException(ErrorCodes.ResourceLimit, "Browse limit must be 1..1000; offset must be nonnegative.");
                var filtered = catalog.Where(v => filter == null || v.Name.Contains(filter, StringComparison.Ordinal)).ToArray();
                return new { scope = active.Info.Scope, symbols = filtered.Skip(offset).Take(limit).ToArray(), total = filtered.Length };
            case "online.state":
                return new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = active.Info.Scope, identity = active.Info.Identity, state = await active.StateAsync(token) };
            default: throw new RpcException(ErrorCodes.UnsupportedCapability, "Unsupported online method.");
        }
    }
    static string String(JsonElement p, string name) => p.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
        ? value.GetString()! : throw new RpcException(ErrorCodes.BadRequest, "Missing string parameter: " + name);

    public async ValueTask DisposeAsync() {
        foreach (var session in sessions.Values) await session.DisposeAsync();
        sessions.Clear();
    }
}
