# The takeover module (DSH-020)

Takes a project that has no AWR runtime to an accepted `awr init` and an organization state, with no
question asked on the way. Code: `lib/takeover.js`. It does not use any DSH API: it reaches AWR through
the runner (`lib/awr-runtime.js`, argv only), reads Git's HEAD, and asks its caller for two judgments
through callbacks. DSH-021 supplies them from a subagent; the same module could sit behind an
`awr takeover` command (DSH-040).

```js
const result = await runTakeover({
  awr,                    // createAwr()
  projectRoot,
  stateDir,               // default ~/.local/state/dsh-awr/takeovers (DSH_AWR_STATE, XDG_STATE_HOME)
  review: async ({ draft, draftPath, round, sources }) => reviewedDraft,   // optional
  organize: async ({ organization, summary, round }) => {},                // optional
  adopt: false, allowGitignore: true, maxRounds: 3, maxOrganizeRounds: 3,
  onEvent: ({ step, status, record }) => {},
})
// result.outcome: 'completed' | 'stopped' | 'failed'; result.record; result.receipt; result.runDir
```

## Steps

| Step | What it does |
| --- | --- |
| `preflight` | The directory exists, `awr` is usable, the project has no AWR runtime (an initialized one stops the run, unless `adopt`), and no active AWR session exists. Git's HEAD is noted. |
| `preview` | `awr init` (the preview), then `awr init --write-draft <state>/draft.json`, a file outside the project. |
| `review` | The `review` callback turns the generated draft into the reviewed one, with the same shape: it edits `generated_files` (the goal and ledger sources under `.awr/intake/`) and may change the source mapping. Without a callback the draft is applied as generated. The result is checked: same project, same inventory fingerprint, only text files under `.awr/intake/`. |
| `accept` | `awr init --from-draft` (preview of the reviewed draft), then a check of what it would write, then `awr init --from-draft ... --accept --expected-preview <fingerprint>`. A project that changed while it was reviewed makes AWR refuse the draft; the run goes back to `preview` and `review`, at most `maxRounds` times. |
| `organize` | `awr intake inspect`. While the state asks for organization and an `organize` callback exists, the callback edits the authoritative sources, then `awr source reindex` and another inspection, at most `maxOrganizeRounds` times. Without a callback: one inspection. |
| `receipt` | Written to `<project>/.awr/takeover/receipt.json` and to the state directory: what was mapped, what was created, what was reviewed, the final organization (state, gaps, actions), goals that still await confirmation, and Git before and after. |

A project whose material does not establish its goals ends in `needs_organization`, not `ready`. The
run still completes; that state is the answer. Business intent the material cannot establish stays a
`draft` or `candidate` goal for the reviewer to record as such; nothing is asked during the run.

## What it writes

- **Before accept: nothing in the project.** The preview and `--write-draft` write nothing there; the
  record, the draft and the reviewed draft live in the state directory. A test shows the project
  byte-identical (including `.git`) after a secret, a failing review, a rejected review and a stop from
  the callback.
- **At accept:** `.awr/` and the `.gitignore` entries AWR's own init adds. AWR lists them in its
  preview, and the module refuses to accept when the preview lists any other path outside `.awr/`
  (`unexpected_write`), or `.gitignore` when `allowGitignore` is false. The ledger criterion was
  reworded for this: AWR's init does touch `.gitignore`, which the first wording ("only under .awr/")
  did not allow for.
- **After accept:** the receipt under `.awr/takeover/`.
- **Never:** a commit, a push, or a change to an existing file other than `.gitignore`. Git's HEAD is
  recorded before and after.

## Stops

A run that cannot go on stops with a recorded reason (`record.stop` = `{ step, reason, message, detail }`)
and is not an error of the module. Calling again resumes it.

