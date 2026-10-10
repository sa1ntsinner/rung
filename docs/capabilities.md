# Engineering capabilities and limits

Rung supports PLC source editing, review and testing in an editor. Some engineering tasks still require TIA Portal. TIA operations require a licensed Windows installation with Openness; offline editing and tests do not.

| Workflow | What Rung provides | Limit / next tool |
|---|---|---|
| PLC program | Mirrored blocks, tags and types; edit, sync, compile and references | Protected/system objects can be read-only; export refusals remain visible |
| Offline tests | Supported SCL, LAD, FBD and STL instructions; explicit cycles, debug and coverage | No hardware validation or interrupt/startup scheduling; see [testing](testing.md) |
| Online values | Read-only values and watch through configured S7CommPlus or Web API | Observations do not establish PLC cycle coherence; see [online](online.md) |
| Trace | S7CommPlus recording and supported CSV import, offline inspection | Web API recording unavailable; asynchronous samples can contain gaps; see [trace](trace.md) |
| Hardware | Inventory, snapshots and supported edits | Scope depends on available Openness services; see [hardware](hardware.md) |
| HMI | Read-only device inventory from `rung views` | Screens, HMI tags, alarms, recipes and runtime configuration require TIA/WinCC; no HMI editor in Rung |
| Technology objects | Supported profiles and explicit refusal outside them | General motion commissioning requires TIA Portal |
| Libraries | Inventory and supported type/version operations | Availability depends on TIA version and object; native refusals are not bypassed; see [libraries](libraries.md) |
| Safety | Available safety observations and native compile diagnostics | Rung does not grant safety permissions or replace safety validation/commissioning |
| Download | Explicit human confirmation through TIA | Offline test success is not permission or evidence to commission a machine; see [downloads](downloads.md) |

Rung can be used for the supported PLC workflow today. A complete replacement of every TIA/WinCC engineering workflow would require the missing capabilities above, especially HMI authoring.
