// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

/// <summary>C# serialization must produce exactly the wire shapes in docs/format/protocol-golden.json (also checked from TypeScript).</summary>
public class ProtocolGoldenTests
{
    static readonly JsonElement G = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "protocol-golden.json"))).RootElement;

    static void Same<T>(string key)
    {
        var golden = G.GetProperty(key);
        var obj = JsonSerializer.Deserialize<T>(golden.GetRawText(), RpcDispatcher.Json);
        var again = JsonDocument.Parse(JsonSerializer.Serialize(obj, RpcDispatcher.Json)).RootElement;
        Assert.Equal(Canon(golden), Canon(again));
    }

    static string Canon(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", e.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => p.Name + ":" + Canon(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", e.EnumerateArray().Select(Canon)) + "]",
        _ => e.GetRawText(),
    };

    [Fact] public void ObjectEntry() => Same<ObjectEntry>("objectEntry");
    [Fact] public void ObjectEntryOmitsNulls() => Same<ObjectEntry>("objectEntryMinimal");
    [Fact] public void ExportResult() => Same<ExportResult>("exportResult");
    [Fact] public void ProjectInfo() => Same<ProjectInfo>("projectInfo");

    [Fact] public void ErrorCodesMatch()
    {
        var mine = typeof(ErrorCodes).GetFields(BindingFlags.Public | BindingFlags.Static).Select(f => (string)f.GetValue(null)).OrderBy(s => s, StringComparer.Ordinal);
        var golden = G.GetProperty("errorCodes").EnumerateArray().Select(e => e.GetString()).OrderBy(s => s, StringComparer.Ordinal);
        Assert.Equal(golden, mine);
    }
}
