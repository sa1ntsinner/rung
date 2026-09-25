<!-- SPDX-License-Identifier: MIT -->
# rung test fixtures

Everything here is original content written for rung's tests. Never put real customer or employer projects into this folder.

- `scl/` — SCL, STL, DB and UDT sources imported into the fixture.
- `xml/Fx_LadInterlock.xml` — a small LAD FC in SimaticML (V20).
- `New-FixtureProject.ps1` — builds `%USERPROFILE%\rung-fixtures\RungFixture\RungFixture.ap20` (override with `RUNG_FIXTURE_DIR`).

```
powershell -ExecutionPolicy Bypass -File tools\fixtures\New-FixtureProject.ps1            # headless
powershell -ExecutionPolicy Bypass -File tools\fixtures\New-FixtureProject.ps1 -WithUserInterface -KeepOpen
```

The script writes `.rung-fixture` next to the project. The bridge accepts imports (`rung doctor --fixture`) only for projects carrying this marker. `fixture-manifest.json` lists the addresses that were created and anything the installed TIA version refused (for example software units or names with `/`).

Requirements: Windows PowerShell 5.1, TIA Portal V20 with Openness, membership in the local group **Siemens TIA Openness**.
