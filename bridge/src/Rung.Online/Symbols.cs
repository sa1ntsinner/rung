// SPDX-License-Identifier: BUSL-1.1
using System.Text;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public static class Symbols
{
    public static OnlineSymbol ForWrite(string name, OnlineSymbol[] catalog)
    {
        var symbol = Resolve(name, catalog);
        if (symbol == null) {
            var canonical = Normalize(name);
            var unindexed = Regex.Replace(canonical, @"\[-?\d+(,-?\d+)*\]", "");
            symbol = catalog.Where(v => v.Name == unindexed || canonical.StartsWith(v.Name + "[", StringComparison.Ordinal))
                .OrderByDescending(v => v.Name.Length).FirstOrDefault();
        }
        if (symbol == null || !symbol.Readable || !symbol.Writable) throw new RpcException(ErrorCodes.AccessDenied, "No verified HMI write permission for this scalar.");
        return symbol;
    }

    public static string Normalize(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 1024) throw new RpcException(ErrorCodes.BadRequest, "Invalid symbol name.");
        var result = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < name.Length; i++) {
            var c = name[i];
            if (c == '"') {
                if (quoted && i + 1 < name.Length && name[i + 1] == '"') { result.Append('"'); i++; }
                else quoted = !quoted;
            } else if (quoted || !char.IsWhiteSpace(c)) result.Append(c);
        }
        if (quoted || result.Length == 0 || name.Any(char.IsControl)) throw new RpcException(ErrorCodes.BadRequest, "Malformed quoted symbol name.");
        return result.ToString();
    }

    public static OnlineSymbol? Resolve(string name, OnlineSymbol[] catalog)
    {
        var canonical = Normalize(name);
        if (canonical.StartsWith('%')) {
            var aliases = catalog.Where(v => string.Equals(v.AbsoluteAddress, canonical, StringComparison.OrdinalIgnoreCase)).Take(2).ToArray();
            if (aliases.Length > 1) throw new RpcException(ErrorCodes.SymbolAmbiguous, $"{canonical.ToUpperInvariant()} is the address of several PLC tags; read one of them by name.");
            if (aliases.Length == 1) return aliases[0];
            // ponytail: I, Q and M are read through the PLC tag at that address; raw area access needs the protocol's area encoding
            if (canonical.StartsWith("%DB", StringComparison.OrdinalIgnoreCase))
                throw new RpcException(ErrorCodes.UnsupportedObject, $"{canonical.ToUpperInvariant()} is an offset in a DB: read the member by its name (\"Line_DB\".Speed).");
            throw new RpcException(ErrorCodes.UnsupportedObject, $"No PLC tag is at {canonical.ToUpperInvariant()}: rung reads inputs, outputs and memory through their tags. Give the address a tag in a tag table (same address and width), download, and read it.");
        }
        var matches = catalog.Where(v => v.Name == canonical).Take(2).ToArray();
        if (matches.Length > 1) throw new RpcException(ErrorCodes.SymbolAmbiguous, "PLC symbol is ambiguous.");
        if (matches.Length == 1) return matches[0];
        // The driver resolves indexed members from PLC array metadata, never from guessed offsets.
        if (Regex.IsMatch(canonical, @"\[-?\d+(,-?\d+)*\]")) return null;
        throw new RpcException(ErrorCodes.SymbolNotFound, "Symbol not found in PLC.");
    }
}
