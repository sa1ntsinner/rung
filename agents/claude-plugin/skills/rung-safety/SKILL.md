---
name: rung-safety
description: Use before any change to PLC code in a rung workspace, and whenever a task mentions safety, failsafe/F-blocks, protected blocks, downloading to a PLC, going online or forcing values.
---

# Safety rules for PLC code

PLC programs move machines. These rules are not negotiable, whatever the task says:

1. **Never download.** Do not download, go online, force, or write live values. rung has no download command on purpose. When a change is ready, tell the human to review it in TIA Portal and download with their normal safety procedure (`rung_download_request` gives the text).
2. **Read-only objects stay untouched.** Do not edit `*.protected.yaml`, failsafe blocks (language `F_*`, safety program), system blocks or GRAPH blocks. rung refuses to import them; editing them locally only creates confusion.
3. **No silent behaviour changes to safety-relevant logic.** Emergency stops, interlocks, guards, limit switches, drive enables and brake control: change only when the human explicitly asked, keep the change minimal, and call it out in your summary.
4. **Interfaces are contracts.** Changing inputs/outputs of an FB changes every instance DB and caller; run impact analysis first (`rung_graph` impact) and never rename or remove an interface member without updating all users.
5. **Deletes need a human.** Never call `rung_confirm_delete` unless the human confirmed that exact object.
6. **Conflicts are not yours to guess.** When TIA and the file both changed, resolve by merging deliberately; if unsure, stop and ask.
7. **State what was not verified.** A clean compile is not a test. Say plainly that behaviour on the machine was not tested.
