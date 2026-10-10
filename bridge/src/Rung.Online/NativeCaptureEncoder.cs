// SPDX-License-Identifier: BUSL-1.1
using System.Reflection;
using System.Buffers.Binary;
using System.Text.RegularExpressions;
using S7CommPlusDriver;

namespace Rung.Online;

public sealed record NativeCaptureField(string Phase, string Name, string Type, int Offset, int Bytes, int Validity);
public sealed record NativeCapturePlan(S7CommPlusTisWatchRequest Request, int ResultBytes, NativeCaptureField[] Fields);
public sealed record NativeCaptureState(Dictionary<string, object> Before, Dictionary<string, object> After);
public sealed record NativeCaptureObservation(long ObservedAt, uint Sequence, NativeCaptureState State);
public sealed record NativeCaptureResult(NativeBody[] Bodies, NativeScalar[] Scalars, NativeRootCall Route, string CodeSignature, NativeCaptureObservation[] Samples, NativeConstant[]? Constants = null, NativeFunctionSource[]? Functions = null);
public sealed record OnlineNativeCapture(LiveScope Scope, NativeCaptureResult Capture, string Coherence = "subscription-sample");

/// <summary>Pure installed V20 serializers; no Device, Job or network objects.</summary>
public static class NativeCaptureEncoder
{
    const string Folder = @"C:\Program Files\Siemens\Automation\Portal V20\Bin";
    const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
    static readonly object Gate = new();
    static readonly HashSet<string> Loading = [];
    static bool registered;
    static readonly Dictionary<string, uint> Widths = new() { ["Bool"] = 1, ["Byte"] = 8, ["SInt"] = 8, ["USInt"] = 8,
        ["Int"] = 16, ["UInt"] = 16, ["Word"] = 16, ["DInt"] = 32, ["UDInt"] = 32, ["DWord"] = 32,
        ["Real"] = 32, ["LInt"] = 64, ["ULInt"] = 64, ["LWord"] = 64, ["LReal"] = 64, ["Time"] = 32 };
    static object? Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, Flags, null, args.Select(a => a.GetType()).ToArray(), null)!.Invoke(target, args);
    static int Align(int value, int bytes) => checked((value + bytes - 1) / bytes * bytes);

    /// <summary>The caller of a block called right from an OB: the stack holds that one frame.</summary>
    public static (uint Number, uint Sac) RootCaller(byte[] raw)
    {
        var frames = CallerFrames(raw);
        if (frames.Length != 1) throw new NotSupportedException("Unsupported native caller stack.");
        return (frames[0].Number, frames[0].Sac);
    }

    /// <summary>
    /// The call chain a sample reports, outermost first: ten 8-byte slots (bytes 24–103), the innermost caller in the
    /// last, each [type 1 = OB, 3 = FB][0][block number][call site SAC]. Seen on S7-1500 V20: OB1 → FB_ProveMath → #inner.
    /// </summary>
    public static (byte Type, uint Number, uint Sac)[] CallerFrames(byte[] raw)
    {
        if (raw.Length < 112 || raw[22] != 0 || raw[23] != 0) throw new NotSupportedException("Unsupported native caller stack.");
        var frames = new List<(byte Type, uint Number, uint Sac)>();
        for (var at = 24; at <= 96; at += 8)
        {
            var slot = raw.AsSpan(at, 8);
            if (!slot.ContainsAnyExcept((byte)0)) { if (frames.Count > 0) throw new NotSupportedException("Native caller stack has a gap."); continue; }
            if (slot[1] != 0 || slot[0] != 1 && slot[0] != 3) throw new NotSupportedException("Unsupported native caller frame.");
            frames.Add((slot[0], BinaryPrimitives.ReadUInt16BigEndian(slot[2..4]), BinaryPrimitives.ReadUInt32BigEndian(slot[4..8])));
        }
        if (frames.Count == 0 || frames[0].Type != 1 || frames.Skip(1).Any(f => f.Type != 3) || frames.Any(f => f.Number == 0)
            || BinaryPrimitives.ReadUInt16BigEndian(raw.AsSpan(20, 2)) != frames[0].Number)
            throw new NotSupportedException("Native caller stack disagrees with its OB.");
        return frames.ToArray();
    }

    public static NativeCaptureState Decode(NativeCapturePlan plan, byte[] raw)
    {
        if (raw.Length != plan.ResultBytes || raw.Length > 1_048_576 || plan.Fields.Length is 0 or > 512) throw new ArgumentException("Incomplete native payload.");
        var state = new NativeCaptureState(new(), new());
        foreach (var field in plan.Fields) {
            if (field.Offset < 0 || field.Bytes < 1 || field.Offset > raw.Length - field.Bytes || field.Validity < 0 || field.Validity >= raw.Length)
                throw new ArgumentException("Invalid native value.");
            if (raw[field.Validity] != 15) throw new NotSupportedException($"#{field.Name} ({field.Phase}) is not valid in this native sample (validity {raw[field.Validity]:X2}).");
            var data = raw.AsSpan(field.Offset, field.Bytes);
            var type = Regex.Match(field.Type, "^\\{Scalar\"[0-9]+\"([A-Za-z0-9_]+)\\}$").Groups[1].Value;
            if (!Widths.TryGetValue(type, out var bits) || field.Bytes != Math.Max(1, (int)bits / 8)) throw new ArgumentException("Native scalar width differs from its type.");
            object value = type switch {
                "Bool" => data[0] != 0, "Byte" or "USInt" => data[0], "SInt" => (sbyte)data[0],
                "Int" => BinaryPrimitives.ReadInt16BigEndian(data), "UInt" or "Word" => BinaryPrimitives.ReadUInt16BigEndian(data),
                "DInt" or "Time" => BinaryPrimitives.ReadInt32BigEndian(data), "UDInt" or "DWord" => BinaryPrimitives.ReadUInt32BigEndian(data),
                "Real" => BinaryPrimitives.ReadSingleBigEndian(data), "LReal" => BinaryPrimitives.ReadDoubleBigEndian(data),
                "LInt" => BinaryPrimitives.ReadInt64BigEndian(data), "ULInt" or "LWord" => BinaryPrimitives.ReadUInt64BigEndian(data),
                _ => throw new NotSupportedException("Unsupported native scalar type."),
            };
            if (value is float f && !float.IsFinite(f) || value is double d && !double.IsFinite(d)
                || value is long l && (l < -9007199254740991L || l > 9007199254740991L) || value is ulong u && u > 9007199254740991UL)
                throw new NotSupportedException("Native scalar cannot be represented safely for replay.");
            var destination = field.Phase switch { "before" => state.Before, "after" => state.After, _ => throw new ArgumentException("Invalid native capture phase.") };
            destination.Add(field.Name, value);
        }
        if (state.Before.Count != state.After.Count || state.Before.Keys.Any(k => !state.After.ContainsKey(k))) throw new ArgumentException("Incomplete native state phases.");
        return state;
    }

    /// <param name="block">FB number: where the trigger fires.</param>
    /// <param name="pointer">native pointer the instance is addressed through (the debug info's pointerNumber).</param>
    public static NativeCapturePlan Build(uint block, uint pointer, byte[] signature, NativeScalar[] scalars, uint uid)
    {
        if (block is 0 or > 65535 || pointer > 255 || signature.Length != 8 || scalars.Length is 0 or > 256) throw new ArgumentException("Invalid native capture metadata.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var scalar in scalars) {
            var type = Regex.Match(scalar.Type, "^\\{Scalar\"[0-9]+\"([A-Za-z0-9_]+)\\}$");
            if (!names.Add(scalar.Name) || string.IsNullOrWhiteSpace(scalar.Name) || !type.Success || !Widths.TryGetValue(type.Groups[1].Value, out var bits)
                || bits != scalar.Bits || scalar.BitOffset > uint.MaxValue - bits) throw new ArgumentException("Unsupported native scalar metadata.");
        }
        var sorted = scalars.OrderBy(s => s.BitOffset).ToArray();
        if (sorted.Skip(1).Where((s, i) => s.BitOffset < sorted[i].BitOffset + sorted[i].Bits).Any()) throw new ArgumentException("Native scalar addresses overlap.");
        lock (Gate) return Serialize(block, pointer, signature, scalars, uid);
    }

    static NativeCapturePlan Serialize(uint block, uint pointer, byte[] signature, NativeScalar[] scalars, uint uid)
    {
        if (!registered) {
            AppDomain.CurrentDomain.AssemblyResolve += (_, args) => {
                var name = new AssemblyName(args.Name).Name!;
                if (!name.StartsWith("Siemens.", StringComparison.Ordinal)) return null;
                lock (Loading) if (!Loading.Add(args.Name)) return null;
                try { var file = Path.Combine(Folder, name + ".dll"); return File.Exists(file) ? Assembly.LoadFrom(file) : null; }
                finally { lock (Loading) Loading.Remove(args.Name); }
            };
            registered = true;
        }
        Assembly Load(string name, Version version) {
            var file = Path.Combine(Folder, name + ".dll");
            if (!File.Exists(file)) throw new NotSupportedException("Installed V20 native serializers unavailable.");
            var assembly = Assembly.LoadFrom(file);
            if (assembly.GetName().Version != version) throw new NotSupportedException("Unvalidated native serializer version.");
            return assembly;
        }
        var compiler = Load("Siemens.Simatic.Lang.MC7Codegenerator", new(1700, 0, 0, 0));
        var plus = Load("Siemens.Simatic.Lang.TisPlusServer", new(2000, 0, 9501, 1));
        var server = Load("Siemens.Simatic.Lang.TisServer", new(2000, 0, 9501, 1));
        var encoderType = compiler.GetType("Siemens.Simatic.Lang.CodeGenPlus.DOL.MC7plus.DataAddressEncoder", true)!;
        var encoder = Activator.CreateInstance(encoderType)!;
        var indirect = encoderType.GetMethods(Flags).Single(m => m.Name == "AsIndirect" && m.GetParameters().Length == 5);
        var scope = Enum.Parse(indirect.GetParameters()[2].ParameterType, "NativeBlock");
        var blobType = plus.GetType("Siemens.Simatic.PlcLanguages.TisPlusServer.Blob", true)!;
        var bufferType = server.GetType("Siemens.Simatic.PlcLanguages.TisServer.SwapEndianBuffer", true)!;
        var addressType = plus.GetType("Siemens.Simatic.PlcLanguages.TisPlusServer.DataAddress", true)!;
        object Blob() => Activator.CreateInstance(blobType, [Activator.CreateInstance(bufferType)!])!;
        byte[] Bytes(object blob) => ((byte[])Call(blob, "GetBuffer")!).Take((int)blobType.GetProperty("Pos", Flags)!.GetValue(blob)!).ToArray();
        int position = 112;
        var fields = new List<NativeCaptureField>();
        foreach (var phase in new[] { "before", "after" }) foreach (var scalar in scalars) {
            var bytes = Math.Max(1, (int)scalar.Bits / 8); position = Align(position, bytes);
            fields.Add(new(phase, scalar.Name, scalar.Type, position, bytes, 0)); position += bytes;
        }
        int validity = Math.Max(380, Align(position, 4));
        var resultBytes = Math.Max(456, Align(validity + fields.Count, 8));
        var blob = Blob();
        void Token(byte token, uint value) => Call(blob, "WriteTokenAndValue", token, value);
        void Byte(byte value) => Call(blob, "WriteUInt8", value);
        Token(64, (uint)resultBytes); Byte(50); Byte(6); Byte(36); Token(68, 10); Token(72, 20);
        int fieldIndex = 0;
        foreach (var phase in new[] { "before", "after" }) {
            if (phase == "after") { Token(144, 104); Token(96, 0); }
            Byte((byte)(phase == "before" ? 7 : 8));
            foreach (var scalar in scalars) {
                var field = fields[fieldIndex] with { Validity = validity++ }; fields[fieldIndex++] = field;
                Token(128, (uint)field.Offset); Token(132, (uint)field.Validity);
                var address = Activator.CreateInstance(addressType)!;
                var width = scalar.Bits switch { 1 => "Bit", 8 => "Byte", 16 => "Word", 32 => "Dword", 64 => "Lword", _ => throw new NotSupportedException() };
                var widthProperty = addressType.GetProperty("Width", Flags)!;
                widthProperty.SetValue(address, Enum.Parse(widthProperty.PropertyType, width));
                addressType.GetProperty("Count", Flags)!.SetValue(address, 1u);
                addressType.GetProperty("Operand", Flags)!.SetValue(address, indirect.Invoke(encoder, [true, true, scope, pointer, scalar.BitOffset]));
                if (Convert.ToInt32(Call(address, "Write", blob)) != 0) throw new NotSupportedException("Native address serializer refused metadata.");
            }
        }
        var trigger = Blob();
        Call(trigger, "WriteUInt8", (byte)16); Call(trigger, "WriteUInt8", (byte)6); Call(trigger, "WriteUInt8", (byte)0);
        Call(trigger, "WriteUInt16", (ushort)1); Call(trigger, "WriteUInt32", uid);
        Call(trigger, "WriteUInt8", (byte)49); Call(trigger, "WriteUInt8", (byte)6); Call(trigger, "WriteUInt8", (byte)3);
        var codeType = plus.GetType("Siemens.Simatic.PlcLanguages.TisPlusServer.CodeAddress", true)!;
        var code = Activator.CreateInstance(codeType)!; var blockProperty = codeType.GetProperty("Block", Flags)!;
        blockProperty.SetValue(code, Enum.Parse(blockProperty.PropertyType, "Fb"));
        var number = codeType.GetProperty("Number", Flags)!; number.SetValue(code, Convert.ChangeType(block, number.PropertyType));
        if (Convert.ToInt32(Call(code, "WriteBlock", trigger)) != 0) throw new NotSupportedException("Native block serializer refused metadata.");
        Call(trigger, "WriteUInt8", (byte)55); Call(trigger, "WriteByteArray", signature);
        return new(new() { RequestBlob = Bytes(blob), TriggerBlob = Bytes(trigger), JobName = "Rung_ReadOnly_BeginEnd" }, resultBytes, fields.ToArray());
    }
}
