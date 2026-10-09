// SPDX-License-Identifier: BUSL-1.1
using System.Collections;
using System.Globalization;
using System.Numerics;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;

namespace Rung.Online;

public static class PlcValues
{
    static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    static readonly Dictionary<uint, string> Types = typeof(Softdatatype).GetFields()
        .Where(f => f.IsLiteral && f.FieldType == typeof(uint))
        .ToDictionary(f => (uint)f.GetRawConstantValue()!, f => f.Name.Replace("S7COMMP_SOFTDATATYPE_", ""));
    public static string TypeName(uint datatype) => datatype == 40 ? "BOOL" : Types.GetValueOrDefault(datatype, $"TYPE_{datatype}");

    public static OnlineReadItem Read(PlcTag tag)
    {
        object? raw = tag is PlcTagS5Time s5 ? s5.TimeValue * (int)Math.Pow(10, s5.TimeBase + 1)
            : tag.AggregateValue ?? tag.GetType().GetProperty("Value")?.GetValue(tag);
        if (raw == null) throw new RpcException(ErrorCodes.UnsupportedObject, "Unsupported PLC datatype.");
        var type = TypeName(tag.Datatype);
        var (value, display) = ConvertValue(raw, tag.Datatype, tag is PlcTagDTL dtl ? dtl.ValueNanosecond : null,
            tag is PlcTagDTLArray dates ? dates.ValueNanosecond : null);
        return new(tag.Name, value, raw is Array ? "ARRAY OF " + type : type, display);
    }

    static (object Value, string Display) ConvertValue(object raw, uint datatype, uint? nanoseconds = null, uint[]? arrayNanoseconds = null)
    {
        if (raw is Array array) {
            var items = array.Cast<object>().Select((v, i) => ConvertValue(v, datatype,
                arrayNanoseconds != null && i < arrayNanoseconds.Length ? arrayNanoseconds[i] : null)).ToArray();
            return (items.Select(v => v.Value).ToArray(), "[" + string.Join(", ", items.Select(v => v.Display)) + "]");
        }
        string? literal = datatype switch {
            9 when raw is DateTime date => "D#" + date.ToString("yyyy-MM-dd", Invariant),
            10 => "TOD#" + Clock(new BigInteger(System.Convert.ToUInt64(raw, Invariant)) * 1_000_000),
            11 => Duration(new BigInteger(System.Convert.ToInt64(raw, Invariant)) * 1_000_000, "T#"),
            12 => Duration(new BigInteger(System.Convert.ToInt64(raw, Invariant)) * 1_000_000, "S5T#"),
            14 when raw is DateTime dt => "DT#" + dt.ToString("yyyy-MM-dd-HH:mm:ss.fff", Invariant),
            64 => Duration(new BigInteger(System.Convert.ToInt64(raw, Invariant)), "LT#"),
            65 => "LTOD#" + Clock(new BigInteger(System.Convert.ToUInt64(raw, Invariant))),
            66 => LongDateTime(System.Convert.ToUInt64(raw, Invariant)),
            67 when raw is DateTime dt => "DTL#" + dt.ToString("yyyy-MM-dd-HH:mm:ss", Invariant) + "." + (nanoseconds ?? (uint)(dt.Ticks % TimeSpan.TicksPerSecond * 100)).ToString("D9", Invariant),
            _ => null,
        };
        if (literal != null) return (literal, literal);
        if (raw is bool boolean) return (boolean, boolean ? "TRUE" : "FALSE");
        if (raw is char character) raw = character.ToString();
        if (raw is string text) return (text, "'" + text.Replace("$", "$$").Replace("'", "$'").Replace("\r", "$R").Replace("\n", "$N").Replace("\t", "$T") + "'");
        if (raw is float f && !float.IsFinite(f) || raw is double d && !double.IsFinite(d))
            throw new RpcException(ErrorCodes.UnsupportedObject, "Non-finite PLC real cannot be represented as a JSON number.");
        if (raw is not (byte or sbyte or short or ushort or int or uint or long or ulong or float or double))
            throw new RpcException(ErrorCodes.UnsupportedObject, "Unsupported PLC datatype.");
        var display = raw is float or double ? ((IFormattable)raw).ToString("G6", Invariant) : ((IFormattable)raw).ToString(null, Invariant);
        if (raw is float or double && !display.Contains('.') && !display.Contains('E')) display += ".0";
        if (datatype is 2 or 4 or 6 or 51) display = "16#" + System.Convert.ToUInt64(raw, Invariant).ToString(datatype switch { 2 => "X2", 4 => "X4", 6 => "X8", _ => "X16" }, Invariant);
        const long safe = 9_007_199_254_740_991;
        object value = raw is long l && (l < -safe || l > safe) || raw is ulong u && u > (ulong)safe
            ? ((IFormattable)raw).ToString(null, Invariant) : raw;
        return (value, display);
    }

    static string Duration(BigInteger nanos, string prefix)
    {
        var sign = nanos.Sign < 0 ? "-" : "";
        nanos = BigInteger.Abs(nanos);
        var parts = new List<string>();
        foreach (var (size, unit) in new (long, string)[] { (86_400_000_000_000, "d"), (3_600_000_000_000, "h"), (60_000_000_000, "m"), (1_000_000_000, "s"), (1_000_000, "ms"), (1_000, "us"), (1, "ns") }) {
            var amount = BigInteger.DivRem(nanos, size, out nanos);
            if (amount != 0) parts.Add(amount.ToString(Invariant) + unit);
        }
        return prefix + sign + (parts.Count == 0 ? "0ms" : string.Concat(parts));
    }
    static string Clock(BigInteger nanos) {
        var seconds = BigInteger.DivRem(nanos, 1_000_000_000, out var fraction);
        return $"{seconds / 3600:00}:{seconds / 60 % 60:00}:{seconds % 60:00}." + fraction.ToString("D9", Invariant).TrimEnd('0').PadRight(3, '0');
    }
    static string LongDateTime(ulong nanos) {
        var date = DateTime.UnixEpoch.AddSeconds(nanos / 1_000_000_000);
        return "LDT#" + date.ToString("yyyy-MM-dd-HH:mm:ss", Invariant) + "." + (nanos % 1_000_000_000).ToString("D9", Invariant);
    }
}
