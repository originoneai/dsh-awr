# Evidence candidates from tool results (DSH-050)

A conversation that runs the tests or makes a commit has produced the raw material of AWR evidence:
`work complete` wants a verified result registered against every acceptance criterion. The plugin
watches the results of the `bash` tool and keeps a short list of the runs that finished cleanly. The
model sees the list in its prompt and the user sees it with `/awr evidence`. It is a **suggestion**:
nothing is registered by the plugin. What a run proves (which criterion, with what limits) is for
whoever read its output, so the model registers evidence with the `awr` tool (the workflow in
[docs/skill.md](skill.md)) or the user does.

Code: `lib/evidence-candidates.js` (what counts, the list, the prompt block), `lib/redact.js`
(credentials in a shown command), `/awr evidence` in `lib/commands.js`, wiring in `index.js`.
`DSH_AWR_EVIDENCE_SUGGESTIONS=0` turns it all off.

## Which results count

A `bash` result is a candidate when its command **ran a test suite or made a commit**, it **finished
in the foreground with exit code 0**, and the conversation is **bound to AWR**.

| Kind | Recognised | Not recognised |
| --- | --- | --- |
| test run | `npm/pnpm/yarn/bun test` and `run test*`, `node --test`, `deno test`, `jest`, `vitest run`, `mocha`, `ava`, `tap`, `npx`/`pnpm exec`/`dlx` of those, `pytest`, `python -m pytest/unittest`, `cargo test`/`nextest run`, `go test`, `make test/check`, `mvn test/verify`, `gradle test/check`, `swift test`, `dotnet test`, `rake test`, `rspec`, `phpunit`, `ctest`, `tox`, `nox`, `playwright test`, `cypress run`; behind `FOO=1`, `env`, `time`, `nice`, `timeout N`, `cd x &&` | `npm install test`, `npm run build`, `echo npm test`, a bare `vitest` (watch mode), `go vet`, `cargo check`, `bash -c '...'`, anything inside `( )`, `$( )` or backticks |
| commit | `git commit` with any global options (`-C`, `-c`, `--no-pager`) and `--amend` | `git commit --dry-run`, `--help`, `git add`, `git push`, `git commit-tree` |

The exit status has to be the runner's own. Reading the command left to right, a command counts only
when everything after it is joined with `&&`, so an overall exit of 0 means it succeeded. A runner
that is **piped** (`npm test | tail`), made harmless with **`||`** (`|| true`), followed by **`;`**
or run in the **background** (`&`, `run_in_background`, a job moved to the background) does not
count. A **failed** run is not a candidate: it is not evidence of a pass. A run that timed out, was
stopped or killed, or an errored call is not one either.

What DSH passes to `tools/result` for `bash` was read live (docs/evidence/DSH-050): `result.value` is
`{ kind: 'foreground', exitCode, signal, timedOut, aborted, stdout, stderr, ... }`, and a non-zero exit
is also printed as `[exit code: N]` after the output (the plugin reads either). A call the tool
rejects has `isError: true`.

A candidate keeps the (trimmed, credential-redacted) command, the runner, the time, and what the output
says about itself when the format is known (node test, jest, vitest, pytest, unittest, cargo, go): the
line is quoted, it is not a verdict. For a commit it keeps the short hash and branch from the line
`git commit` prints, when there is one.

## What is done with them

- **The model.** A second system-prompt context, `awr:evidence-candidates` (order 410, after the AWR
  work context; optional, so DSH may trim it), lists the last 5 candidates and says: these are leads, the
  plugin registered nothing; if one verifies an acceptance criterion of the work, write the completion
  report from what it showed (full commit from `git rev-parse HEAD` as `source_sha`) and register it
  as the workflow skill describes; a run that was not read or did not cover a criterion is not evidence.
  It appears at the next model step after the result, only for a conversation bound to AWR.
- **The user.** `/awr evidence` lists them (up to 20 kept, newest last) and `/awr evidence dismiss`
  clears them. Neither reads or writes AWR state.
- **Settled.** A successful `evidence add` or `work complete` through the `awr` tool clears the list
  (what was suggested has been dealt with); a failed one, or any other awr command, does not. Candidates
  after that start a new list.

## What it does not do

- It never registers evidence, runs awr, or runs anything: the module has no awr runner (a test
  checks the source for it). `evidence add` and `work complete` stay with the model and the user.
- It does not decide that a run covers a criterion.

## Limits

- The list is in memory for the life of the DSH process and the conversation: a restarted DSH, or a
  conversation resumed later, starts empty. AWR holds nothing of it.
- Commands are read as text. Wrapper scripts (`./ci.sh`), `bash -c`, subshells, aliases and runners not in
  the table are not recognised; a recognised runner may have run no test (`npm test` in a package whose
  script is a no-op). The candidate says what the command was, not what it covered.
- A command with credentials is shown with the common shapes redacted (`FOO_TOKEN=`, `--password`,
  bearer and basic authorization, `user:pw@` in URLs, GitHub, OpenAI-style, AWS and Slack tokens); a secret
  written another way is not recognised.
- Subagents' tool results do not produce suggestions (their sessions are not bound).

## Checked

- `test/evidence-candidates.test.js`: the command table above (recognised, look-alikes, `git commit`
  forms, both in one command), exit-status masking (pipe, `||`, `;`, `&`, subshells), results (value or
  marker, timeout, background, error), summaries, the commit line, the list (failed and unfinished runs,
  unbound conversations, other tools, settled by `evidence add` and `work complete` but not by a failed one
  or other commands, dismiss, the bound of 20 and 5, long commands), redaction, that the module cannot reach
  awr, the registration (order, optional, disabled, late `systemPrompt`) and failures never reaching the
  conversation; `test/commands.test.js` and `test/skeleton.test.js` for `/awr evidence` through `index.js`.
  19 mutations (a masked or failed run counted, any tool counted, an unbound conversation shown, a
  failed registration settling, credentials copied, an unbounded list, a required block, dry-run
  commits, background jobs, ...) each fail a test.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-050`), with the stand-in model calling the real `bash`
  tool: a headless task that ran `python3 -m unittest ... && git add -A && git commit` produced two
  candidates (`Ran 2 tests in 0.000s, OK`; commit `c94f649`, matching `git log`); the two model requests
  before the result had no block and every one after it had the block quoted in the evidence file; the model's
  tool calls held no `evidence add`. In the web profile the same run was listed by `/awr evidence`, and
  `/awr evidence dismiss` emptied it. A rejected call (`isError`) and an exit 127 produced none.

## Not checked

- Registration by a real model (a model deciding to register after reading the block): the stand-in does
  not, so the "settled" step is covered by tests, not live. Whether a real model uses the block well is
  not measured.
- The desktop app, and runners other than `python -m unittest` and `git commit` run through DSH's `bash`
  (`node` in that tool's PATH is DSH's own wrapper and exits 127 here).
