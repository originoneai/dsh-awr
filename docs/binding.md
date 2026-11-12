# Binding a DSH conversation to an AWR session (DSH-013)

When DeepSeek Harness creates an agent for a conversation, the plugin binds that conversation to an
AWR session: `awr client bind --client generic --external-session dsh:<conversation id>`. It never
takes a claim.

Code: `lib/conversation.js` (the `agent/created` listener), `lib/binding.js` (what to run),
`lib/project.js` (which project), `lib/awr-runtime.js` (how `awr` is started).

## What happens

1. `agent/created` fires. The plugin reads `agent.session.id` (the conversation id) and
   `agent.session.header.cwd` (its working directory). Both names were confirmed in DSH 0.2.2-rc.1.
2. It walks up from the working directory to the nearest directory with `.awr/project.toml` or
   `.awr/runtime-binding.json`. Outside an AWR project it does nothing.
3. `awr client show` for `dsh:<id>`:
   - no binding: pick the work item to attach to (below) and run `awr client bind`;
   - a binding whose session is **active**: reuse it. This is a resumed conversation
     (`agent/created` with `source: resume`);
   - a binding whose session **ended**: AWR refuses to bind that id again, so the conversation
     continues as `dsh:<id>#2` with `--from-session <ended session>`, then `#3`, and so on.
4. The listener waits for this, at most 10 seconds, so that what runs next can rely on the binding.
   After that the binding finishes in the background. It never throws: a throw in an `agent/created`
   listener would fail the creation of the agent. Failures become a warning.

The mapping is not stored on the DSH side. AWR keeps it and `client show` reads it back.

## Which work item

Binding needs a work item. The plugin takes the first one without a claim from `awr status`:
in progress, else ready, else blocked. A project that was just initialized has only its blocked
intake task, so it binds to that. Binding does not claim, so this only decides which work the
conversation's checkpoints belong to. It is a plugin policy, not an AWR rule.

## Things to know

