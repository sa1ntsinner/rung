# Developing the rung VS Code extension

```
npm install
npm run build        # type check + bundle to out/extension.js
npm run package      # rung-scl.vsix
npm run test:e2e     # integration tests in a real VS Code (see below)
```

Unit tests (no VS Code) run from the repository root: `pnpm vitest run editors/vscode`.

`npm run test:e2e` starts VS Code as an Extension Development Host with a throwaway user data and extensions folder and other extensions turned off (the installed VS Code, else a downloaded one; `VSCODE_EXE` picks another). It runs three suites: *fresh* (a folder without `rung.toml`: initialize and pull), *fake* (a mirrored project on `packages/cli/test/fake-bridge.mjs`: views, status bar, CodeLens, every command, compile → Problems, watch, online and connection picking, download) and *tia* (the workspace `%TEMP%\rung-probe-ws`, bound to a TIA Portal V20 fixture project; skipped when TIA Portal does not answer). `RUNG_E2E_SUITES=fake` runs one suite, `RUNG_E2E_GREP=download` only matching tests. The CLI is `rung` from PATH, built with `pnpm -s tsc -b` at the repository root.

