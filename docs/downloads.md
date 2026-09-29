# Going online and downloading

rung talks to the PLC through TIA Portal Openness, the same way TIA Portal does: `rung online`, `rung compile`, `rung download`. A download changes a running machine, so the rules are strict.

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

The first `rung online` or `rung download` finds the PLC like TIA's "Go online": it scans the PG/PC interfaces for the IP address configured in the project and saves what it found under `[plc.<device>]` in `rung.toml`. `rung connect --pick` chooses again, `rung interfaces --scan` shows everything TIA can reach.

While `rung watch` runs, these commands go through its bridge, so a download never races a sync.
