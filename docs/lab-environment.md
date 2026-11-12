# Local AWR lab environment

The plugin is developed against a locally built AWR, not the released npm package. This page says
what that build contains, how to rebuild it and what was checked about mixing it with the
released 0.7.0. Since 2026-11-12 the build is `origin/main` itself: the fix it once carried on top is merged.

The lab build is experimental. It is not a release, and nothing here replaces the `awr` on `PATH`.

## What it is

`.local/awr-lab/` (ignored by git) holds `bin/awr`, `bin/awr-mcp` and `build.json`.
`build.json` records the source commit, how far it is from `origin/main`, any uncommitted
tracked changes and the binary hashes.

| | Value on 2026-11-12 |
| --- | --- |
| Source | `originoneai/awr` (origin remote `agent-work-runtime`) |
| Baseline | `origin/main` at `037f66c9` |
| On top of it | nothing. The fix for [originoneai/awr#613](https://github.com/originoneai/awr/issues/613) is in `main` (PR [#614](https://github.com/originoneai/awr/pull/614), merged as `71c1acfe`); until 2026-11-12 the lab was `c33ea2be` plus its commit `1b406982` |
| Not included | the owner's local branch `codex/team-p11-cr-fixes` and its uncommitted edit |
| Version string | `awr 0.7.0 (037f66c9)`, `awr-mcp 0.7.0 (037f66c9)` |

Main contains the fix, so DeepSeek Harness connects to `awr-mcp` without a shim (checked on
2026-11-12 with `dsh headless`, `docs/evidence/DSH-004`). The released 0.7.0 does not: the latest
release predates #614. Once a release contains it, the lab build and a stock install should behave
the same for this plugin; `build.json` is how to tell which one a run used.

## Rebuild

```sh
scripts/build-awr-lab.sh <awr-source-checkout> [cargo-target-dir]
```

On macOS the script signs the copied binaries ad hoc, because an unsigned copy can be killed with
exit 137 although its bytes equal the build's. The checkout is built as it is: any branch, including commits that are not on main. To add other
unmerged work, merge or check it out in a separate worktree first, build that worktree and read
`commits_not_on_origin_main` and `uncommitted_tracked_changes` in the manifest. Build from a
worktree, not from a checkout that other people are editing.

## Using it

Call the lab binaries by absolute path, or put `.local/awr-lab/bin` first on `PATH` for one shell.
Do not change the global `PATH` or the Homebrew install.

For DeepSeek Harness, point the `@deepseek-ai/dsh-mcp-client` row at the native binary rather than
the npm launcher. The npm launcher needs `node` on `PATH` and DSH scrubs the environment it gives
a stdio server:

```yaml
- insert:
    - id: mcp-awr-lab
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: awr
        transport: stdio
        command: /absolute/path/to/.local/awr-lab/bin/awr-mcp
        args: ["--project", "/absolute/path/to/project"]
        cwd: /absolute/path/to/project
```

## Mixing it with released 0.7.0

Checked on a disposable project created by the released 0.7.0 (fixture `dsh001-fixture`):

- The lab `awr status` opened it and reported the same project revision (14). The database file's
  size and modification time did not change.
- After the lab binary started and ended a claimed session (revision 14 to 16), the released
  `awr` still read the project, listed no active session and reindexed it with no issues.
- No migration prompt appeared in either direction.

On 2026-11-12, after the lab was rebuilt from `main` at `037f66c9`, it opened this repository's own
project (created by older builds), no migration prompt appeared, and the plugin's 222 tests passed,
including those that run the real `awr`.

This is a few fixtures and a few pairs of builds. It does not show that a later lab build keeps the
schema. Check again after rebuilding from a newer source, and do not point a build with a different
schema version at a project you cannot recreate: the runtime database also holds sessions, claims
and checkpoints that are not rebuilt from sources.

A copy of a project directory placed at a different path is treated as a new project and fails with
`UNIQUE constraint failed: projects.external_key`. That is about the stored project root, not the
binary version.

## Which projects use it

- Disposable fixtures for the plugin's tests: always the lab build.
- This repository's own ledger: the lab build, from 2026-11-12. It is the same schema (14) as the
  released 0.7.0 that created it; see the check above.
