# Takeover review sheet: dsh001-fixture

- Result: `needs_organization`
- Run: `cca61bab6823`
- Commits in the project: 17

## Goals and work items the takeover made

Trace each one to a README line or a commit, or mark it invented or wrong.

| Item | Kind | Traced to (README line / commit) | Verdict (supported / invented / wrong) |
| --- | --- | --- | --- |
| `- id: primitive-grouping-ig` | work-ledger.yaml | | |
| `title: Explore organization of MCP primitives beyond flat lists` | work-ledger.yaml | | |
| `title: Requirements alignment` | work-ledger.yaml | | |
| `title: Experimental findings repository section` | work-ledger.yaml | | |
| `title: MCP Grouping Convention v0.1` | work-ledger.yaml | | |
| `title: Shared canonicalization vectors and a second independent implementation` | work-ledger.yaml | | |
| `title: Close pending Host integration gates` | work-ledger.yaml | | |

## Recent history

```
23ecff1 test: measure grouped discovery costs across catalog sizes
7634f26 docs: distinguish external host acquisition and activation evidence
c3fa2a9 feat: validate asynchronous grouping host activation over stdio
889b64c test: exercise grouping contract over MCP SDK stdio
e159b63 test: add portable grouping contract and adapter checks
699ba86 feat: prototype deterministic grouping contract and host lifecycle
b6d8ce4 Merge remote-tracking branch 'origin/main' into findings/doris-progressive-disclosure
2505387 Merge pull request #17 from modelcontextprotocol/fix/ci-empty-typescript-sdk
3df47af fix(ci): unbreak build for the source-less TypeScript SDK
99328a0 docs: add Doris progressive disclosure findings
07e546d Merge pull request #7 from chughtapan/groups/scaffolding-v2
f190cd4 Update sdk/typescript/package.json
7f3184b Add TypeScript SDK scaffolding with CI and linting
ee8b6b4 Update README.md
866e185 Update README.md
4765d11 Add .gitignore, README.md, and other docs/* files with menu-linked template
ed4987f first commit
```

## README, first 60 lines

```
# Primitive Grouping Interest Group

> ⚠️ **Experimental** — This repository is an incubation space for the Primitive Grouping Interest Group. Contents are exploratory and do not represent official MCP specifications or recommendations.

## Mission

This Interest Group explores how MCP Primitives (Tools, Resources, Prompts, Tasks) might be organized, beyond the flat lists that are maintained by the protocol, and how such organization might benefit both MCP servers and clients.

## Scope

### In Scope

- **Requirements gathering:** Documenting use cases and constraints
- **Pattern exploration:** Testing and evaluating various approaches
- **Proof of concepts:** Maintaining a shared repo of reference implementations and experimental findings

### Out of Scope

- **Approving spec changes:** This IG does not have authority to approve protocol changes; recommendations flow through the SEP process
- **Implementation mandates:** We can document patterns but not require specific client or server behavior

## Problem Statement

Flat lists of MCP primitives can be long and cumbersome to work with.  

- **Context overload** — When loaded into the context of an LLM, a primitive list can overwhelm the model and lead to confusion and poor selection
- **Costly operation** - Long lists can consume many tokens, leading to higher costs for users.
- **Poor developer experience** — Lack of organizational tools for primitives makes them harder to manage and maintain

See the [Problem Statement](docs/problem-statement.md) for full details.

## Repository Contents

| Document | Description |
| :--- | :--- |
| [Problem Statement](docs/problem-statement.md) | Current limitations and gaps |
| [Use Cases](docs/use-cases.md) | Key use cases driving this work |
| [Approaches](docs/approaches.md) | Approaches being explored (not mutually exclusive) |
| [Open Questions](docs/open-questions.md) | Unresolved questions with community input |
| [Experimental Findings](docs/experimental-findings.md) | Results from implementations and testing |
| [Related Work](docs/related-work.md) | SEPs, implementations, and external resources |
| [Contributing](CONTRIBUTING.md) | How to participate |


## Facilitators

| Role | Name        | Organization                                               | GitHub                                         |
| :--- |:------------|:-----------------------------------------------------------|:-----------------------------------------------|
| Facilitator | Tapan Chugh | CS PhD student at University of Washington                 | [@chughtapan](https://github.com/chughtapan) |
| Facilitator | Sam Morrow  | Senior Software Engineer at GitHub                         | [@SamMorrowDrums](https://github.com/SamMorrowDrums)     |
| Maintainer | Cliff Hall  | Futurescale / MCP Maintainer                               | [@cliffhall](https://github.com/cliffhall)     |

## Lifecycle

**Current Status: Active Exploration**

### Graduation Criteria (IG → WG)

This IG may propose becoming a Working Group if:

```
