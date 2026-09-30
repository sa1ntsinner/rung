# How rung compares

A snapshot of public information as of September 2026: product pages, documentation and published code. Check the vendors' sites for current details.

| | rung | T-IA Connect | Siemens (VCI, SIMATIC SD, Eigen, AX) | Copia | Octoplant | TIA MCP servers (TiaCommander and open ones) | CODESYS's own tools |
|---|---|---|---|---|---|---|---|
| PLC platforms | TIA Portal V20, CODESYS V3.5; TwinCAT sources for the language server and tests | TIA Portal V17–V21 | TIA Portal; AX for new projects | Many vendors | Many vendors | TIA Portal | CODESYS |
| Project as text | A continuous two-way mirror: three-way merge (by line, and by network for LAD/FBD), conflicts, crash recovery | Import on save, export back; a concurrent change asks overwrite or cancel | VCI export and import; SD text for LAD, DB, UDT | Exported into Git by a desktop app | Backups and versions | On demand, per tool call | Git for the project (Professional Developer Edition) |
| Editor | Any editor with LSP: VS Code, Zed, Neovim | VS Code, Cursor, Windsurf | TIA Portal; VS Code for AX | Web viewer | — | — | CODESYS |
| Tests without a PLC | Offline simulator, on any CI runner including Linux, JUnit output | PLCSIM Advanced | TIA Test Suite, PLCSIM | — | — | Rare | Test Manager |
| Change review | rung Pro: interface, attributes, logic per region and per LAD network, callers affected, policy gate in your own CI | Git UI | — | Graphical diff, review comments, block-level merge | Compare, approvals, audit trail | — | Git merge |
| AI agents | MCP for any agent; agents edit the files | MCP | Eigen Engineering Agent inside TIA Portal | — | — | MCP | MCP server |
| Where it runs | Windows; Linux and macOS through a Windows PC over ssh | A server on Windows | Windows | Desktop app and cloud or self-hosted | Server | Windows | Windows |
| Licence | Clients and file format MIT; core free for up to 3 users per organization; Pro commercial | Subscription | TIA Portal and separate licences | Commercial | Commercial | Proprietary free beta (TiaCommander); MIT or AGPL | Commercial editions |

Where rung is different:

- One workflow for several vendors. The same file format, language server, test runner and agent tools for TIA Portal and CODESYS projects, and for TwinCAT sources.
- The mirror keeps running. Edits in both places merge, SCL by line and LAD or FBD network by network, a real conflict stops for a person, and an interrupted sync picks up where it stopped.
- Tests run without the engineering software or a PLC licence, in seconds, so every pull request can run them.
- It does not pick your editor, your agent or your Git host. The workspace is plain files in an open format.

What rung is not: a replacement for TIA Portal or CODESYS, or a way around their licences. Downloads to a PLC are always started by a person.
