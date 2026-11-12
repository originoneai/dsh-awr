# DSH-022 runbook: the one-click takeover with a real model

Run the takeover in the signed-in DeepSeek Harness desktop app on two public projects, then review what it made
against each README and history. The pipeline, the restricted reviewer, the receipt and the new-conversation
context were already run on real project copies with a local stand-in for the model
(`docs/evidence/DSH-021`, `docs/takeover-ui.md`). What is left is the part only the desktop app can do: a real
model as the reviewer.

## Use it

1. Stage fresh public clones and preview them:

   ```sh
   scripts/dsh022-stage.sh ~/dsh022-stage
   ```

   `experimental-ext-grouping` and `agents` preview cleanly. `doris-mcp-server` stops at the secret boundary
   (example `Authorization: Bearer ...` lines in its README, awr issue 618) and is kept to record that stop.
2. In the desktop app, open Plugins, choose Install third-party plugin and pick this repository's folder.
3. Open a staged project as a workspace (the folder dialog of "add workspace"), start a conversation, open the
   **AWR** action in its header and click **Take over this project** (or type `/awr takeover`).
4. Wait for the receipt in the panel (`/awr takeover status --json` prints it). Start a new conversation in the
   same workspace and ask what its next action is: the answer comes from the injected AWR context.
5. Collect and review, then repeat for the second project:

   ```sh
   scripts/dsh022-collect.sh ~/dsh022-stage/agents docs/evidence/DSH-022/agents
   ```

   Fill in `review-sheet.md`: each goal and work item is traced to a README line or a commit, or recorded as
   invented or wrong.
6. Uninstall the plugin from the Plugins page.

## How it behaves

| Step | Result |
| --- | --- |
| Takeover start | The project is mapped, a draft is written, and a read-only subagent reviews it with the real model |
| Review | The reviewer reads project files only; `.env`-style files and paths outside the project are refused |
| End | A receipt in `.awr/takeover/receipt.json` with `needs_organization` or `ready`; goals stay `candidate` |
| Secret boundary | The run stops with the file and line, never the value; the project is left untouched |
| New conversation | The prompt carries the AWR work context; `/awr status` names the bound session |

## Limits

- Everything the reviewer reads goes to the model provider; stage public projects only.
- The run needs the owner's signed-in desktop app: the CLI, headless and web profiles cannot use the account.
- A takeover that ends `needs_organization` is a valid final state; confirming goals is the owner's step.

## Code and tests

- `scripts/dsh022-stage.sh`, `scripts/dsh022-collect.sh`
- `lib/takeover.js`, `lib/takeover-host.js`, `test/takeover.test.js`, `test/takeover-host.test.js`
