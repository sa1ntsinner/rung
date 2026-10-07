<!-- SPDX-License-Identifier: MIT -->
# Linux and macOS: TIA Portal on another PC

TIA Portal runs only on Windows. rung on Linux or macOS works with the TIA Portal of a Windows PC or VM: it starts rung's bridge there over ssh, and the files travel over that connection. The workspace, your editor, the language server, `rung test` and git stay on your machine.

## On the Windows PC

- TIA Portal V20 with Openness, and your Windows user in the group "Siemens TIA Openness".
- A TIA Portal licence for everyone who uses that PC at the same time, and for a CI server: several engineers working through one TIA Portal still need their own licences under Siemens' terms.
- rung, so that `rung bridge` runs in a new terminal (rung on the PATH; `npm install -g @rung-plc/cli` does it). Run `rung setup openness` there once, so TIA Portal does not ask for Openness access.
- OpenSSH Server (Settings → System → Optional features → OpenSSH Server), with your public key in `C:\Users\<you>\.ssh\authorized_keys` (for an administrator account: `C:\ProgramData\ssh\administrators_authorized_keys`). rung logs in with the key only; it never waits for a password.

## On your machine

```
npm install -g @rung-plc/cli          # Node.js 22 or newer
ssh elmir@tia-pc rung --version       # logs in without a password and finds rung
rung init --host elmir@tia-pc --project "D:\Projects\Line3\Line3.ap20"
rung pull
```

`rung check --host elmir@tia-pc` checks what is installed on that PC; add `--json` for the unchanged JSON answer.

`--project` is the path on the Windows PC. `rung.toml` then holds:

```toml
[bridge]
host = "elmir@tia-pc"
```

Everything else works as on Windows: `rung sync`, `rung watch`, compile, compare, views, downloads (you still type the PLC name). The bridge on that PC behaves as it does there: it uses the TIA Portal that has the project open, or opens the project without a window. *Open in TIA Portal* needs a desktop on that PC, which an ssh session does not have: open the project in TIA Portal there yourself (Remote Desktop), and rung attaches to that TIA Portal.

If rung is installed there but not on the PATH, give the whole command: `command = '"C:\Program Files\rung\rung.exe" bridge'` under `[bridge]`.

When nothing answers, rung says so and what to check: that `ssh <host>` logs in without a password, and that `rung bridge` runs on that PC.

## From VS Code

Run **rung: Open TIA Project…**, choose **TIA Portal on another PC (ssh)…**, then enter the SSH destination and the Windows project path (`.ap19`, `.ap20` or `.ap21`). The last destination is remembered; `rung.remote.host` supplies a default. rung checks TIA Portal and Openness on that PC before opening the project. Register Openness with `rung setup openness` on the Windows PC if prompted.

The mirror uses your open local folder, or asks you to choose one. rung initializes it, pulls the project files and starts Watch as for a local project. Project writes stay off. **Open in TIA Portal** still needs an interactive desktop on the Windows PC; SSH does not provide one.
