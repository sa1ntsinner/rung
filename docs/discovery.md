# Find what your change changed (`rung discover`)

You changed a block and the tests are green. Did the change do only what you meant?
`rung discover` runs the block before and after your change on the offline simulator,
searches input sequences on which the two versions answer differently, and shows you
the shortest one it can find. You don't write a test or a scenario.

```text
$ rung discover
≠ Motor  Running differs at scan 2: FALSE before, TRUE now
  .rung/discover/3f90…/Motor/report.html
```

The report tells the sequence as a sentence: *Start = TRUE, Permit = TRUE for 1 scan,
then Start = FALSE, Permit = FALSE for 1 scan. At scan 2, Running is FALSE before your
change and TRUE now.* Below it are the line in each version that wrote the value, with
what that line read and the IF, CASE or loop it ran inside, so you see why each version
took the branch it did. Then a timeline of the inputs and the signal, both sources with
the changed lines marked, and **Save as test…**, which turns the sequence into an
ordinary `rung test` file.

When the change shows in more than one place, rung keeps looking after the first
difference and reports up to three, each on its own tab: different signals, or the same
Boolean going the other way. When other files changed since the same revision (a block
the searched one calls, a type), the report names them, since the difference may come
from them.

A difference is not automatically a bug. You may have meant to change that behaviour.
Then the saved test documents the old behaviour, and you change its expectations to the
new one.

No TIA Portal, no PLC and no PLCSIM are involved.

## In VS Code

Run **rung: Find a Behavioural Change** from the command palette, the editor's context
menu or the Source Control view's title bar.

- With an SCL file open: that block is compared with its previous version. Save it first.
- With no SCL file open: every FB and FC changed since the last commit is searched. One
  difference opens directly; several open a list.

The report opens beside the editor in your colour theme.

## On the command line

```sh
rung discover                          # every FB/FC changed since HEAD
rung discover --file blocks/Motor.scl  # one block
rung discover --against v1.4           # compare with any git revision
rung discover motor.discover.yaml      # your own domains and budgets
rung discover --fresh                  # start without what earlier runs reached
```

Without `--against`, a changed file is compared with `HEAD`. A file without uncommitted
changes is compared with the version before the last commit that changed it, so the
command also works right after you commit.

Exit code **2** means a difference was found, **0** none, **1** discovery could not run
(the reason is printed; with `--json`, `{"status": "unavailable", "reason": …}`).

## What it tries

rung picks the inputs from the block's interface:

- **Bool** inputs: FALSE and TRUE.
- **Integer and REAL** inputs: the start value, 0, and what the code compares them with,
  with the neighbours. For `IF #Level >= #Recipe.LevelA` with `LevelA : Real := 40.0` in the
  UDT, that is 40, 39.5 and 40.5. Constants and statics count the same way. At most 8 values.
  Comments, attributes and CASE labels are not read as thresholds.
- **Structures**: the Bool and number members of a structure or UDT input are driven one by
  one (`Cmd.Start`, `Cmd.Speed`), two levels deep.
- **IN_OUT** members the block only reads are driven like inputs; the ones it writes are
  observed like outputs.
- **Other inputs** (a TIME preset, a string, an array) are not driven: they keep their
  start values, and the report lists them.

An input rests at its start value: when the story says "all other inputs at their start
values", that is what the others hold.
- **Timers**: when the block, its types or the blocks it calls contain time literals such as
  `T#30s`, the scan time is set so that the longest one runs out within the search, and
  inputs are held for about as long as each preset.

The search starts with each value alone and short changes from one value to another. Then
it explores: a sequence that reaches something no earlier one did (a new step number, a
flag, a branch of the code that had not run) is kept, and the search continues from it by
changing one or two inputs at a time, as you would at the machine. That is how it walks a
CASE sequencer through its steps without being told the order. Sequences have up to 12
changes and 32 scans (more when timers need it). Every scan is compared, so a difference
that lasts one scan is found too. A found sequence is then shortened for as long as it
still shows the same difference.

The sequences that reached new states are kept in `.rung/discover/corpus/`, one file per
block, and the next run starts from them, so a sequencer the last run walked deep into is
reached again at once. `--fresh` ignores them.

A block that calls an instruction rung only stubs, such as `Program_Alarm`, is searched when
nothing in the program reads that instruction's outputs; the report names it.

## A configuration file

```yaml
block: Motor
# plc: PLC_1          # when the same block name exists on two PLCs
cycle: 10ms           # virtual scan time
inputs:
  Start: [false, true]
  Stop: [false, true]
  Permit: [false, true]
  Speed: [0, 1500, 1501]
outputs: [Running]
search:
  seed: 1
  maxCycles: 32       # scans per sequence, up to 256
  maxEvents: 12       # input changes per sequence, up to 16
  maxRuns: 1000       # sequences replayed on both versions, up to 10000
  holds: [1, 2, 5, 10, 20]   # how many scans an input change is held
  timeoutMs: 15000
```

Up to 16 inputs with up to 8 values each and up to 32 observed outputs. Structure
members are named with dots (`Cmd.Start: [false, true]`). `fixed: [Recipe]` lists inputs
that keep their start values.

## What a result means

- **Found**: replaying the sequence on both versions gives different values. Before the
  test is offered, it is run once more on both versions: it passes on the old one and
  fails on yours.
- **Not found**: none of the sequences tried showed a difference. That is evidence, not a
  proof that the two versions are equal.
- **Unavailable**: discovery refuses rather than guesses. The interface changed between
  the versions, the block calls a stub whose outputs the program reads, the block is new
  since the revision, or an observation is missing.

A search that runs out of its time or run budget without a difference ends as not found;
the report says which budget stopped it.

Each sequence starts both versions from their declared start values; state persists from
scan to scan within a sequence. The line shown for each version is the last write to the
signal that the simulator executed. Scan times are virtual: interrupts, I/O update and
field timing are not modelled. Numbers are compared as `rung test` compares them (relative
tolerance 1e-6).

## The files

Each run writes a new folder under `.rung/discover/` (or `--out <new folder>`; an
existing folder is never overwritten):

- `report.html`: the report, self-contained, opens in any browser.
- `reference.test.yaml`: when a difference was found, one test case per finding, with the
  old version's values as expectations after every scan.
- `evidence.json`: the revision, source hashes, domains, bounds, the sequence and every
  observed value.

They contain your source code. Keep them private unless you mean to share them.

Try it on the [motor example](../examples/discovery/README.md).
