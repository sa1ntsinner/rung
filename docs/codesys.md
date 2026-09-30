# CODESYS

rung works with CODESYS V3.5 projects the way it works with TIA Portal: the project stays the truth, rung mirrors it into text files, keeps both in sync, compiles, downloads and monitors. It talks to CODESYS through CODESYS's own scripting, in a CODESYS without window; nothing else is installed into CODESYS.

## Start

```
rung check                               # finds CODESYS and its profile
rung init --project D:\CODESYS\Line3.project
rung pull
rung watch                               # keeps both sides in sync; Ctrl+C to stop
```

CODESYS takes about 15 seconds to start. `rung watch` starts it once and keeps it; while it runs, every other rung command (compile, download, monitoring) goes through it and answers at once. A project that is open in the CODESYS window cannot be opened by rung at the same time; rung says so.

## What becomes text

| CODESYS | File |
|---|---|
| PROGRAM, FUNCTION_BLOCK, FUNCTION | `plc/<Device>/blocks/<folders>/<Name>.st`: declaration and code, then the POU's METHODs and ACTIONs, each with its END keyword |
| DUT (structure, enumeration, …) | `plc/<Device>/types/<folders>/<Name>.st` |
| GVL | `plc/<Device>/tags/<folders>/<Name>.st` |

Folders in the POU tree are folders on disk. A new `.st` file creates the POU in CODESYS (PROGRAM, FUNCTION_BLOCK or FUNCTION, from its first line); a METHOD added to the file becomes a method of the FB, one removed from the file is removed. A PROPERTY is written with its accessors, as CODESYS keeps them:

```
PROPERTY PUBLIC Speed : REAL
GET
VAR
END_VAR
Speed := _speed;
END_GET
SET
_speed := LIMIT(0.0, Speed, 100.0);
END_SET
END_PROPERTY
```

Without SET it is read-only. The language server knows properties as members of the FB, and `rung test` runs GET when a property is read and SET when it is written, in CODESYS files and in TwinCAT's `.TcPOU` alike. Visualizations, the task configuration, libraries and devices stay in CODESYS.

The language server, `rung test` (the offline simulator) and the editors read these files as IEC 61131-3 structured text: METHODs with `THIS^`, enumerations, `POINTER TO`, `REFERENCE TO`.

## Compile

`rung compile` (and every sync that sent a change) builds the application; CODESYS's messages land on their line in the file. CODESYS compiles only what a task calls, so a POU nobody uses is not checked until it is.

## Download

```
rung connect --use "CODESYS simulation" --mode simulation   # CODESYS's own simulation, no PLC needed
rung connect --use 192.168.1.10 --mode TCP                  # a PLC (or CODESYS Control Win: 127.0.0.1) through the gateway
rung download
```

A download is an online change: the running application changes without a stop. When an online change is not possible (a first download, a changed interface), a full download would stop the application, so rung does nothing and says to allow it by name, like TIA's "stop the CPU":

```
rung download --allow stop-cpu
```

Afterwards rung starts the application only if it ran before the download (a full download stopped it), if the download was the first, or in CODESYS's simulation. An application someone had stopped stays stopped, and so does one whose state rung could not read before the download; rung says so.

A person starts every download, as for TIA Portal ([downloads](downloads.md)): the bridge downloads only when `rung download` started it.

## Monitoring

`rung live watch --file plc/Device/blocks/FB_Count.st` (or the eye button in VS Code) shows the values of the block's lines twice a second: a PROGRAM or GVL by its own name, an FB through the PROGRAM variable that holds it (`PLC_PRG.fbCount`, found by itself when there is one, else `--instance`). In CODESYS's simulation the application runs inside the CODESYS that `rung watch` holds, so monitor while `rung watch` runs.
