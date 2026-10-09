// SPDX-License-Identifier: BUSL-1.1
using S7CommPlusDriver;

namespace Rung.Online;

public static class AbsoluteAddress
{
    // Only catalogue-backed unsigned scalar aliases: signed/REAL reinterpretation is not inferred.
    public static string? FromMetadata(VarInfo variable)
    {
        if (variable.ArrayElementCount != 0) return null;
        var area = variable.AccessSequence?.Split('.')[0] switch { "50" => "I", "51" => "Q", "52" => "M", _ => null };
        if (area == null) return null;
        var suffix = variable.Softdatatype switch {
            Softdatatype.S7COMMP_SOFTDATATYPE_BOOL when variable.NonOptBitoffset is >= 0 and <= 7 => $"{variable.NonOptAddress}.{variable.NonOptBitoffset}",
            Softdatatype.S7COMMP_SOFTDATATYPE_BYTE => $"B{variable.NonOptAddress}",
            Softdatatype.S7COMMP_SOFTDATATYPE_WORD => $"W{variable.NonOptAddress}",
            Softdatatype.S7COMMP_SOFTDATATYPE_DWORD => $"D{variable.NonOptAddress}",
            _ => null,
        };
        return suffix == null ? null : $"%{area}{suffix}";
    }
}
