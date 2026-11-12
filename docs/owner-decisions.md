# Owner decisions still open

Two items of the ledger wait for the owner, now that the takeover has been proven on real projects (DSH-022).
Each has the facts that bear on it and a recommendation; the decision is the owner's and nothing here is applied.

## DSH-040: move the takeover orchestration into the AWR CLI?

| Fact | Where |
| --- | --- |
| `lib/takeover.js` uses no DSH API: it runs `awr` through argv, keeps its state in a run directory and resumes from any step | `docs/takeover.md`, `test/takeover.test.js` (real awr, interruption at every step) |
| What is DSH-specific is the reviewer: a restricted subagent, its prompt, and `keepIntakeWork` / goal-status capping applied to its answer | `lib/takeover-host.js` |
| The real-model runs needed a host-side fix (the reviewer emptied the work list) and ended `needs_organization` with candidate goals | `docs/evidence/DSH-022/REVIEW.md` |
| One real project stops at AWR's secret boundary with no unattended way on when the README is the only source | originoneai/awr#618, PR #619 |

Options: (a) keep it in the plugin; (b) add an `awr takeover` command that takes a reviewer callback or command.

Recommendation: (a) for now. The module is already portable, so nothing is lost by waiting, and the open points are
on AWR's side (an `init --exclude` for the secret boundary, a defined reviewer interface). Revisit when #618 is
settled and a second host wants the same flow. If you choose (b), the work item belongs in the AWR repository.

## DSH-041: license, visibility and a first release

| Fact | Where |
| --- | --- |
| The repository is private; `package.json` is `UNLICENSED` and `"private": true`; there is no LICENSE file | repository settings, `package.json` |
| AWR is Apache-2.0 (contributions are licensed Apache-2.0) | the AWR repository's `CONTRIBUTING.md` |
| The plugin installs from a local directory through the app's Plugins page and through `dsh plugin add` | `docs/dsh-010-skeleton-check.md`, `docs/evidence/DSH-022` |
| The plugin needs no AWR release: it runs the `awr` CLI. Only the MCP route needs a release that contains awr#614 | `docs/evidence/DSH-004` |
| Everything model-driven except the takeover used a local stand-in; the takeover ran on public projects with one model | the "Not checked" sections of the `docs/*.md` pages |

Options: keep private and unlicensed (internal use); or Apache-2.0 and public, with a tagged release that installs
through `dsh plugin add` from its published source on a clean DSH install (the item's second criterion).

Recommendation: Apache-2.0 to match AWR, and public once you are comfortable with the code and the evidence
folders (they hold local paths and project names). A release then needs `private` removed from `package.json`, a
LICENSE file, a version bump and a tag. I have not done any of this: publishing, tagging and changing the
repository's visibility are outside what this project does on its own.
