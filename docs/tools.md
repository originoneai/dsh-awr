# AWR tools for the model (DSH-012)

A conversation bound to an AWR session is offered two tools. Code: `lib/tools.js`.

| Tool | What it does |
| --- | --- |
| `awr_project_status` | No arguments. The project's name, id, root and revision, the AWR session bound to the conversation, counts of work in progress, ready and blocked, those items with their next actions, and the project's next action. Read-only. |
| `awr` | `args`: an awr command without the program name, for example `["work", "show", "W-1"]`. Runs it for the conversation's project and returns awr's JSON. `--help` or `["help"]` returns the help text as `{ "output": ... }`. |

## Why tools of the plugin and not an `awr-mcp` row

DSH-012 first meant a `@deepseek-ai/dsh-mcp-client` row that starts `awr-mcp`. That row is static: one
server, one project, for every conversation. Two conversations on different projects would need
`awr-mcp --catalog` (originoneai/awr#616, not released), the project registered by hand, the model
passing a `project` argument, and a check that it passed the right one. `tools/pre-execute` cannot
rewrite arguments, so the plugin could only deny a wrong call, not correct it. Tools that the plugin
registers itself take the project from the conversation's binding instead:

- two conversations on different projects cannot reach each other's project, because the model has no
  argument that names one and `--project` is refused;
- they work with the released awr, with no catalog and no registration;
- they use the binary the plugin already pinned and checked (`docs/awr-runtime.md`).

The ledger item was edited to say so (title, summary, next action); its acceptance criteria are
unchanged and are met as written. Stock `awr-mcp` in DSH stays tracked by DSH-004.

## What is refused

- `--project` and `--json` in `args`: the project and the JSON output are fixed. `--project=...` too.
- `overview`, `workspace`, `remote`, `team`: the first lists other projects; the others talk to other
  machines or hold endpoint credentials. The user can run them in a terminal.
- `migrate`, `downgrade`, `restore`, `recover` and their variants: the runner never runs them
  (`docs/awr-runtime.md`).
- A leading `"awr"`, an empty or non-string `args`, more than 40 arguments, an argument over 4000
  characters.

An error from awr comes back to the model with its code, awr's message and awr's own suggested
command, for example `RevisionConflict: revision conflict: expected 5, actual 9`. Output longer than
60000 characters is cut with a line saying how much was cut and to run a narrower command.

## When they are offered

The tools are registered once, with a condition that DSH evaluates for each model step: the
conversation must have an AWR session (`bindings`, `docs/binding.md`). A conversation outside an AWR
project, a subagent, and a conversation whose binding failed are not offered the tools. The check
waits at most 5 seconds for a binding that is still being made.

The header of the prompt context (`docs/prompt-context.md`) names the two tools and the conversation's
AWR session id, which the model needs for `--session`.

## Checked

- `test/tools.test.js` (14 tests): argument checks, the status summary, two conversations on two
  projects each reaching only their own (with `--project` and `overview` refused), pass-through and
  text mode for help, errors with code and suggestion, no tools and no execution for an unbound
  conversation, a binding that never settles, the registered definitions and their disposal. Against
  the real awr on two disposable projects: each conversation sees its own project id, `--project` is
  refused, `work show` and `work --help` work, `runtime restore` never reaches awr, a real `NotFound`
  comes back, and the help text does not make awr look broken for the next call. Mutation checks:
  allowing `--project`, emptying the refused groups, offering the tools to every conversation, running
  in another directory, losing text mode for help, accepting a leading `awr`, and never cutting output
  each fail tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-012/live-dsh.json`; headless dev profile; the
  stand-in model of `scripts/fake-model.mjs`, which calls a named tool and answers with what the tool
  returned): `awr` and `awr_project_status` were in the tool list of a conversation inside an AWR
  project and absent from one outside; `awr_project_status` in two conversations on two projects
  returned each one's own name, id, root and session; the `awr` tool ran `work show INTAKE-001`, returned
  help as text, and refused `--project <other project>`, `overview projects` and `runtime restore`.
  The headless run raised no approval prompt for these calls.

## Not checked

- The desktop app, where the permission preset and the approval policy are the user's. Whether DSH asks
  for approval before each call to a plugin tool there was not observed; the headless run did not.
- A real model choosing and using these tools well. The stand-in calls whatever it is told to.
- `awr` commands that read from stdin or run for a long time; the call is cut at 100 seconds.
- Concurrent calls from one conversation (the tool is not marked concurrency-safe, so DSH runs them one
  at a time).
