# rung

**PLC-as-code for Siemens TIA Portal.** rung mirrors a TIA Portal project into a folder of plain text files (SCL, DB, UDT, SIMATIC SD, XML), keeps both sides in sync, and lets you work on it from any editor (VS Code, Zed, Neovim) and any AI agent (Claude Code, Codex, Cursor).

> Status: pre-alpha. Built and tested against fakes and TIA Portal V20 Openness; live verification on a fixture project is pending (see docs/STATUS.md). Not yet published.

## What you get

- **Two-way sync** (`rung watch`): edit files, TIA Portal follows; edit in TIA, files follow; concurrent edits merge (diff3) or become explicit conflicts. Imports are transactional and guarded by revisions.
- **Language server** for SCL in VS Code, Zed and Neovim: completion, go to definition through DB/UDT/FB members, references, rename, TIA compile errors inline.
- **AI agents**: a small MCP server (`rung mcp`) and a Claude Code plugin with safety and review skills; agents edit files directly.
- **Unit tests** for SCL blocks on an offline simulator (`rung test`), JUnit output for CI.
- **Read-only views** of hardware, HMI Unified and technology objects (`rung views`), live values over the S7-1500 Web API (`rung live`).

rung talks to TIA Portal only through the official Openness API. It never reads or writes `.ap*` project files and never downloads to a PLC. Failsafe, protected, system and GRAPH blocks are read-only.

```
TIA Portal ⇄ rung-bridge (C#, Openness) ⇄ rung (TypeScript) ⇄ folder of text files ⇄ editors / agents
```

Start with the [quickstart](docs/quickstart.md). See also [FAQ](docs/faq.md), [editors](docs/editors/README.md), [agents](docs/agents/README.md), [testing](docs/testing.md), [comparison](docs/comparison.md), [status](docs/STATUS.md).

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
