# Quickstart

rung turns a Siemens TIA Portal project into a folder of text files that stays in sync with TIA Portal, so you can work on it in VS Code, Zed or Neovim, keep it in git, and let AI agents help.

## 1. Install and check

- Windows with **TIA Portal V20** and the Openness option (installed with TIA Portal), Node.js 22 or newer.
- Unzip `rung-<version>-win-x64.zip` and add the folder to `PATH`.
- Run `rung check`. It lists what is installed (TIA Portal, Openness, PLCSIM, TwinCAT, CODESYS, editors, agents) and says how to get what is missing:

```
PLC platforms
  ✓ TIA Portal (STEP 7)  V20
  ✓ TIA Portal Openness  V17, V18, V19, V20
  · Windows group "Siemens TIA Openness"
      → as administrator: net localgroup "Siemens TIA Openness" %USERNAME% /add, then sign out and in
  · rung bridge in the Openness whitelist
      → rung setup openness
```

`rung setup openness` registers rung's bridge with TIA Portal once, so TIA does not ask "allow Openness access?" on every start. That dialog cannot be answered when TIA Portal runs without a window.

## 2. Editors and agents

```
rung setup --dry-run    # shows what it would change
rung setup              # asks, then installs
```

It installs the VS Code extension, adds rung's MCP server to the agents it finds (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, GitHub Copilot) and copies the PLC engineering skills for them. For Zed and Neovim it prints the two steps to do by hand ([editors](editors/README.md)). `--agents`, `--editors`, `--skills` and `--scope project|global` narrow it down; `-y` skips the questions.

## 3. Mirror a project

In an empty folder:

```
rung init --project D:\TIA\Line3.ap20   # binds this folder to the project
rung pull                               # blocks, UDTs, tag tables → plc/<PLC>/...
git init && git add -A && git commit -m "baseline"
```

If the project is not open, rung opens it in a TIA Portal without window (`[tia] start = "headless"` in `rung.toml`; `"never"` turns that off). Without `--project`, `rung init` binds the project that is open. A CODESYS project (`.project`) works the same way, through a CODESYS without window: see [CODESYS](codesys.md).

## 4. Work two-way

```
rung watch         # keeps both sides in sync; Ctrl+C to stop
```

- Save `plc/PLC_1/blocks/.../Fx_Motor.scl` → rung imports it into TIA Portal, compiles it and writes TIA's formatting back. Compile errors appear on their line in the editor.
- Change a block in TIA Portal → the file updates.
- Both changed → edits on different lines merge. Edits on the same line give `Fx_Motor.scl.conflict`; finish with `rung resolve <file> --ours|--theirs|--merged`.
- A new `.scl`, `.db` or `.udt` file creates the object in TIA Portal. Deleting a file deletes nothing until you run `rung confirm-delete <file>`.
- `rung rename <file> <new-name>` renames in TIA Portal like TIA's rename: the header and every file that uses it follow.
- Tag tables (`.tags.xml`) and watch tables (`plc/<PLC>/watch/*.xml`) are SimaticML and go both ways too; force tables, know-how protected, fail-safe, system and GRAPH blocks and instances of library types are mirrored read-only.

`rung sync` does one pass instead of watching; `rung status` shows what is open.

## 5. Test without a PLC

- `rung test` runs YAML unit tests for SCL and LAD blocks on rung's offline simulator and writes JUnit for CI ([testing](testing.md)).
- `rung simulate` runs the program cyclically as a virtual S7-1500 that answers the Web API, so `rung live read '"DB".x'` and the agent tools can watch values change. TIA Portal cannot go online to it; for that, use S7-PLCSIM.

## 6. Online, compare, download

```
rung connect                # finds the PLC (or PLCSIM) and saves the connection in rung.toml
rung online --state         # offline / online / not reachable
rung compare                # the project against the PLC, read-only; exit 2 if they differ
rung download               # you type the PLC name to confirm; TIA's risky questions need --allow
```

`rung download` never picks a PLC by itself: run `rung connect` once (or `rung connect --pick` to choose among what answers). Agents never download. Everything about TIA's questions (stop the CPU, reinitialise data blocks, …) is in [downloads](downloads.md).

## More

- `rung assignments`: TIA Portal's assignment list, every input, output and bit memory address in use with its tag and where the code uses it, and overlapping accesses (exit 2 when two cross).
- `rung views`: read-only YAML views of hardware, HMI, technology objects and the project library.
- `rung live watch --file <block>`: TIA Portal's monitoring for one block, the values of every line twice a second (VS Code shows them in the editor: the eye button). `rung live read`, `rung live diag`: single values and the diagnostic buffer. All over the S7-1500 Web API, read-only.
- `rung agents`: refreshes the project summary in `AGENTS.md`.
- `rung --help` lists every command and option.
