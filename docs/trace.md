# Trace recording

Record numeric and Boolean signals through the existing read-only PLC subscription:

```sh
rung trace record ProveOps_DB.a ProveOps_DB.sum --device PLC_1 --out capture.json --duration 30 --interval 100
rung trace inspect capture.json
```

Use `--dir <workspace>` when recording outside the workspace. `inspect` works
offline, and `--json` returns the validated recording. The output must be a new
file; an existing file is never overwritten. Ctrl+C or `--parent-stdio` input EOF
stops recording and saves the collected observations. A connection or cleanup
failure returns a nonzero exit code and saves an explicit partial-error recording.
A missing broker release acknowledgement times out after five seconds; the reader
socket closes and the collected observations are saved with an error outcome.
A disk write failure reports that the reserved file may be incomplete.

Limits: 1–32 distinct signals, interval 100–60000 ms, duration 1–3600 seconds,
20000 observations, 64 MiB. Duration starts when subscription opening begins.
Collection stops at the first limit. Samples are buffered in memory and saved
on graceful completion; abrupt process termination can lose the recording.

The version-1 JSON preserves monotonic receipt elapsed milliseconds, original
host timestamps, each signal's observation timestamp, scalar type, PLC target
and connection epoch. Stale, disconnected, missing, unsupported or invalid
values are explicit gaps. A regressing host clock creates gaps as well.
These are asynchronous, coalesced observations: they do not prove cycle timing
or capture every PLC change. Repeated values retain their original observation
timestamp instead of inventing fresh PLC samples.

Import the evidenced TIA long-term CSV profile offline:

```sh
rung trace import measurement.csv --out imported.json
rung trace inspect imported.json --json
```

The portable imported file wraps the original UTF-8 CSV and its SHA256; inspect
verifies that hash and produces normalized viewer data. It preserves original
headers, sample numbers, scalar text and nine-digit timestamp fractions. Relative
milliseconds are calculated from exact integer nanosecond differences. The JSON
view is for inspection; keep the imported file as the portable recording.

This profile uses a semicolon-separated trace-name/activation/signal header and
LDT timestamps. Types and units are absent from the CSV, so `0`/`1` remain numbers;
raw `16#` bit patterns and unsupported numeric precision become explicit gaps.
Unknown profiles, decimal-comma variants, malformed dates/rows and measurements
longer than one hour are refused. Native writer/reader fixture provenance is in
`packages/live/test/fixtures/trace/README.md`; no UI-export or CPU-trace capture
acceptance is claimed by that synthetic-input fixture.

In VS Code, use **rung: Trace: Record PLC Signals…** to select a device, enter
comma-separated symbolic signal names, set a duration and choose a new JSON file.
The progress notification's Cancel button stops the subscription and saves the
observations. Changing workspace/configuration stops and saves the recording too.
Saved PLC credentials are reused. A stuck recorder is terminated after a 30-second
grace period; abrupt termination can leave its output incomplete.

**rung: Trace: Open Recording…** opens portable JSON offline. **rung: Trace:
Import TIA Long-term CSV…** imports the evidenced CSV profile into a new portable
file and opens it. Each selected signal has its own scale; zoom/reset changes the
time range and the cursor shows original observations, timestamps and raw CSV
values. Reconnects, missing values and time gaps break curves. Closing the viewer
releases its loaded model; no background PLC subscription belongs to an open plot.
