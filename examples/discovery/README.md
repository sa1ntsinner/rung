# A motor that keeps running

A motor block with Start, Stop and Permit, and no tests. The project path in
`rung.toml` is a placeholder: there is no TIA project, so don't sync or download.
Discovery needs only the simulator.

Copy this folder somewhere, make it a git repository and commit it:

```sh
git init && git add . && git commit -m "motor"
```

Now make a change that looks harmless. In `blocks/Motor.scl`, move Permit into the
start condition:

```scl
#Running := (#Running OR (#Start AND #Permit)) AND NOT #Stop;
```

The motor still needs Permit to start. Is that all the change did? Ask rung:

```sh
rung discover
```

```text
≠ Motor  Running differs at scan 2: FALSE before, TRUE now
```

Open the report. Start with Permit for one scan, then take Permit away: the old
block stops the motor, the new one keeps it running. Permit used to be an
interlock and now only gates the start.

**Save as test…** keeps that sequence as an ordinary test. It fails on the
changed block and passes again when you restore the original line.

`motor.discover.yaml` is the same search with every domain and budget written
out: `rung discover motor.discover.yaml`.

In a clone of the rung repository, use `node ../../packages/cli/dist/index.js`
instead of `rung` after `pnpm build` at the repository root.
