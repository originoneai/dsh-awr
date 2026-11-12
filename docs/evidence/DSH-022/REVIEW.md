# DSH-022: review of the real-model takeovers

Run on 2026-11-12 in the signed-in DeepSeek Harness 0.2.2-rc.1 desktop app (macOS), model DeepSeek-V4.1-Flash
through the account provider, plugin installed from this repository through Plugins > Add plugin, each takeover
started with `/awr takeover` in a new conversation on a fresh public clone. Receipts: `agents/`, `grouping/`,
`doris-mcp-server/`; the run before the fix is `agents-run1-before-fix/` with `run1-findings.json`.

## Results

| Project (commits) | Takeover | Final state | Seconds | Conversation after it |
| --- | --- | --- | --- | --- |
| wshobson/agents (34), run 1 | completed | `needs_organization` | 55 | Not bound: the reviewer left `work_items: []`; the model said its prompt had no AWR context (defect 1) |
| wshobson/agents (34), run 2, after the fix | completed | `needs_organization` | 26 | A new conversation was bound and answered goal and next action from the AWR context alone |
| wshobson/agents (34), run 3, started with the header button | completed | `needs_organization` | 36 | (receipt and ledger in `agents-button-run/`; goal `GOAL-001` candidate, `INTAKE-001` kept) |
| modelcontextprotocol/experimental-ext-grouping (17) | completed | `needs_organization` | 69 | A new conversation was bound to `REQ-ALIGN` and answered from the AWR context alone |
| apache/doris-mcp-server (60) | stopped at preview: `secret_boundary` at `README.md:1468`, category `credential` | none (project untouched, no `.awr`) | 3 | not applicable |

`needs_organization` is the receipt's honest final state: the goal is a `candidate` that the owner has to confirm, and
AWR reports `goal_unconfirmed` for it.

## Reviewed against README and history

### wshobson/agents, run 2

Goal "Maintain the Claude Code specialist subagent collection" (candidate, provenance README.md, LICENSE and the 48
files), four success criteria, one work item `INTAKE-001`.

| Item | Traced to | Verdict |
| --- | --- | --- |
| 48 subagents listed, each file exists | README "Available Subagents": 48 links; 48 root `.md` files besides README | supported |
| Every file has frontmatter with name, description, model | all 48 files | supported |
| Model per file matches the README's totals | README: 29 sonnet, 11 opus; files: 8 haiku, 29 sonnet, 11 opus | supported |
| MIT license | `LICENSE` first line | supported |
| `INTAKE-001`: verify files and model assignments against the README | README names no unfinished work | supported, and says so in its summary |

### experimental-ext-grouping

Goal "Explore organization of MCP primitives beyond flat lists" (candidate) with short, medium and long term criteria,
five work items.

| Item | Traced to | Verdict |
| --- | --- | --- |
| Goal and its three horizons | README "Short-term", "Medium-term", "Long-term" | supported |
| `REQ-ALIGN` Requirements alignment, planned | README Work Tracking row: In Progress, All facilitators, "Review approaches, identify common requirements and gaps"; `docs/approaches.md` exists | supported (status kept at planned, "completion is not verified") |
| `FINDINGS-SECTION` | README row: Proposed, TBD, "Dedicated repo section for implementations and evaluation results"; `docs/experimental-findings.md` has an Implementations section | supported |
| `GROUPING-CONVENTION-0.1` | README row: Proposed, TBD, "Documented pattern (not spec)" | supported |
| `INTEROP-SECOND-IMPL` | `experiments/deterministic-groups/README.md` line 126 (shared vectors, second implementation, "Unicode-code-point vs RFC 8785 wording"); `conformance/README.md` ("not a second implementation", "only JavaScript has been run") | supported |
| `HOST-INTEGRATION-GATES` | `conformance/README.md` next tests; `conformance/contract.json` `pending` list | supported |

No invented goal, owner, date or completion was found in either project.

## Defects and observations

1. **Fixed (dsh-awr #22):** in run 1 the reviewer replaced the ledger with `work_items: []`, removing the generated
   `INTAKE-001`. With no work item AWR has nothing to bind, so the conversation got no AWR context. The reviewer
   prompt now says to keep it, and the host restores the draft's work section when a returned YAML ledger has none.
   In run 2 and in the grouping run the reviewer kept or replaced `INTAKE-001` with real work itself.
2. **Fixed (DSH-053):** `priority` and `required` of the new work items in the grouping run (`REQ-ALIGN` P0 required,
   the others P1 or P2) were the reviewer's inference; the README states each row's status but not a priority. The
   prompt forbade inventing owners, dates and completion but did not mention priority. It now says to set both only
   when the material states them; a real awr accepts a reviewed ledger whose new items carry neither (status
   `planned`, ready, priority and required empty). Not re-run with a real model.
3. **By design, recorded:** `doris-mcp-server` stops at AWR's secret boundary (example `Authorization: Bearer ...`
   lines in its README, three findings at lines 1468, 1469 and 1533); the stop names the file and line, never the
   value, and leaves the project untouched. AWR gives no unattended way past it when the README is the only source
   (originoneai/awr#618, repair wording in PR #619).
4. **Limit:** the slash-command runs and the button run use the same host operation; runs 1, 2 and the grouping run were
   started with the command, run 3 with the button.
