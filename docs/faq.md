# FAQ

**Is this allowed? Does it touch the project file?**
rung talks to TIA Portal only through **TIA Portal Openness**, Siemens' official automation API, the same way Siemens add-ins and many engineering tools do. It never reads or writes `.ap*` project files or other internal files, and it ships no Siemens binaries — it uses the Openness libraries installed with your TIA Portal. You need a licensed TIA Portal; rung does not replace it.

**Can it break my project?**
Imports run inside TIA Portal's exclusive access and a transaction; if the result is not exactly the object you edited, the transaction is rolled back. Every write is guarded by the revision rung last saw, so a change made in TIA Portal meanwhile turns into a merge or a conflict instead of being overwritten. Local files are never overwritten without `--force`, and a recovery copy is kept. Still: use git for the workspace and back up the project like you always do.

**Does it download to the PLC?**
No. rung has no download command and the AI tools refuse to do it. Downloads stay a human step in TIA Portal. Live data (`rung live`) is read-only; write methods of the Web API are blocked in code.

**What about safety programs?**
Failsafe (F-) blocks, know-how-protected blocks, system blocks and GRAPH blocks are read-only in rung. Their files are generated for reading and review only.

**Which languages become text?**
SCL, STL and data blocks/UDTs as sources; LAD as SIMATIC SD text (`.s7dcl`); other graphical blocks as SimaticML XML; tag tables as XML. Hardware, HMI and technology objects appear as read-only YAML views.

**Does it work without TIA Portal?**
The language server, `rung test` and `rung views --offline` work on any OS with an existing workspace (for example in CI). Syncing needs Windows with TIA Portal running.

**Which TIA Portal versions?**
V20 today. A V21 build exists but is not verified yet.

**What does it cost?**
The editor extensions, grammar and workspace format are MIT. The rung core is source-available under the Business Source License 1.1: free for individuals, education, non-commercial open source and organizations with up to 3 users; larger teams subscribe. Every version becomes Apache-2.0 three years after its release.

**Is rung affiliated with Siemens?**
No. SIMATIC, TIA Portal and related names are trademarks of Siemens AG, used here only to describe compatibility.
