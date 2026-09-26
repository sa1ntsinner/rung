<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/assets/logo-dark.png">
    <img alt="rung" src="site/assets/logo-light.png" width="236">
  </picture>
</p>

TIA Portal projects as plain text.

rung keeps a Siemens TIA Portal project and a folder of text files in sync, both ways. You write SCL in VS Code, Zed or Neovim, review changes in git like any other code, and coding agents work on the same files you do.

It's pre-alpha. It runs against TIA Portal V20 and the full test suite passes on a real project, but there is no release yet.

## Quick start

```sh
rung init --project D:\TIA\Line3.ap20   # bind this folder to a project open in TIA Portal
rung pull                               # export blocks, types and tag tables as text
rung watch                              # keep both sides in sync until Ctrl+C
```

The [quickstart](docs/quickstart.md) walks through setup, including the Openness group your Windows user has to be in.

## What's in it

- Two-way sync. Save a file and rung imports it, compiles the block and writes TIA's version back. Changes made in TIA Portal come back to the files. If both sides changed, you get a line merge or a conflict to resolve.
- A language server for SCL: completion, go to definition through DBs, UDTs and FB instances, references, rename, and TIA's compile errors on the right line. There are extensions for [VS Code and Zed](docs/editors/README.md) and a config for Neovim.
- An [MCP server and a Claude Code plugin](docs/agents/README.md), so agents can check sync status, compile, find usages and run tests.
- `rung test`, which runs YAML unit tests for FBs and FCs on an offline simulator and prints JUnit. See [testing](docs/testing.md).
- Read-only views of hardware, HMI and technology objects, and live values from the S7-1500 Web API.

## What it won't do

rung talks to TIA Portal only through Siemens' Openness API. It never opens project files itself and never downloads to a PLC. Failsafe, know-how protected, system and GRAPH blocks stay read-only, and deleting a file doesn't delete the block until you run `rung confirm-delete`.

## Requirements

Windows with TIA Portal V20 and the Openness option, and Node.js 22 or newer.

<details>
<summary>Working on rung</summary>

```sh
pnpm install
pnpm test                                         # TypeScript packages
dotnet test bridge/tests/Rung.Bridge.Core.Tests   # bridge core, no TIA Portal needed
```

The live tests against TIA Portal run headless, without windows or prompts. The steps are in [docs/STATUS.md](docs/STATUS.md), and what we learned about Openness V20 along the way is in [docs/facts](docs/facts/openness-v20.md).

</details>

## License

The core is under the Business Source License 1.1. It's free for individuals, education, non-commercial open source and organizations with up to three users, and each version becomes Apache 2.0 three years after its release. The protocol client, grammar, editor extensions and file format are MIT. Details in [LICENSE](LICENSE).

rung is not affiliated with Siemens AG. TIA Portal and SIMATIC are trademarks of Siemens AG.