| Reason | When |
| --- | --- |
| `secret_boundary` | AWR refuses a source because it holds a credential or key. `detail` has the category, the path relative to the project and the line, never the content. |
| `source_unreadable` | A source cannot be read (`source_issues` in the preview, or an unparseable ledger), or the organization state is `source_unreadable`. |
| `unsupported` | An awr command answers `Unsupported`. |
| `migration_prompt` | The runtime asks for a migration or recovery (schema newer than awr, an interrupted write). The module never migrates, restores or downgrades. |
| `active_session` | An initialized project has an active AWR session; `detail` names it. |
| `already_initialized` | The project is initialized (and has no active session) and `adopt` is not set; or it was initialized while the run was in progress. |
| `ambiguous_authority` | AWR found several candidates for a domain (two ledgers, say) and the reviewed draft did not choose. The reviewer is told the domains (`ambiguousDomains`); it chooses by adding the source to `authority_mapping.sources` (`role: primary`) and clearing `ambiguous_domains` in the reviewed draft. Nothing was written. |
| `unexpected_write`, `inventory_changed`, `review_rejected`, `cannot_apply`, `accept_failed_partial`, `accept_incomplete`, `not_a_directory`, `awr_unavailable`, `runtime_changed`, `timeout`, `invalid_output`, `locked`, `awr_error` | The rest of what can go wrong, each named for its cause. A callback can end the run with its own reason by throwing `TakeoverStop(reason, message, detail)`. |

Anything else a step throws is recorded as `unexpected_error` with outcome `failed`.

## Persistence and resuming

The record (`takeover.json`) is rewritten after every step change: each step has `pending` (absent),
`running`, `done`, `skipped`, `stopped` or `failed`, with its result. Calling `runTakeover` again for
the same project continues from the first step that is not `done`; a step that finished is not run
again, and a completed run is returned as it is.

Accept is the step that cannot be repeated blindly, and AWR says its initialization is not atomic
("partial initialization can remain on failure"). The record notes that accept was attempted. If the
project is initialized when the run resumes and accept was attempted, the run recognizes it
(`recovered`) and goes on to the inspection, which reports `source_unreadable` if the result is not
sound. A failure inside accept that leaves an `.awr/` behind stops the run as `accept_failed_partial`
and does not delete anything: there is no undo.

A lock file in the state directory keeps two processes from taking over one project at once, and a
second call in the same process is refused. A lock whose process is gone is taken over.

## Checked

- `test/takeover.test.js` (27 tests), mostly against the real awr on disposable projects with two
  commits: two candidate ledgers (a stop before writing, then a review that chooses one); a Markdown-ledger project and a README-only project taken to an organization state, the
  README-only one to `ready` when the review writes concrete work; the receipt; the project unchanged
  apart from `.awr/` and `.gitignore`, HEAD and commit count unchanged; the five failures before accept
  leaving the project byte-identical; the secret stop with its location and no content in the record;
  both kinds of unreadable source; an active session, an initialized project, `adopt`; Unsupported,
  migration prompts, a changed runtime and a timeout (scripted); a write outside `.awr/`; a project that
  changes during review, with its bound; a partial accept; every awr call of a real run interrupted
  before and after, then resumed to the same files and the same state as an uninterrupted run; a crash
  inside the callbacks; a lost accept answer; a killed accept; locks.
- Twelve mutation checks (no write policy, keeping a stale draft, repeating finished steps, no recovery
  of an attempted accept, accepting a draft for another inventory, ignoring active sessions, accepting
  without the fingerprint, accepting over a project initialized by someone else, no Git HEAD, unbounded
  rounds, no in-process exclusion, no persistence) each fail tests.
- `docs/evidence/DSH-020`: the record and the receipt of one run on a project with history.
- Running the preview on a project with a secret and on one with an invalid source showed AWR's real
  answers, which the stops above are based on: `RuleViolation` with `category=credential`, and a
  preview with `can_apply: false` and `source_issues`, or `InvalidInput` for a ledger that is not YAML.

## Found while building it

- AWR's init adds `.gitignore` entries (and creates the file if there is none): the criterion about
  writes was reworded.
- `awr init --write-draft` refuses to overwrite a draft file; a resumed run removes its own stale draft
  first (found by the interrupt test).
- AWR reports real paths (`/private/var/...` on macOS), so the paths in a stop are made relative with
  both spellings of the project root.

## Not checked

- A reviewer that is a model. The callbacks in the tests are scripted; whether a subagent writes a good
  draft from a real project's README and history is DSH-021 and DSH-022.
- A large project (the scan's own limits apply), and the `--status-map` and `--field-map` options (a reviewer
  can still edit `authority_mapping`, which is where AWR keeps them).
- Windows.
