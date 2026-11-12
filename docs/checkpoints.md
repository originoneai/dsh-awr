# Checkpoint requests at turn boundaries (DSH-030)

DSH has no hook before a compaction (`docs/dsh-surfaces.md`), so what a conversation has done is saved ahead
of it, at the end of a turn. Code: `lib/checkpoint-prompt.js`.

## What happens

`agent/turn-stopping` is serial and awaited before a turn closes, and a listener that wants more done calls
`agent.steer(message)`: the loop runs another step. At the end of a **meaningful** turn the plugin steers
once with a user message that asks the model to save an AWR checkpoint with the `awr` tool: compile the
context for its session, then `session checkpoint` with the context hash, a digest, a next action and its
open loops, and then stop.

The digest, the next action and the open loops are the model's, written from the conversation. The plugin
writes none of them and does not run awr at all at a turn boundary (the code has no way to: its only
dependency is the lookup of the conversation's binding). The request says so and says what a checkpoint
must not hold ("no pass, review or acceptance that did not happen"); it also says not to complete or end
anything.

## When

A turn is meaningful when it wrote, edited or ran something (`write`, `edit`, `bash`, `apply_patch`) or
made at least 3 tool calls other than awr's own (`DSH_AWR_CHECKPOINT_MIN_TOOLS`). The request is not made
when:

- the model already saved a checkpoint in this turn (a successful `awr` call of `session checkpoint`,
  seen on `tools/result`) or within 5 minutes (`DSH_AWR_CHECKPOINT_COOLDOWN_MS`); a checkpoint that failed
  does not count;
- the turn was already asked: the checkpoint step is part of the same turn, and its stop does not ask
  again;
- the conversation is not bound to an AWR session or its binding failed;
- `DSH_AWR_CHECKPOINT_PROMPTS=0`.

Counters belong to one turn and start again at each stop. Nothing in the listener can throw into DSH:
a failure is logged and the turn closes as it would have.

## Sessions are not ended or completed by disposal

A conversation going away (`agent/disposed`) only drops what the plugin remembers about it. Nothing in the
plugin ends an AWR session or completes work on its own: `session end` is built only by the user's
`/awr end` (`lib/commands.js`), and `work complete` is never built by the plugin, only run when the model asks for it
through the `awr` tool. `session/disposed` means a session left DSH's store, not that the user is done, and an
ended AWR session cannot be bound again under the same id (`docs/binding.md`); so the session is left active and
the next conversation continues it or starts a successor.

## A finding on the way: incomplete contexts

A project that was just taken over has an incomplete context, and `context compile` then exits with
`ContextIncomplete` and prints the context, its hash and the gaps. The `awr` tool had turned that into an
error text with no hash, so the model could not have saved the checkpoint AWR itself recommends for that
state ("Save a checkpoint marked incomplete and list each gap as an open loop"). The `awr` tool now hands
the model the document awr printed (it says `ok: false` and carries the error, so nothing is hidden).

## Checked

- `test/checkpoint-prompt.test.js` (10 tests): a write, an edit and a command each make a turn meaningful;
  reads count only from three calls, awr's own tools never; counters per turn; the second stop of an asked
  turn; a checkpoint in the turn, a failed one, the cooldown; unbound and failed bindings, an agent that
  cannot be steered; separate conversations, and a failing `steer`, binding lookup or observer not
  reaching DSH; the text of the request (placeholders only, nothing written for the model, frozen message);
  the listeners; that no awr call is made at a boundary; that disposal makes none and that no library file
  but `commands.js` builds a session end or a work complete. Ten mutation checks (asking again in a turn,
  after a checkpoint, ignoring the cooldown, asking after every turn, an unbound conversation, counters
  never reset, a failed checkpoint counting, awr's tools counting, errors reaching DSH, withholding the
  incomplete document) each fail tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-030`, web profile, stand-in model, one read call
  made a turn meaningful through `DSH_AWR_CHECKPOINT_MIN_TOOLS=1`): the first turn of a conversation whose
  project had no work to bind to was decided `not_bound` and left alone; in a bound conversation the turn had
  five steps (read, the request, `context compile`, `session checkpoint`, a reply), the decision was
  `asked`, the second stop of the turn `already_asked`, and AWR held a checkpoint whose digest, next
  action and open loop were the text the stand-in model wrote in its own tool call.

## Not checked

- Whether a real model writes a good checkpoint from the request, and whether it does so for the threshold
  of three tool calls in practice (the stand-in does what it is scripted to do).
- How often a request is worth a step in a long session; the thresholds are guesses and are settings.
- `agent/turn-stopping` of a turn ended by cancellation or an error (DSH does not dispatch it then); those
  turns are not asked about.
- The desktop shell.