- **Each new conversation creates an active AWR session** (`agent_id` `generic:dsh:<id>`). AWR limits
  a project to a number of active sessions (AWR's own project shows `Sessions: 20 (limit 20)`), and
  nothing here ends them. Binding at the limit has not been tried; the expectation is that the bind
  fails, the plugin logs the AWR message, and the conversation goes on unbound. Ending the session
  when a conversation closes is not done: `session/disposed` means a session left DSH's store, not
  that the user is finished, and an ended session cannot be resumed under the same id.
- **A desktop app does not get the shell's `PATH`.** The `awr` lookup also checks
  `/opt/homebrew/bin`, `/usr/local/bin` and the per-user `~/.local/bin` and `~/.cargo/bin`.
- **The npm `awr` is a Node script.** DSH puts its own `node` wrapper first on `PATH`, and the script
  then fails (`exec: : not found`). The plugin uses the native binary the launcher would have started
  (`@originoneai/awr-<platform>/bin/awr`), so no `node` is needed.
- **Tracing.** Set `DSH_AWR_TRACE` to a file path to append one JSON line per listener event
  (what the host passed, and the result). Off by default.

## Forked conversations (DSH-016)

DeepSeek Harness has a "Fork session" action (sidebar menu, shift+cmd+F). A fork is a new conversation
that begins with a copy of the parent's history. The plugin binds it like any other new conversation
and, where it can tell which conversation it came from, says so and uses the parent's AWR session.

Code: `lib/fork.js` (which conversation was the parent), `lib/binding.js` (`createFork`),
`lib/conversation.js` (`forkResolver`).

### What DSH says about a fork, and what it does not

Read in DSH 0.2.2-rc.1 (the session controller's `fork` command in `app.asar`) and observed in a live
fork (`docs/evidence/DSH-016/live-dsh.json`):

- The fork is an ordinary session: the same `cwd`, `isSeeded: true`, `inheritedEventCount` set to the
  length of the copy (22 in the live check), and no `parentSession`. That header field is for
  subagents, and `sessionQuery.traceSession` follows only it. The host client's own comment says "the
  fork has no durable source relationship".
- `agent/created` for a fork has `source: startup`, the same as a new conversation, and the listener
  receives a conversation that has already been made, with its history in place.
- Writing a link into the log with `appendPluginRecord` is reserved for DSH's own packages
  (docs/dsh-surfaces.md).

So DSH does not tell the plugin the parent. What a fork keeps is the history: its first
`inheritedEventCount` events are the parent's events, with their times, ids and data.

### How the parent is found

Only for a conversation that has no binding yet and whose session is a fork (`isSeeded`, an inherited
prefix, no `parentSession`). A conversation that is not a fork, or is already bound (a resumed fork),
reads nothing.

1. The inherited prefix of the fork is read through `ctx.sessionQuery` (`observeSession`).
2. Candidates are the other sessions of the same working directory that are not newer than the fork:
   the 10 newest, and the newest session created before the prefix's first event (that finds an old
   parent however many sessions came after it). At most 11 reads (plus the fork's own), each released afterwards.
3. A candidate is the parent when its own history is the prefix: every inherited event is deeply equal
   to the candidate's event at the same position (not a guess from names or times), and the candidate
   holds the last inherited event as its own, not as something it inherited from an earlier parent.
   A fork of a fork cut inside the inherited part therefore names the session that made those events.
4. Exactly one such candidate names the parent. None, more than one, or a failing lookup names no
   parent, and the fork is bound as a new conversation, as before.

A parent outside the candidates is not found: a fork of a fork whose own parent is old and not among
the 10 newest sessions of the directory is the case. The fork is then bound as a new conversation.

### What the binding does with the parent

`--from-session` is a resume: in AWR the predecessor session is marked `interrupted` and its claims are
closed (checked against the real awr, in `test/binding.test.js`). That is what a continuation after an
ended session is for, and it is wrong for a parent conversation that is still going. So, by the state
of the parent's newest AWR session (its generations are followed as above):

| The parent's AWR session | The fork's binding | `fork.mode` |
| --- | --- | --- |
| **ended** | a new session with `--from-session <parent's session>`: AWR carries the recorded context over, `session show` on the parent lists the fork's session as `resumed_successor`; no claim | `continued` |
| **active** | its own session, on the work the parent has claimed if it holds a claim (else the usual choice); the parent's session and claim are not touched | `parent_active` |
| none (never bound) | its own session | `parent_unbound` |
| `--from-session` refused by awr | its own session, with the reason | `continuation_failed` |
| the parent's binding cannot be read | its own session, with the reason | `lookup_failed` |

The outcome is in the binding result (`fork: { parentConversation, parentSession, mode, reason? }`),
the trace (`DSH_AWR_TRACE`: `fork-parent`, then `bound`), `/awr status` (one line saying what it is) and
the "AWR work context" of the prompt (the same sentence, so the model knows the parent's session may hold
progress this one does not).

The change to the acceptance text of DSH-016 follows from this: "bound with from-session pointing at the
parent's AWR session" holds for a parent whose session has ended. For a parent that is still active
it would have interrupted the parent's session and closed its claim, so that fork gets its own session.

## Checked

- `test/binding.test.js`, `test/conversation.test.js`, `test/awr-runtime.test.js`: scripted `awr`
  programs, plus the real `awr` on a disposable project (bind, resume, continue after the session
  ended, no claim, a conversation started in a subdirectory). Removing `--from-session` or the reuse
  of an active session fails tests.
- Forks (`docs/evidence/DSH-016`): `test/fork.test.js` (the lookup against a stand-in for `sessionQuery`: the
  owner, a fork of a fork, an old parent, ambiguity, the same times with different data, failures, released
  reads), `test/binding.test.js` (every mode, scripted, and against the real awr: a live parent keeps its
  session and claim, an ended parent shows the fork as `resumed_successor`, a never-bound parent),
  `test/conversation.test.js` (the listener, a host without the service, a failing lookup, a resumed fork).
  14 mutations (continue a live parent, no fallback, first generation, any claim, match by time only, no
  ownership check, first of several, a subagent as a fork, a hidden note, ...) each fail a test. In
  DeepSeek Harness 0.2.2-rc.1 (web profile, stand-in model): a conversation answered a message and was
  bound; forked with shift+cmd+F it was bound as `parent_active` (the parent's AWR session stayed active)
  and `/awr status` said so; after `awr session end` on the parent's session, forking it again was bound as
  `continued`, and `session show` on the parent named the fork's session as `resumed_successor`.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-013`): a new conversation started in a
  subdirectory of an AWR project produced `client generic`, `dsh:<session id>`, one active session on
  `INTAKE-001`, no claim; resuming it with `--session-id` reported `source: resume` and reused the
  same session, leaving one active session.

## Not done

- A live fork of a parent the plugin never bound: the web client binds a conversation as soon as it is
  opened, so it needs a session made without the plugin. That mode is covered by scripted tests and the
  real awr.
- Forks in the desktop app: the fork action is the same host command, but only the web profile was used.
- No link is stored on the DSH side. A fork whose parent was not found is not recorded as one afterwards.
- The check in `docs/evidence/DSH-013` ran the dev profile headless, which creates the agent before
  the model call. The desktop app was used later, for DSH-015 (`docs/evidence/DSH-015`): a new
  conversation there was bound too (`/awr status` reported the bound AWR session, and `client show`
  returned the binding for its `dsh:<session id>`).
