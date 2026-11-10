# Licence and terms

rung is free for individuals, education, non-commercial open source and organizations with up to three people using it. That covers everything in this repository: two-way sync, the language server and editor extensions, offline tests and CI, `rung review`, the MCP server and agent skills.

A larger company, or one that wants support or its own terms: write to rungprojectplc@gmail.com and we agree terms.

rung does not replace your engineering tools: TIA Portal (with Openness) and CODESYS need their own licences.

## The licence in short

- The source is open: you can read, build and change all of it.
- The rung core (the bridge and the packages whose LICENSE file says so) is under the Business Source License 1.1 ([LICENSE](../LICENSE)). Its grant says who may use it in production for free: the people and organizations above. BUSL is not an open-source licence in the OSI sense, so we do not call the core open source.
- Every release of the core becomes Apache-2.0 three years after it is published.
- The editor extensions, the grammar, the protocol client, the agent skills and the workspace format are MIT.

## Who counts

- **One engineer**, employed or freelance, using rung for their own work, paid work included: free.
- **A consultant** working personally on customers' projects: free. When the customer's own engineers use rung too, they count for the customer's organization.
- **A team of three** at a machine builder or plant: free. The organization counts together with its affiliates, so three users at the parent company and two at a subsidiary are five.
- **A fourth person** starts using rung in that organization: write to us and we agree terms.
- **CI runners and build servers** running `rung test`, `rung review` or `rung format --check` are not users: the grant counts people.
- **Schools, universities and non-commercial open-source projects**: free, whatever their size.
- Offering rung, or a product built mainly on it, as a hosted or embedded service is never covered by the free grant.
- rung is not affiliated with Siemens AG. TIA Portal and SIMATIC are trademarks of Siemens AG.
