# Native CSV fixture provenance

`tia-v20-long-term.csv` contains exact bytes written by the installed TIA V20
`CsvSampleWriter`, using controlled synthetic Single, Boolean and Int32 inputs.
It is an offline native-writer fixture, **not a CPU recording or UI export**.
The installed `CsvSampleReader` independently read all four sample numbers and
timestamps, including `1700000000100000123` nanoseconds since 1970.

- CSV SHA256: `47A31EEBBDC9B1C61BAD42E21C8117F9AB69544F7DB6A0C40FA2DB02DC61F3B1`
- Assembly: `Siemens.TechTrace.Editor.UserInterface.dll`, version `2000.0.9501.1`
- Assembly SHA256: `A75AA896CC7224AB1F680F5D60C05D87E54F6156CB23D8647A68147749E41A32`

First line: trace name, activation `yyyyMMdd_HHmmss_fff`, signal labels separated
by semicolons. Native name escaping retains `$003B` for a semicolon. Sample rows:
UInt64 sample number, LDT timestamp with nine fractional digits, scalar values.
Boolean values are `0`/`1`, indistinguishable from numeric values without external
signal types. The file supplies neither types nor engineering units.

The third sample was generated with invalid ValueUnion flags. The native reader
interprets its hex text differently according to the supplied type: its Single
decoder reports valid raw bits, while Boolean/Int32 report invalid values.
Therefore rung preserves these tokens and displays gaps requiring type metadata;
it never guesses the bit interpretation or treats every `16#` token as invalid.

No Siemens assembly is redistributed. No TIA project or PLC was accessed by the
generator/reader. Other CSV profiles, localized numeric variants and unsupported
date/scalar formats are explicitly refused.
