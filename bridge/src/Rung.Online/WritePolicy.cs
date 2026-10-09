// SPDX-License-Identifier: BUSL-1.1
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public static class WritePolicy
{
    static RpcException Invalid() => new(ErrorCodes.BadRequest, "Literal does not fit the PLC scalar type or capacity.");
    public static object ParseScalar(uint datatype, string literal, int? maxLength = null)
    {
        if (string.IsNullOrWhiteSpace(literal) || literal.Length > 4096) throw Invalid();
        var body = literal.Trim();
        var prefix = Regex.Match(body, @"^([A-Za-z]+)#");
        if (prefix.Success) {
            var type = prefix.Groups[1].Value.ToUpperInvariant();
            type = type switch { "B" => "BYTE", "W" => "WORD", "DW" => "DWORD", "LW" => "LWORD", "T" => "TIME", "LT" => "LTIME", _ => type };
            if (type != PlcValues.TypeName(datatype)) throw Invalid();
            body = body[prefix.Length..];
        }
        if (datatype is 1 or 40) return bool.TryParse(body, out var boolean) ? boolean : throw Invalid();
        if (datatype is 19 or 62) return String(body, maxLength, datatype == 19);
        if (datatype is 8 or 48) {
            if (!Regex.IsMatch(body, @"^[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$")) throw Invalid();
            if (!double.TryParse(body.Replace("_", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number)) throw Invalid();
            if (number == 0 && body.Split('e', 'E')[0].Any(c => c is >= '1' and <= '9')) throw Invalid();
            if (datatype == 48) return number;
            var single = (float)number;
            if (!float.IsFinite(single) || number != 0 && single == 0) throw Invalid();
            return single;
        }
        Type? clr = datatype switch { 2 or 52 => typeof(byte), 55 => typeof(sbyte), 4 or 53 => typeof(ushort), 5 => typeof(short), 6 or 54 => typeof(uint), 7 or 11 => typeof(int), 49 or 51 => typeof(ulong), 50 or 64 => typeof(long), _ => null };
        if (clr == null) throw new RpcException(ErrorCodes.UnsupportedObject, "This scalar datatype cannot be modified yet.");
        var integer = datatype is 11 or 64 ? (prefix.Success ? Duration(body, datatype == 11) : throw Invalid()) : Integer(body);
        try { return Convert.ChangeType(integer.ToString(CultureInfo.InvariantCulture), clr, CultureInfo.InvariantCulture); }
        catch (Exception ex) when (ex is FormatException or OverflowException) { throw Invalid(); }
    }

    static BigInteger Integer(string body)
    {
        var negative = body.StartsWith('-');
        if (body.StartsWith('-') || body.StartsWith('+')) body = body[1..];
        var radix = 10;
        var at = body.IndexOf('#');
        if (at >= 0) { if (!int.TryParse(body[..at], out radix) || radix is not (2 or 8 or 16)) throw Invalid(); body = body[(at+1)..]; }
        if (body.Length == 0 || body.StartsWith('_') || body.EndsWith('_') || body.Contains("__")) throw Invalid();
        BigInteger value = 0;
        foreach (var c in body.ToUpperInvariant()) {
            if (c == '_') continue;
            var digit = c is >= '0' and <= '9' ? c - '0' : c is >= 'A' and <= 'F' ? c - 'A' + 10 : -1;
            if (digit < 0 || digit >= radix) throw Invalid();
            value = value * radix + digit;
        }
        return negative ? -value : value;
    }

    static string String(string body, int? capacity, bool latin1)
    {
        if (capacity == null || capacity < 0 || body.Length < 2 || body[0] != '\'' || body[^1] != '\'') throw Invalid();
        var value = new StringBuilder();
        for (var i = 1; i < body.Length - 1; i++) {
            var c = body[i];
            if (c == '\'') { if (i + 1 >= body.Length - 1 || body[++i] != '\'') throw Invalid(); }
            else if (c == '$') {
                if (++i >= body.Length - 1) throw Invalid();
                c = body[i];
                var digits = latin1 ? 2 : 4;
                if (i + digits <= body.Length - 1 && body.AsSpan(i, digits).ToArray().All(char.IsAsciiHexDigit)) { c = (char)Convert.ToInt32(body.Substring(i, digits), 16); i += digits - 1; }
                else c = char.ToUpperInvariant(c) switch { '$' => '$', '\'' => '\'', 'N' or 'L' => '\n', 'R' => '\r', 'T' => '\t', 'P' => '\f', _ => throw Invalid() };
            }
            if (latin1 && c > 255) throw Invalid();
            value.Append(c);
        }
        if (value.Length > capacity) throw Invalid();
        if (!latin1) {
            try { new UnicodeEncoding(false, false, true).GetByteCount(value.ToString()); }
            catch (EncoderFallbackException) { throw Invalid(); }
        }
        return value.ToString();
    }

    static BigInteger Duration(string body, bool milliseconds)
    {
        var negative = body.StartsWith('-'); if (negative) body = body[1..];
        var units = new Dictionary<string, long> { ["d"] = 86_400_000_000_000, ["h"] = 3_600_000_000_000, ["m"] = 60_000_000_000, ["s"] = 1_000_000_000, ["ms"] = 1_000_000, ["us"] = 1_000, ["ns"] = 1 };
        var position = 0; var previous = long.MaxValue; BigInteger nanos = 0;
        foreach (Match part in Regex.Matches(body, @"(\d(?:_?\d)*)(ms|us|ns|d|h|m|s)", RegexOptions.IgnoreCase)) {
            var unit = units[part.Groups[2].Value.ToLowerInvariant()];
            if (part.Index != position || unit >= previous) throw Invalid();
            nanos += BigInteger.Parse(part.Groups[1].Value.Replace("_", ""), CultureInfo.InvariantCulture) * unit;
            position += part.Length; previous = unit;
        }
        if (position == 0 || position != body.Length || milliseconds && nanos % 1_000_000 != 0) throw Invalid();
        if (milliseconds) nanos /= 1_000_000;
        return negative ? -nanos : nanos;
    }
}
