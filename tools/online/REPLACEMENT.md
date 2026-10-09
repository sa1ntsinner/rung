<!-- SPDX-License-Identifier: MIT -->
# Replacing the online driver

`bridge/S7CommPlusDriver.dll` is the LGPL-3.0-or-later library used by
`bridge/rung-online.exe`. It remains a separate replaceable DLL. The source under
`source/S7CommPlusDriver` is the exact modified library source for this release;
`MANIFEST.json` records source and binary SHA-256 values and `RUNG-CHANGES.md`
describes the changes from upstream `5c84e77`.

With the .NET 10 SDK, run:

```powershell
dotnet build source/S7CommPlusDriver/src/S7CommPlusDriver -c Release
```

Stop rung's live monitors and broker, keep the original DLL, and copy the resulting
`bin/Release/net10.0/S7CommPlusDriver.dll` beside `bridge/rung-online.exe`.
Keep assembly/API compatibility with the supplied library. Do not replace the
host executable. Restart the broker and run `rung live state --device <PLC>`
against an independently verified, pinned read target.

Permission is granted to replace and modify this LGPL library and to reverse
engineer the combined work for debugging those library modifications, regardless
of restrictions otherwise applying to rung components. This permission does not
change the license of the library or the other components.

The GNU LGPL v3 and incorporated GPL v3 terms are included under `LICENSES/`.
Dependency notices include Bouncy Castle, zlib.net and Microsoft .NET. This
package contains no Siemens libraries. TIA engineering still uses the user's
installed Openness libraries; the online host runs independently of TIA.
