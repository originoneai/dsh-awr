# dsh-awr

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that lets
[AWR (Agent Work Runtime)](https://github.com/originoneai/agent-work-runtime) manage work state
for projects developed inside DSH.

Status: **v0.2.0.** Checked in DeepSeek Harness `0.2.2-rc.2` (the signed-in desktop app on macOS arm64, with a real model)
and, for what the app cannot show, in the web and headless profiles with a local stand-in model. It binds each
conversation to an AWR session, puts the AWR work context in the prompt, gives the model the `awr` tools and a workflow
skill, offers `/awr` commands, takes a project over in one click with a restricted reviewer subagent, asks for
checkpoints, reports compactions, suggests evidence and handles forks.

Its interface is for people. The conversation shows one quiet line for what AWR does and nothing for what the
interface asks; the AWR card in the header speaks in plain words and folds every engineering fact; the **Progress** tab
shows the whole project (mainlines, dependencies, lanes) the way AWR's own overview does; and the card checks GitHub for
a newer version of the plugin and installs it. MIT licensed and public ([docs/owner-decisions.md](docs/owner-decisions.md)).
The ledger is `.awr/intake/work-ledger.yaml`.

## Install

In DeepSeek Harness open Plugins, choose Add plugin, and enter `https://github.com/originoneai/dsh-awr`, or from a
terminal:

```sh
dsh plugin --profile <profile> add github:originoneai/dsh-awr#v0.2.0
```

The plugin runs the `awr` CLI of the machine it is on (see [docs/awr-runtime.md](docs/awr-runtime.md)); install AWR
first. The Progress tab needs an awr with `overview snapshot` (0.7.0 has it). The MCP route needs an `awr-mcp` that
contains originoneai/awr#614 (docs/dsh-001-l0-check.md).

**Updating.** DeepSeek Harness's plugin page updates registry packages only, so the plugin's own card does it: the AWR
card in the conversation header has **Check for updates** and **Update**. A plugin installed at a release tag
(`#v0.2.0`) follows newer release tags; one installed from a branch (`#main`, or no `#` at all for the default branch)
follows that branch. The update installs the newest commit pinned (`github:originoneai/dsh-awr#<commit>`) with the
plugin manager, which puts the profile back if it fails ([docs/panel.md](docs/panel.md)).

## Develop

```sh
npm test                                   # package tests, Node's built-in runner, no dependencies
npm run build                              # client.js is generated from client/*.js; a test fails when it is stale
scripts/build-awr-lab.sh <awr-checkout>    # the local AWR this plugin is developed against
```

`client.js` (the part that runs in the browser) is one generated file: edit the parts in `client/` and run
`npm run build`. A running DeepSeek Harness loads a rebuilt `client.js` again without a restart; a change of the host half
(`index.js`, `lib/`) needs one.

- The AWR build used for development and how it differs from the release:
  [docs/lab-environment.md](docs/lab-environment.md).
- Loading the plugin into DSH through a dev profile:
  [docs/dsh-010-skeleton-check.md](docs/dsh-010-skeleton-check.md).
- What DSH offers a plugin, checked against 0.2.2-rc.1: [docs/dsh-surfaces.md](docs/dsh-surfaces.md).
- How the plugin picks and runs `awr`, and when it refuses to: [docs/awr-runtime.md](docs/awr-runtime.md).
- Binding a conversation to an AWR session, and forks: [docs/binding.md](docs/binding.md). The `/awr` command:
  [docs/commands.md](docs/commands.md). The AWR work context in the prompt:
  [docs/prompt-context.md](docs/prompt-context.md). The AWR tools the model can call:
  [docs/tools.md](docs/tools.md). The takeover module: [docs/takeover.md](docs/takeover.md); its button, subagent and panel in DSH:
  [docs/takeover-ui.md](docs/takeover-ui.md); the same takeover through `awr takeover`:
  [docs/takeover-cli.md](docs/takeover-cli.md). The AWR card in the header and updating from GitHub: [docs/panel.md](docs/panel.md). What the conversation shows of AWR:
[docs/conversation-rows.md](docs/conversation-rows.md). The Progress tab: [docs/progress-page.md](docs/progress-page.md). The workflow skill: [docs/skill.md](docs/skill.md). Checkpoint requests: [docs/checkpoints.md](docs/checkpoints.md). Compactions reported to AWR: [docs/compaction.md](docs/compaction.md). Evidence candidates from tool results: [docs/evidence-candidates.md](docs/evidence-candidates.md). Real-model takeover runbook (DSH-022): [docs/dsh-022-runbook.md](docs/dsh-022-runbook.md).

## What the plugin is for

AWR owns project facts, sessions, claims, checkpoints and evidence. DSH owns the model, the UI
and the native conversation. This plugin is the DSH-side bridge between the two. It talks to AWR
only through the `awr` CLI (argv) and the `awr-mcp` server; it never touches `.awr/state.db*`.

DSH conversations are identified to AWR as `--client generic --external-session dsh:<session id>`.
No DSH-specific client dialect is added to AWR.

## Planned capabilities

| Priority | Capability | DSH surface | AWR action |
| --- | --- | --- | --- |
| P0 | Binary selection and self-check | plugin `apply` | Use `cli` from `.awr/runtime-binding.json`, else `awr` on PATH; stop on schema mismatch or migration prompts |
| P0 | One-click project takeover | client slot button (for example `conversation.session.header.actions`) calling a registered command; background child through the `subagents` service | Unattended `init` preview, draft, accept and `intake inspect` loop (see below) |
| P0 | AWR tools for the model | `ctx.tools.register(..., { when })`, project from the conversation binding | `awr_project_status` and a guarded `awr` tool, offered only to bound conversations; a static `awr-mcp` row cannot serve a project per conversation (see [docs/tools.md](docs/tools.md)) |
| P0 | Session binding | event `agent/created` (serial, awaited) | `awr client bind`; bind only, never auto-claim |
| P0 | Context injection | `ctx.systemPrompt.context` (required runtime context), refreshed in `agent/pre-step` | Inject next action, open loops and compiled work context; DSH re-adds it after a compaction |
| P0 | Slash commands | `ctx.commands.register` | `/awr status`, `claim`, `checkpoint`, `end` |
| P1 | Checkpoints | event `agent/turn-stopping` (listener may `agent.steer`) | Ask the model to checkpoint before a turn closes, in its own words (see [docs/checkpoints.md](docs/checkpoints.md)) |
| P1 | Compaction observation | log-only session events `compaction/*` via `session/event` | Report per AWR's context-continuity protocol with the scope and basis DSH gives (`history_only`, `estimated`); no hook before compaction exists (see [docs/compaction.md](docs/compaction.md)) |
| P1 | Workflow skill | `ctx.skills.register` | Teaches reading, claims, checkpoints, expected revisions, preview/accept, evidence and completion (see [docs/skill.md](docs/skill.md)) |
| P2 | Evidence candidates | event `tools/result` | Suggest, never auto-register |
| P2 | Session mapping | none | AWR already stores it (`awr client bind`); forks resume via `--from-session` |
| P2 | Interface | `dsh.client` + slots (`conversation.session.header.actions`, `conversation.view`, `conversation.chat.commandview`) | The header card, the Progress tab and quiet conversation rows, all in plain words (see [docs/panel.md](docs/panel.md), [docs/progress-page.md](docs/progress-page.md), [docs/conversation-rows.md](docs/conversation-rows.md)) |

Every surface above was checked against DeepSeek Harness desktop `0.2.2-rc.1` on 2026-11-11. The
per-surface result, what changed and the evidence are in [docs/dsh-surfaces.md](docs/dsh-surfaces.md).
The AWR build used for development is described in [docs/lab-environment.md](docs/lab-environment.md).

## One-click takeover

Clicking "take over this project" is the only human step. A background subagent then:

1. Preflight: resolve the `awr` binary, read `status`, record Git HEAD, take a lock.
2. Preview: `awr init --json`, with `--write-draft` to a path outside the project.
3. Review the draft: pick the authoritative ledger, choose status/field maps, replace generic
   work with concrete goals, work items, acceptance and next actions, each with provenance.
4. Accept: `init --from-draft ... --accept --expected-preview <fingerprint>`; re-preview if the
   inventory changed (bounded retries).
5. Organize: loop `intake inspect` -> edit sources -> `source reindex` (bounded rounds).
6. Connect the host: MCP, session binding, context injection, `.gitignore` entries.
7. Write a takeover receipt listing what was mapped, created and left for confirmation.

Guardrails:

- Business intent the material cannot establish is recorded as `candidate` /
  `needs_confirmation`, never invented and never asked mid-run.
- Writes are limited to `.awr/` manifest and intake sources by default. Existing ledgers are not
  edited unless the user enabled that option.
- No commit and no push by default.
- Resumable: each step is persisted; a failure before accept leaves the project untouched.
- Hard stops: secret-boundary hits, `source_unreadable`, `Unsupported`, migration prompts, or
  another active session on the project.

A project whose material does not establish its goals ends in `needs_organization`, not `ready`.

## Open questions

- Whether the takeover orchestration lives in this plugin or in the AWR CLI: decided in DSH-040, the CLI. The plugin runs `awr takeover` when its awr has it (DSH-054) and keeps its own implementation for older awr versions.
- Whether DSH subagent permission presets can be narrowed to the takeover allowlist.
- Whether AWR has an "undo takeover" path.
- Whether the takeover can run with no approval prompt under DSH's default permission preset
  (`workspace-write`, approval `ask`).

Answered by [docs/dsh-surfaces.md](docs/dsh-surfaces.md): DSH does expose a blockable pre-tool-call
hook (`tools/pre-execute`, `ctx.tools.guard`), and MCP servers are configured as
`@deepseek-ai/dsh-mcp-client` rows in a bundle patch.

## License

[MIT](LICENSE)
