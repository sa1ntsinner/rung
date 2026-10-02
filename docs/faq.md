# FAQ

**Is this allowed? Does it touch the project file?**
rung talks to TIA Portal only through **TIA Portal Openness**, Siemens' official automation API, the same way Siemens add-ins and many engineering tools do. It never reads or writes `.ap*` project files or other internal files, and it ships no Siemens binaries — it uses the Openness libraries installed with your TIA Portal. You need a licensed TIA Portal; rung does not replace it.

**Can it break my project?**
After `rung init` it writes nothing into the project until you run `rung writes on` in that workspace: until then rung only reads, and your edits stay in the files. That right is kept outside git and names the project, so a clone or a rebind to another project starts read-only again. `rung sync --preview` shows what the next sync would send, line by line, before it does. Before its first write of each day, rung has TIA Portal archive the whole project (a `.zap20` in `%LOCALAPPDATA%\rung\backups\<project>` on the PC with TIA Portal, the newest 10 kept; TIA Portal's *Project → Retrieve* opens one); if that archive cannot be made, nothing is written (`backup = "off"` or `backupDir` under `[sync]` in `rung.toml` change it; `rung backup` makes one any time). The archive is of the engineering project, not of the values in a running PLC. Imports run inside TIA Portal's exclusive access and a transaction; if the result is not exactly the object you edited, the transaction is rolled back. Tag and watch tables are replaced as a whole by an import, and TIA Portal does not always undo a failed one, so rung exports the table first and puts it back if the import fails half-way. Every write is guarded by the revision rung last saw, so a change made in TIA Portal meanwhile turns into a merge or a conflict instead of being overwritten. Local files are never overwritten without `--force`, and a recovery copy is kept. Still: use git for the workspace and back up the project like you always do.

**Does it download to the PLC?**
Only when a person says so. `rung download` (or the editor's Download… button) asks you to type the PLC name, never picks a PLC by itself, and cancels whenever TIA Portal asks something risky you did not allow by name, such as stopping the CPU ([downloads](downloads.md)). rung's MCP server, language server and agent instructions never download; the MCP server can only write a download request for a person. An agent that runs shell commands as you is trusted as you are: `download.enabled = false` in its workspace, or a Windows user outside the "Siemens TIA Openness" group, keeps a PLC out of its reach. Live data (`rung live`) is read-only; write methods of the Web API are blocked in code.

**What about safety programs?**
Failsafe (F-) blocks, know-how-protected blocks, system blocks, GRAPH blocks and instances of library types are read-only in rung. Their files are generated for reading and review only; a library type is changed in TIA Portal's library (Edit type).

**Which languages become text?**
SCL, STL and data blocks/UDTs as sources; LAD as SIMATIC SD text (`.s7dcl`); other graphical blocks as SimaticML XML; tag tables as text with one tag per line (`.tags.st`), watch tables as XML; the network settings (IP addresses, PROFINET device names) as YAML. Software units are folders of their own (`plc/<PLC>/units/<unit>/`). The rest of the hardware, HMI, technology objects, the project library and the units' relations appear as read-only YAML views.

**Does it work without TIA Portal?**
The language server, `rung test` and `rung views --offline` work on any OS with an existing workspace (for example in CI). On Linux and macOS, rung syncs with the TIA Portal of a Windows PC or VM over ssh ([Linux and macOS](remote.md)).

**Does it keep up with a large project?**
Measured on a generated project of 1,287 objects (600 FBs, 300 FCs, 300 DBs, 50 UDTs, 20 tag tables of 100 tags) with TIA Portal V20 on a laptop:
- the first `rung pull` takes about 2½ minutes;
- `rung sync` with nothing to do takes about 7 s; the very first one takes about 45 s, because it reads every block's fingerprint once;
- under `rung watch`, a saved FB is in TIA Portal, compiled, and back in its file with TIA's errors on their lines in about 3 s (the first one after TIA Portal starts takes longer, while TIA warms up). A saved file goes straight to TIA Portal without looking through the rest of the project; callers and instance DBs compile again only when the block's interface changed;
- the language server loads the workspace in about a second and answers an edit in milliseconds;
- 50 test files run in 2 s.

TIA Portal answers one request at a time, so `rung watch` waits between passes twice as long as a pass takes: it uses at most a third of TIA Portal's time while you work in it. Your own file edits are sent at once.

**Which TIA Portal versions?**
V20 today. A V21 build exists but is not verified yet.

**What does it cost?**
The editor extensions, grammar and workspace format are MIT. The rung core is source-available under the Business Source License 1.1: free for individuals, education, non-commercial open source and organizations with up to 3 users. Larger teams subscribe to rung Pro, €49 per user and month: the commercial license, plus change review that knows PLCs (interface per variable, attributes, logic per region and LAD/FBD network, what the change affects), a policy gate in your own CI, FAT/SAT change records and support (smile0murr@gmail.com). Every version becomes Apache-2.0 three years after its release.

**Is rung affiliated with Siemens?**
No. SIMATIC, TIA Portal and related names are trademarks of Siemens AG, used here only to describe compatibility.
