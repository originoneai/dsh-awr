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

## Checked

- `test/binding.test.js`, `test/conversation.test.js`, `test/awr-runtime.test.js`: scripted `awr`
  programs, plus the real `awr` on a disposable project (bind, resume, continue after the session
  ended, no claim, a conversation started in a subdirectory). Removing `--from-session` or the reuse
  of an active session fails tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-013`): a new conversation started in a
  subdirectory of an AWR project produced `client generic`, `dsh:<session id>`, one active session on
  `INTAKE-001`, no claim; resuming it with `--session-id` reported `source: resume` and reused the
  same session, leaving one active session.

## Not done

- **Forked conversations.** A fork gets a new DSH session id, so it would be bound as a new
  conversation; carrying the parent's AWR session over with `--from-session` needs the parent's id,
  and no way to create a fork or read its parent was exercised. Tracked as `DSH-016`.
- The desktop app was not used; the check ran the dev profile headless, which creates the agent
  before the model call.
