<!-- SPDX-License-Identifier: BUSL-1.1 -->

These watch tables were exported through rung's existing engineering bridge from local TIA Portal V19, V20 and V21 on 2026-10-07. V20 used the disposable RungProve project; V19 and V21 used RungFixture19 and RungFixture21.

The empty Fx_Watch table was exported, populated by fixture-only XML import, re-exported with TIA-generated defaults, then restored from its original export. Restoration was checked by exact XML comparison. The projects were not saved and no PLC download or modification occurred.

The exports verify absolute Address rows, symbolic Name rows, duplicate entries, multilingual Comment compositions, DisplayFormat and draft ModifyValue. Absolute PLC accessor mapping is not verified by these files.
