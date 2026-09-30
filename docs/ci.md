# CI for PLC projects with rung

Two kinds of jobs:

1. **Anywhere (Linux or Windows, no TIA Portal):** the workspace is plain files, so parsing, unit tests and policy checks run on any runner.
2. **Trusted Windows host with TIA Portal** (self-hosted runner): syncing with TIA Portal and compiling there. Never run untrusted pull-request code on this machine.

## Unit tests in three lines (GitHub Actions)

```yaml
name: plc
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sa1ntsinner/rung@v1        # rung test on the offline simulator
        with: { junit: plc-tests.xml }   # optional: dir, filter, version (default: the latest release)
```

A failed expectation appears in the pull request on the line of its step in the test file (`rung test` writes GitHub annotations whenever it runs in GitHub Actions, with or without this action). Other CI systems read the JUnit file.

## GitHub Actions example with review and compile

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
      - run: gh release download --repo sa1ntsinner/rung --pattern "rung.cjs"   # the CLI for any OS (Node.js 22+)
        env: { GH_TOKEN: "${{ github.token }}" }
      - run: node rung.cjs test --junit plc-tests.xml
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
