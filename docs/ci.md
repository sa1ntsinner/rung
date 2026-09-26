# CI for PLC projects with rung

Two kinds of jobs:

1. **Anywhere (Linux or Windows, no TIA Portal):** the workspace is plain files, so parsing, unit tests and policy checks run on any runner.
2. **Trusted Windows host with TIA Portal** (self-hosted runner): syncing with TIA Portal and compiling there. Never run untrusted pull-request code on this machine.

## GitHub Actions example

```yaml
name: plc
on: [pull_request]
jobs:
  checks:                      # any runner
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g rung            # or use the release archive
      - run: rung test --junit plc-tests.xml
      - run: rung-pro check . --git origin/main      # rung Pro: rung.policy.toml gate
      - run: rung-pro review . --git origin/main --out review.md
      - uses: actions/upload-artifact@v4
        with: { name: plc-review, path: "review.md\nplc-tests.xml" }

  compile:                     # trusted host with TIA Portal V20
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted, windows, tia-v20]
    steps:
      - uses: actions/checkout@v4
      - run: rung sync           # the workspace is bound to the CI copy of the project
      - run: rung status
```

`rung sync` exits with code 2 when there are warnings, compile errors or conflicts, so the job fails visibly.

## Review record for FAT/SAT

```
rung-pro review . --git v1.4.0 --fat --out FAT-v1.5.md
```

produces a change record with interface changes per variable, logic changes per REGION, affected callers and instance DBs, safety-relevant names, unit-test results and a sign-off table.
