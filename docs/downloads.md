# Going online and downloading

rung talks to the PLC through TIA Portal Openness, the same way TIA Portal does: `rung online`, `rung compile`, `rung download`. A download changes a running machine, so the rules are strict.

## What runs on the PLC

`rung compare` is TIA's online/offline comparison: it goes online, compares the project with the PLC, goes offline and lists what differs, what exists only in the project and what only on the PLC, with the workspace file of each. It changes nothing on the PLC; the MCP tool `rung_compare` does the same for agents. The exit code is 0 when the PLC runs the project and 2 when it does not, so a script can check it.

## Who downloads

A person does. `rung download` runs from a terminal, the VS Code button (with a confirmation) or a Zed task, and asks you to type the PLC name unless you pass `--yes`. The MCP server never downloads; `rung_download_request` only writes a request for a person to run. The language server never downloads either.

## TIA's questions

Before and after a download, TIA asks questions: stop the CPU, reinitialise data blocks, overwrite system data, reset memory, abort an active test or force job, accept a changed protection level. rung answers every one with "don't", which makes TIA cancel. The result lists each question and the `--allow` name that would accept it:

```
rung download                         # cancels and tells you what TIA asked
rung download --allow stop-cpu        # accept stopping the CPU for this download
```

Answers can also live in `rung.toml` under `[download] allow = [...]`. A question rung does not know cancels the download. After a download rung starts the CPU again only if this download stopped it and `start_after` is true (the default).

A password-protected CPU gets its password from `RUNG_PLC_PASSWORD`; passwords never go into files.

## Where to connect

`rung connect` finds the PLC like TIA's "Go online": it scans the PG/PC interfaces for the IP address configured in the project and saves what it found under `[plc.<device>]` in `rung.toml`. `rung online` and `rung compare` do the same by themselves when nothing is saved, because they only read. `rung download` never does: factory addresses such as 192.168.0.1 repeat on every network, so the machine that answers at the project's address can be another one. It downloads only over a connection a person saved or chose. `rung connect --pick` chooses again, `rung interfaces --scan` shows everything TIA can reach.

While `rung watch` runs, these commands go through its bridge, so a download never races a sync.

## Uploading from a PLC

TIA Portal's *Upload device as new station* reads a running PLC, its hardware and its program, into a project. The PLC is only read.

```
rung init --from-plc 192.168.0.1 --project D:\Projects\Line3\Line3.ap20   # a new project from the PLC, then bound to this folder
rung upload --ip 192.168.0.1                                               # the PLC as a new station of the bound project
rung pull                                                                  # its program as files
```

With more than one network adapter, name the one to use with `--use` (as `rung interfaces` lists them). A PLC that protects reading asks for its password: set `RUNG_PLC_PASSWORD`. S7-PLCSIM cannot be uploaded this way; TIA Portal refuses it.
