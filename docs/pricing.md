# Pricing and licence

| | Free | Pro | Enterprise |
|---|---|---|---|
| Price | €0 | €49 per user and month | on request |
| For | individuals, education, non-commercial open source, organizations with up to three rung users | teams of any size | plants and machine builders rolling rung out across teams |
| Two-way sync, language server and editor extensions, offline tests and CI, MCP server and agent skills | ✓ | ✓ | ✓ |
| `rung review`: a change report per block (interface and declarations, changed SCL regions and LAD networks, callers, data blocks, tags) | ✓ | ✓ | ✓ |
| Commercial licence | | ✓ | ✓ |
| Team review on top of `rung review`: tag tables, structured text, FBD and SIMATIC SD networks, network settings, attributes such as optimized access and retain, the parts of a diff it cannot explain flagged for a person, unit-test results in the report | | ✓ | ✓ |
| CI policy gate (`rung.policy.toml`) and FAT/SAT change records | | ✓ | ✓ |
| Support | | ✓ | ✓ |
| SLA and onboarding, training, your own review rules, offline installation | | | ✓ |

Ask about Pro or Enterprise: rungprojectplc@gmail.com.

rung does not replace your engineering tools: TIA Portal (with Openness) and CODESYS need their own licences.

## The licence in short

- The rung core is source-available under the Business Source License 1.1 ([LICENSE](../LICENSE)). Production use is free for individuals, education, non-commercial open source and organizations with up to three users; larger organizations take Pro.
- Every release becomes Apache-2.0 three years after it is published.
- rung is source-available, not open source: you can read, build and change the core, and the grant above says who may use it in production for free.

## Who needs Pro

- **One engineer**, employed or freelance, using rung for their own work, paid work included: free.
- **A consultant** working personally on customers' projects: free. When the customer's own engineers use rung too, they count for the customer's organization.
- **A team of three** at a machine builder or plant: free. The organization counts together with its affiliates, so three users at the parent company and two at a subsidiary are five.
- **A fourth person** starts using rung in that organization: it needs a commercial licence, Pro, priced per user.
- **CI runners and build servers** running `rung test`, `rung review` or `rung format --check` are not users: the grant counts people.
- **Schools, universities and non-commercial open-source projects**: free, whatever their size.
- Offering rung, or a product built mainly on it, as a hosted or embedded service is never covered by the free grant.
- The editor extensions, the grammar, the protocol client and the workspace format are MIT.
- rung is not affiliated with Siemens AG. TIA Portal and SIMATIC are trademarks of Siemens AG.
