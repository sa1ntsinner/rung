# Going online

TIA Portal V19, V20 or V21 with Openness must be installed on the Windows PC that runs the bridge. It can be your PC or [another PC over ssh](remote.md). rung reuses the TIA Portal that has the project open, or starts one without window.

## Find the PLC

Run these commands in the folder with `rung.toml`:

```sh
rung connect                 # find the PLC and save the connection in rung.toml
rung connect --pick          # choose among the connections that answer
rung connect --json          # list choices and addresses as JSON; saves nothing
rung online                  # go online with the saved connection
rung online --state          # show the online state
rung online --off            # go offline
```

With several PLCs, add `--plc PLC_1`. `rung connect` looks through TIA Portal's PG/PC interfaces for the project's addresses and S7-PLCSIM. One matching connection is chosen automatically; otherwise it asks. A scan can take up to half a minute. The connection is saved as `[plc.<name>]` in `rung.toml`.

`--json` lists the saved connection, project addresses, candidates and other reachable devices. An `addressChange` on a choice says which project interface has a different address. `rung interfaces` lists the PG/PC interfaces TIA Portal offers if you need to choose manually.

In VS Code, **Go online** finds a connection when needed. **Connect…** lets you choose again. If nothing answers, the dialog offers **Retry**, **Choose manually** and **Show details**. With several PLCs, the PLC picker remembers the last PLC chosen in the workspace and lists it first.

## A PLC at another address

Check the device name and address before choosing it. A device at a familiar address can be another machine.

For V19/V20, TIA Portal goes online only at the address in the project:

```sh
rung connect --plc PLC_1 --address 192.168.1.1
rung writes on
rung sync
rung online --plc PLC_1
```

`connect --address` edits `plc/PLC_1/hardware/network.yaml`. Pull first if that file is not mirrored yet. Sync takes the edit into TIA Portal with writes on; it does not change the running PLC's address. In VS Code, **Use … in the Project** makes the same edit.

For V21, use an online address without changing the project:

```sh
rung connect --plc PLC_1 --pick                  # choose a PG/PC interface first
rung connect --plc PLC_1 --address 192.168.1.1   # save the online address in rung.toml
rung online --plc PLC_1
```

V21 uses that address when going online. `network.yaml` and the TIA Portal project stay unchanged. VS Code offers **Go Online at …**. To edit the project address on V21 instead, use `rung connect --address <ip> --project-address`, or **Use … in the Project**, then sync with writes on.

## Passwords

The CLI takes the PLC's password from `RUNG_PLC_PASSWORD`. For a PLC with user management, set `RUNG_PLC_USER` too. In PowerShell:

```powershell
$env:RUNG_PLC_PASSWORD = '<PLC password>'
$env:RUNG_PLC_USER = '<PLC user>' # only for user management
rung online --plc PLC_1
Remove-Item Env:RUNG_PLC_PASSWORD
Remove-Item Env:RUNG_PLC_USER -ErrorAction SilentlyContinue
```

`rung compare` uses these credentials too. rung does not write them into workspace files. `RUNG_WEBAPI_PASSWORD` is separate: it is for the web server used by `rung live`.

VS Code asks when the PLC requires a password or refuses the stored one. When user management requires a user, it asks for that too. It keeps the password and user in VS Code's secret storage, keyed by project path, bridge host and PLC name. Rebinding a folder to another project does not reuse the old project's credentials.

## TLS certificates

When TIA Portal asks about an untrusted PLC certificate, rung refuses it with `TLS_UNTRUSTED` and shows the certificate details TIA Portal supplies. Check them before retrying:

```sh
rung online --plc PLC_1 --trust-certificate
```

`rung compare --trust-certificate` also accepts it for that connection. In VS Code, the modal shows the details and asks whether to trust it for the connection. Consent applies only to that run. rung never saves the decision in `rung.toml`, workspace state or secret storage.

## S7-PLCSIM

rung uses legacy communication for the PLCSIM PG/PC interface and the Siemens PLCSIM Virtual Ethernet Adapter used by S7-PLCSIM Advanced. These simulated PLCs have no PLC certificate, so this path has no TLS certificate prompt. A successful PLCSIM connection does not check the certificate path of a real PLC.
