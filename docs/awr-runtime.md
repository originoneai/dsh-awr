# Choosing and running `awr` (DSH-011)

`lib/awr-runtime.js` is the only place the plugin starts `awr`. Every other capability calls
`createAwr().run(projectRoot, args)` and gets parsed JSON back, or an `AwrError`.

```js
import { createAwr, explain } from '@originoneai/dsh-awr/awr-runtime'

const awr = createAwr()                       // { env, execFile, timeoutMs } can be injected
const status = await awr.run(root, ['status'])
// runs: <cli> --project <root> --json status   (no shell, cwd is the project)
```

## Which binary

1. If `<root>/.awr/runtime-binding.json` exists, its absolute `cli` is used and the `awr` on `PATH`
   is never started. The file must name an executable. If it carries `cli_sha256`, the file's hash
   must match.
2. Otherwise the first `awr` on `PATH`.

Before the first command for a project the plugin runs the read-only `awr runtime binding` once.
With a binding file, `program_version` and `schema_version` in the file must equal what awr
reports. A project that is not initialized yet has no report; that is allowed so the takeover can
run `init`.

## When it stops

| `error.kind` | Cause | Stops the project |
| --- | --- | --- |
| `missing` | no binding and no `awr` on `PATH`, or the pinned `cli` is absent or not executable | yes |
| `binary_changed` | the pinned `cli` no longer matches `cli_sha256` | yes |
| `version_mismatch` | awr's version differs from the pinned `program_version` | yes |
| `schema_mismatch` | schema differs from the pinned one, or awr says the database is newer or needs an explicit upgrade | yes |
| `unsupported` | `Unsupported`, `ProtocolUnsupported`, `CapabilityUnavailable`, or the plain-text `Unsupported:` form | yes |
| `recovery_required` | `MutationIncomplete`, `WorkActionIncomplete`, `CheckpointIncomplete` | yes |
| `invalid_output` | output is not the documented JSON, or the binding file is unreadable or malformed | yes |
| `forbidden_command` | the command is a migrate, restore, recover or downgrade command | no, refused before it spawns |
| `timeout` | the command did not finish in time | no |
| `failed` | any other awr error, for example `NotFound` or `InvalidInput` | no |

Where awr reports an error: the real awr prints it as a JSON document on **stderr** with a non-zero
exit (`{ "code", "message", "details" }`), and for some failures (`ContextIncomplete`) also puts a
full result with an `error` field on stdout. The runner reads stdout first, then stderr (the document
may follow a warning line), and keeps awr's own `details` untouched as `error.details.awrDetails`, for
example the budget a `BudgetExceeded` needs and the command awr suggests. Before DSH-014 only stdout
was read, so every real awr error was reported as `invalid_output`; the DSH-011 tests used fake awr
programs that printed errors on stdout and did not show it.

`run(root, args, { text: true })` returns output that is not JSON (help text) as `{ output }` instead of
treating it as a broken awr; the model-facing `awr` tool uses it for `--help`.

A stopped project is remembered for the life of the plugin: later calls return the same error
without starting `awr` again. `explain(error)` gives the sentence to show the user. It says that
the plugin does not migrate, restore or downgrade.

## What it never does

It never runs `migrate`, `downgrade`, `restore`, `restore-preview`, `restore-recover`, `recover`,
`create-recover` or `relocate-recover`. Only the first two command words are checked, so a title or
reason containing "restore" is fine.

One limit to know about: AWR's store contains in-place schema upgrades (`schema_migrations` in
awr-store), and the plugin has not been tested against a database older than the binary. It
therefore cannot say when a newer binary would upgrade one. For a project with a binding file the
pinned-version check stops a mismatched binary before any command runs; for a project without one
the plugin can only report the versions it saw. The lab build and released 0.7.0 share schema 14, so
that case has not been exercised.

## Checked

- `test/awr-runtime.test.js`: bound, unbound, missing, version, schema and hash mismatch, unsupported
  in both forms, recovery, forbidden commands, ordinary errors, uninitialized projects, invalid
  output and timeout, against small fake `awr` programs, including errors printed the way the real awr
  prints them (stderr, exit 1). Removing the forbidden-command check, the
  remembered stop, or the binding lookup each fails tests.
- `docs/evidence/DSH-011/real-awr-check.out`: the same module against real binaries: the AWR
  repository's pinned build through its binding file (hash, version and schema matched), the lab
  build and the released 0.7.0 from `PATH`, and no `awr` at all.
