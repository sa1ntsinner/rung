// SPDX-License-Identifier: BUSL-1.1
using System.Text.Json;
using Rung.Online;
using Xunit;

namespace Rung.Online.Tests;

public sealed class NativeCaptureEncoderTests
{
    [Fact]
    public void RootCallerRefusesNestedOrMalformedStackFrames()
    {
        var raw = new byte[112]; raw[21] = 1; raw[96] = 1; raw[99] = 1; raw[103] = 118;
        Assert.Equal((1u, 118u), NativeCaptureEncoder.RootCaller(raw));
        raw[88] = 3;
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.RootCaller(raw));
        raw[88] = 0; raw[96] = 3;
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.RootCaller(raw));
        raw[96] = 1; raw[21] = 2;
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.RootCaller(raw));
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.RootCaller(raw[..100]));
    }
    [Fact]
    public void DecoderRefusesUnsafeIntegersAndMismatchedFieldWidthsWithoutTia()
    {
        var fields = new[] { new NativeCaptureField("before", "N", "{Scalar\"33554440\"LInt}", 0, 8, 32), new NativeCaptureField("after", "N", "{Scalar\"33554440\"LInt}", 16, 8, 33) };
        var plan = new NativeCapturePlan(new(), 64, fields); var raw = new byte[64]; raw[32] = raw[33] = 15;
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(raw, 9007199254740992L);
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Decode(plan, raw));
        Array.Clear(raw, 0, 32); fields[0] = fields[0] with { Type = "{Scalar\"33554437\"Int}" };
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Decode(plan, raw));
    }

    [Fact]
    public void RejectsInvalidMetadataBeforeLoadingInstalledSerializers()
    {
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Build(0, 4, new byte[8], [], 1));
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Build(4, 4, [], [], 1));
        Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Build(4, 4, new byte[8], [new("X", 32, 15, "Int")], 1));
    }

    [Fact]
    public void InstalledReferenceSerializersReproduceActualFixtureRequestAndLayout()
    {
        if (!File.Exists(@"C:\Program Files\Siemens\Automation\Portal V20\Bin\Siemens.Simatic.Lang.MC7Codegenerator.dll")) return;
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../tools/prove/captures/tis-generated-prepost.json"));
        using var doc = JsonDocument.Parse(File.ReadAllText(path)); var root = doc.RootElement;
        var fields = root.GetProperty("layout").EnumerateArray().Where(v => v.GetProperty("phase").GetString() == "before").ToArray();
        var bindings = fields.Select(v => new NativeScalar(v.GetProperty("name").GetString()!, v.GetProperty("bitOffset").GetUInt32(),
            v.GetProperty("type").GetString()!.EndsWith("Bool}") ? 1u : v.GetProperty("bytes").GetUInt32() * 8, v.GetProperty("type").GetString()!)).ToArray();
        var original = root.GetProperty("job").GetProperty("attributes");
        var trigger = Convert.FromHexString(original.GetProperty("2694").GetString()!);
        var uid = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(trigger.AsSpan(5, 4));
        var plan = NativeCaptureEncoder.Build(4, 4, Convert.FromBase64String(root.GetProperty("codeModifiedTimestamp").GetString()!), bindings, uid);
        // FB 17 whose instance is addressed through native pointer 4 (seen live): same addresses, another trigger block
        var other = NativeCaptureEncoder.Build(17, 4, Convert.FromBase64String(root.GetProperty("codeModifiedTimestamp").GetString()!), bindings, uid);
        Assert.Equal(plan.Request.RequestBlob, other.Request.RequestBlob);
        Assert.NotEqual(plan.Request.TriggerBlob, other.Request.TriggerBlob);
        Assert.Equal(Convert.FromHexString(original.GetProperty("2693").GetString()!), plan.Request.RequestBlob);
        Assert.Equal(trigger, plan.Request.TriggerBlob);
        Assert.Equal(456, plan.ResultBytes);
        Assert.Equal(70, plan.Fields.Length);
        foreach (var field in root.GetProperty("layout").EnumerateArray()) {
            var actual = Assert.Single(plan.Fields, v => v.Phase == field.GetProperty("phase").GetString() && v.Name == field.GetProperty("name").GetString());
            Assert.Equal(field.GetProperty("offset").GetInt32(), actual.Offset);
            Assert.Equal(field.GetProperty("validity").GetInt32(), actual.Validity);
        }
        foreach (var sample in root.GetProperty("observations").EnumerateArray()) {
            var raw = Convert.FromHexString(sample.GetProperty("result").GetString()!);
            Assert.Equal((1u, 118u), NativeCaptureEncoder.RootCaller(raw));
            var state = NativeCaptureEncoder.Decode(plan, raw);
            foreach (var pair in new[] { (state.Before, "before"), (state.After, "after") }) foreach (var value in pair.Item1) {
                var expected = sample.GetProperty(pair.Item2).GetProperty(value.Key);
                if (value.Value is bool boolean) Assert.Equal(expected.GetBoolean(), boolean);
                else Assert.Equal(expected.GetDouble(), Convert.ToDouble(value.Value));
            }
            raw[plan.Fields[0].Validity] = 0;
            Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Decode(plan, raw));
            Assert.ThrowsAny<Exception>(() => NativeCaptureEncoder.Decode(plan, raw[..^1]));
        }
    }
}
