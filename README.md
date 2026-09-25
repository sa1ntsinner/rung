# rung

**PLC-as-code for Siemens TIA Portal.** rung mirrors a TIA Portal project into a folder of plain text files (SCL, DB, UDT, SIMATIC SD, XML), keeps both sides in sync, and lets you work on it from any editor (VS Code, Zed, Neovim) and any AI agent (Claude Code, Codex, Cursor).

> Status: pre-alpha, under active development. Not yet published.

## How it works

```
TIA Portal ⇄ rung-bridge (C#, Openness API) ⇄ rung (TypeScript) ⇄ folder of text files ⇄ editors / agents
```

- `rung init` binds a workspace folder to an open TIA Portal project.
- `rung pull` exports every supported object to `plc/<Device>/…` (incremental, lossless file names).
- `rung doctor --fixture` checks that export → import → export is stable.
- Coming next: `rung watch` (two-way sync), language server, MCP server for agents.

rung talks to TIA Portal only through the official Openness API. It never reads or writes `.ap*` project files directly and never downloads to a real PLC.

## Requirements

- Windows with TIA Portal V20 and the Openness option; your Windows user must be in the local group **Siemens TIA Openness**.
- Node.js 22.13+ or 24.

## Development

```
pnpm install
pnpm test                                   # TypeScript
dotnet test bridge/tests/Rung.Bridge.Core.Tests   # bridge core (no TIA needed)
```

## License

Per directory — see [LICENSE](LICENSE). The core is source-available under the Business Source License 1.1: free for individuals, education, non-commercial open source and organizations with up to 3 users; each version becomes Apache-2.0 three years after release. Client pieces (protocol client, grammar, editor extensions, workspace format) are MIT.
