# DSH-001: AWR L0 check on a real DeepSeek Harness install

Checked on 2026-11-11 (local time, UTC-5). Raw material is in `docs/evidence/DSH-001/`.

## Result

| Acceptance criterion | Result |
| --- | --- |
| DSH version, install source and check date recorded | Met (this page) |
| Session start, context compile, checkpoint and end succeed from a DSH conversation, receipts retained | Met |
| `awr-mcp` connected to DSH and `awr_project_status` returns the project identity | **Met with the lab build** (main plus the fix for originoneai/awr#613), no shim. **Not met with stock `awr-mcp` 0.7.0**; that is tracked as `DSH-004` until the fix is merged and released |

The first pass on 2026-11-11 used stock `awr-mcp` 0.7.0 and failed the third criterion; that run and
its diagnosis are kept below. The rerun on the lab build ([lab-environment.md](lab-environment.md))
is in "Rerun on the lab build".

## What was installed

- DeepSeek Harness desktop app `0.2.2-rc.1` (`com.deepseek.dsh`), macOS arm64, installed by the owner
  from `deepseek-harness-0.2.2-rc.1-mac-arm64.dmg`. The app's update feed is
  `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/`, channel `nightly`. Where the dmg was
  downloaded from was not observed.
- The app bundles a CLI at `Contents/Resources/runtime/cli/bin/dsh` (same version) and Node 24.21.0.
  `dsh` is not on `PATH`.
- Model used: `deepseek-flash` through the signed-in account provider (shown as DeepSeek-V4.1-Flash).
- AWR: `awr` and `awr-mcp` 0.7.0 from Homebrew's npm prefix (`/opt/homebrew/bin`).
- Fixture: a disposable AWR project at `~/Documents/deepseek-harness/dsh001-fixture`, project id
  `01M76X7RPD0C8WNTE0AX7JTJ7V`, with one ready task `EXAMPLE-001`.

## Session workflow from a DSH conversation

Two desktop conversations were run in the fixture workspace. The model ran each `awr` command through
DSH's `bash` tool. Outputs are in `docs/evidence/DSH-001/receipts/`.

| Step | Receipt | Outcome |
| --- | --- | --- |
| `session list --active` | `01-session-list.json` | ok, revision 8 |
| `status` | `02-status.json` | ok, project id as above |
| `session start --claim` | `03-start.json` | session `01M76XB00R2JSFX65ENS6GRMF7`, claim active, revision 9 |
| `context compile` | `04-context.json` | complete, context hash `e6c318a6…64155a` |
| work | — | `hello.txt` created |
| `session checkpoint` | `05-checkpoint.json` | checkpoint `01M76XB6CTQ3FQEFK2MS2M7HEM`, revision 11 |
| `session end --outcome incomplete` | `06-end.json` | session incomplete, revision 12 |
| second conversation: `session start` / `session end` | `08-…`, `09-…` | ok, revisions 13 and 14 |

The receipts and the final state were checked from outside DSH with the `awr` CLI: no active session
remains and the revisions match.

### Sandbox

- New desktop conversations start in preset `workspace-write` with approval policy `ask`.
- The whole second conversation ran in `workspace-write`. No `awr` command was blocked or needed
  approval, including writes to `.awr/state.db`.
- During the first conversation the session log records a `/permission danger-full-access` command
  with source `user` seven seconds into the turn, after step 3. It was not issued by the test driver.
  Steps 4 to 7 of that conversation therefore ran with full access; the second conversation covers the
  same kinds of writes under `workspace-write`.

## MCP

DSH 0.2.2-rc.1 has no MCP settings page. A server is added as an entry of
`@deepseek-ai/dsh-mcp-client` in the profile's `cordis.patch.yml`
(`docs/evidence/DSH-001/mcp/cordis.patch.entry.yml`), and the app must be restarted. The entry was
added to the desktop profile for this check and removed afterwards; the file was restored byte for
byte from a backup.

Findings, in the order they were hit:

1. **Scrubbed environment.** DSH starts stdio servers with a scrubbed environment. The npm launcher
   `/opt/homebrew/bin/awr-mcp` starts with `#!/usr/bin/env node`, and `node` was not found. Setting
   `env.PATH` in the entry fixed this. A plugin should start the native binary or supply `PATH`.
2. **`tools/list` result rejected.** DSH's MCP client speaks protocol `2026-07-28`: it sends
   `server/discover`, then `tools/list`, with no `initialize`. `awr-mcp` 0.7.0 answers both, but
   DSH's SDK rejects the `tools/list` result because `ttlMs` (number) and `cacheScope`
   (`public` or `private`) are missing. `awr-mcp` sends those two fields on `server/discover` only.
   DSH reports `mcp-client(awr): server is disconnected` to the model and retries with backoff.
   The exact error is in `mcp/headless-startup-error.txt`; the unmodified exchange is in
   `mcp/mcp-in.unshimmed.log` and `mcp/mcp-out.unshimmed.log`.
3. **With a shim, the path works.** `mcp/mcp-shim.py` adds the two fields to `tools/list` results and
   changes nothing else. With it the connection stays up, DSH exposes the tool as
   `mcp__awr__awr_query`, and a call with `{"child_tool": "awr_project_status"}` returned project id
   `01M76X7RPD0C8WNTE0AX7JTJ7V` at revision 14, matching the CLI. `tools/call` results needed no
   change. The exchange is in `mcp/mcp-in.log` and `mcp/mcp-out.log`.

`awr-mcp` 0.7.0 exposes eight grouped tools (`awr_query`, `awr_context`, `awr_work`, `awr_evidence`,
`awr_session`, `awr_continuity`, `awr_change`, `awr_compaction`). There is no top-level
`awr_project_status` tool; it is a child of `awr_query`.

## Other observations useful for later work

- The headless profile (`dsh headless "task"`) cannot use the desktop account sign-in. It needs
  `DEEPSEEK_API_KEY`; with the account provider it fails with `ACCOUNT_SIGN_IN_REQUIRED`. It is still
  useful without a key for loading a patch and reading plugin activation errors.
- `dsh desktop --dump-config` is refused: the desktop profile is managed by the Electron app.
- DSH did not add a workspace under `/private/tmp`; a folder under `~/Documents` was accepted.
- Session logs are `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`. Observed event types
  include `permission/preset`, `sandbox/mode`, `approval/policy`, `turn/start`, `turn/end`,
  `step/start`, `step/end`, `tool/call`, `tool/result`, `command/run`, `command/done`,
  `user/message`, `assistant/message`, `request/header`, `request/context` and `workspace/changes`.
- The DSH local port answers `401` without the URL token; it was not used.

## Not covered

- Whether the same `tools/list` rejection happens over streamable HTTP.
- Whether the requirement for `ttlMs` and `cacheScope` on `tools/list` comes from the 2026-07-28
  specification or only from DSH's bundled SDK.
- Compaction, plugin loading and every surface listed in the README. Those belong to `DSH-002`.

## Rerun on the lab build

Environment: `awr-mcp 0.7.0 (1b406982)` built from `origin/main` (`c33ea2be`) plus the one commit
that fixes #613; see [lab-environment.md](lab-environment.md) and
`docs/evidence/DSH-001/mcp/lab-build.json`. DSH desktop `0.2.2-rc.1`, same fixture project
`dsh001-fixture`.

1. **DSH's own MCP client, startup check.** With `failOnStartupError: true`, a stdio entry for the
   lab binary activates. The same entry for the released 0.7.0 native binary fails with
   `1 entry did not activate` (`mcp/headless-fixed-binary-stderr.txt`,
   `mcp/headless-old-binary-stderr.txt`, entry in `mcp/headless-probe.patch.yml`).
2. **Desktop conversation, no shim, no wrapper.** The entry was added to the desktop profile
   (`serverName: awr`, `command` the native `awr-mcp`, `args` and `cwd` the fixture). The server
   process stayed up. In a new conversation under `workspace-write`, the model called
   `mcp__awr__awr_query` with `{}` (the manifest) and then with
   `{"child_tool": "awr_project_status", "arguments": {}}`. The second result held project id
   `01M76X7RPD0C8WNTE0AX7JTJ7V` and revision 16, equal to what the CLI reported at that moment
   (`mcp/lab-run-no-shim.json`, extracted from the DSH session log).
3. The profile file was restored byte for byte afterwards and DSH relaunched.

Not covered by the rerun: streamable HTTP, and a stock released `awr-mcp` containing the fix.
