# How rung compares

Snapshot of public information as of September 2026. Check the vendors' sites for current details.

| | rung | Siemens VCI (in TIA Portal) | T-IA Connect | Open-source TIA MCP servers | TiaCommander |
|---|---|---|---|---|---|
| Project as text files | Continuous two-way mirror with merge/conflicts | Manual export/import of PLC software | Export/import, git integration | Mostly on demand per tool call | On demand |
| Editor support | VS Code, Zed, Neovim (one language server) | TIA Portal editor | VS Code family | — | — |
| SCL language server | Yes, project-aware, works offline | — | Yes (VS Code) | — | — |
| AI agents | Small MCP + skills; agents edit files directly | — | Large MCP tool catalogue | MCP tool catalogues | MCP |
| Unit tests | Offline SCL simulator (`rung test`) | TIA Portal Test Suite (separate licence) | PLCSIM-based | Rare | — |
| Hardware / HMI | Read-only YAML views | Not in VCI | Partial | Varies | Partial |
| Live values | Read-only via S7-1500 Web API | — | Varies | Varies | Yes |
| Licence | MIT clients + BUSL core (free ≤ 3 users) | Part of TIA Portal | Commercial subscription | Mostly MIT | Proprietary |

What rung does not try to be: a replacement for TIA Portal, a download/commissioning tool, or a way around Siemens licensing.
