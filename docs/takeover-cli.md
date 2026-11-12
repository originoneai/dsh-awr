# The takeover through awr takeover (DSH-054)

The plugin runs the takeover through `awr takeover` when the `awr` of the project has it, and through its own implementation (`lib/takeover.js`, [docs/takeover.md](takeover.md)) otherwise. The owner decided in DSH-040 that the orchestration lives in the AWR CLI (originoneai/awr#620); this is the plugin's side of it. Code: `lib/takeover-cli.js`, wired into `createTakeoverController` in `lib/takeover-host.js`.

## How it behaves

| Step | What happens |
| --- | --- |
| Detect | `awr capabilities` lists `intake.takeover` with `takeover`, `takeover --await-review` and `takeover --reviewed`. The command itself is not run to find out: an older awr answers an unknown subcommand with `Unsupported`, which stops the plugin's use of awr for the project |
| Preview | `awr takeover --await-review` runs preflight and preview, then stops with outcome `awaiting_review`, naming the saved draft and the review request |
| Review | The same read-only DeepSeek Harness subagent as before reviews the draft; its answer is written to a file in the reviewer's answer format |
| Finish | `awr takeover --reviewed <file>` applies the answer under the CLI's guards (files under `.awr/intake/`, goals capped at `candidate`, work items kept) and runs accept, organize and the receipt |

The CLI keeps its runs in `<state>/cli/`, apart from the records of the plugin's own implementation. The panel and `/awr takeover status` show whichever ran last: the CLI record and receipt are mapped to the shape the panel already reads (`goal_total` to `goalTotal`, `awaiting_confirmation` to `awaitingConfirmation`), and a run that waits for the review counts as running.

A review that fails (no subagent service, the model refused, a timeout) cannot be written into the CLI's record, because the run is paused and not stopped. The reason is kept in `host.json` beside the record and shown as the stop of the run. The next start reviews again, and nothing is applied in between: the CLI keeps waiting until an answer is applied.

Without a subagent service the plain `awr takeover` runs and the draft is applied as generated, as before.

## Checked

- `test/takeover-cli.test.js` (14 tests). Eleven run anywhere with a scripted awr: detection (each missing command, the one-minute cache, no probe of the command itself), the mapping of record and receipt, the review loop (arguments, answer file, timeout, adoption), a failed review and its reason, an answer the CLI refuses, and a run left waiting with no way to review it. Three run when `AWR_TAKEOVER_BIN` names an awr that has `intake.takeover` ([docs/lab-environment.md](lab-environment.md)): one start through the controller with a subagent review (the goal the subagent called active ends as `candidate`, nothing committed), a failed review that leaves the project untouched and resumes, and no subagent service. A fourth runs against the older lab awr and checks that the probe leaves awr usable for the project.
- Removing the reviewed-command requirement, the merge of `host.json`, the `--await-review` flag, the stop on a failed review, or the CLI path itself turns tests red.
- The 234 earlier tests pass unchanged, so an awr without the command behaves as before.

## Not checked

- Inside DeepSeek Harness itself: the controller is tested with a stand-in for the subagent service.
- A released awr: the commands exist on branches of originoneai/awr (#621, #623, #626) and in no release yet. Until a release has them the plugin's own implementation runs.
- `lib/takeover.js` stays for older awr versions; it can go when the oldest supported awr has the command.
