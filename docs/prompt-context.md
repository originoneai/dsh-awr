# The AWR work context in the DSH prompt (DSH-014)

Every model step of a bound conversation carries AWR's compiled context for its work: the work item,
its acceptance, its next action, the open loops and digest of the latest checkpoint, and what changed
since. The model reads it without being told to look anything up.

Code: `lib/prompt-context.js`, mounted by `index.js`.

## What the model sees

A section headed `# AWR work context` inside DSH's runtime-context snapshot, after DSH's own entries
(working directory, file policy, approval policy). It starts with three lines naming the AWR session,
project, work and project revision and saying that AWR is the record and `.awr/state.db*` is not to be
edited; then comes `work_context.rendered_context` from `awr context compile --session <session>
--budget 5000`, unchanged. A context AWR marked incomplete, or one that left optional parts out to fit
the budget, says so in those first lines.

The plugin cuts nothing. Fitting the budget is AWR's job: it keeps whole chunks and reports what it
dropped.

## When it is compiled

DSH asks for the text synchronously before every step, so the plugin compiles ahead of time, in an
awaited `agent/pre-step` listener:

- **First step of a turn:** `awr status` for the project revision. If it equals the revision the cached
  context was compiled at, nothing else runs and the text is the same string as before. If not,
  `awr context compile`.
- **Later steps of the same turn:** the cache is trusted for 30 seconds, so a long tool loop does not
  call awr at every step.
- **After a `/awr` write, or an edit to the ledger:** the next turn's first step sees the new revision.

A refresh is bounded (15 seconds, and the turn's abort signal) and the step always goes ahead: the
listener passes the step on even when awr fails or hangs.

Measured on a small project: `awr status` about 20 ms, `awr context compile` about 90 ms. A turn costs
the first when nothing changed.

## How DSH carries it

DSH appends the runtime context as a snapshot message only when its text differs from the snapshot it
still holds, and a newer snapshot supersedes the older ones ("This snapshot supersedes earlier
runtime-context snapshots"). So an unchanged project adds no tokens after the first turn, a changed one
adds one new snapshot, and the older copies stay in the history until a compaction condenses them.
After a native compaction the snapshot is gone from the retained history and DSH appends the current
one at the next step. The plugin does nothing for this; it relies on registering the text as a
`required` runtime context with `interpolate: false` (compiled text may hold `{{...}}`, which DSH would
otherwise try to resolve).

A conversation that is not bound to AWR work (outside an AWR project, a subagent, a project with no
work) gets nothing.

## When AWR cannot compile

The conversation gets a notice instead of a context, in AWR's own words:

```
# AWR work context unavailable
This conversation is bound to AWR session <id> (project <path>), but its work context could not be
compiled: BudgetExceeded: context budget exceeded: required 660, budget 50
AWR suggests: awr context compile --session <id> --intent work --budget 660
No AWR context is in this prompt until that is resolved. Do not assume what the next action or the
open loops are; tell the user.
```

The same happens for `SourceStale`, `ContextIncomplete` (a ledger AWR cannot read), a missing or
incompatible `awr`, and a failed binding. The previously compiled text is not served while the project
cannot be compiled, and the budget is never raised on AWR's behalf. The cause is also logged as a
warning, and `/awr status` ends with one line saying what the prompt carries.

## Settings

- `DSH_AWR_CONTEXT_BUDGET`: token budget for the compiled context. Default 5000, which is AWR's
  default. A project whose required context needs more is reported as `BudgetExceeded`, with the number
  AWR needs, and the budget is raised by whoever owns the setting.
- `DSH_AWR_TRACE`: see [binding.md](binding.md); the `prompt-context` lines say what was compiled.

## Checked

- `test/prompt-context.test.js` (28 tests): the rendered text, the revision cache and the recheck
  window, per-conversation isolation, a changed session, shared concurrent refreshes, `BudgetExceeded`,
  `SourceStale` and a missing awr, recovery after a failure, the registration fields, the listener
  passing the step on in every failure, a hung awr, and `/awr status`. Against the real awr on a
  disposable project: the work's own next action, then the open loops of a new checkpoint, an unchanged
  project giving the identical text, a ledger broken and fixed again, and a budget AWR cannot meet.
  Mutation checks: dropping `interpolate: false`, the revision cache, the notice for a failed binding,
  `required`, the `next()` call, or the forced refresh at step 1 each fail tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-014/live-dsh.json`, headless dev profile, with
  `scripts/fake-model.mjs` standing in for the model on 127.0.0.1, so what DSH sends could be read):
  1. a new conversation: the model request holds one `# AWR work context` with the work's next action,
     and the stand-in answered with that next action;
  2. the same conversation again, project unchanged: still exactly one copy;
  3. after a checkpoint with an open loop was written: a second, newer snapshot carrying the open loop,
     and the stand-in named it;
  4. with the compaction threshold forced down: DSH condensed the history twice (the summary was the
     stand-in's text, which holds no AWR context), and the request that followed began with the summary
     and a fresh runtime context that again held the AWR work context and the open loop;
  5. with `DSH_AWR_CONTEXT_BUDGET=50`: the notice above reached the model request verbatim.

## Not checked

- The desktop app, and a real model. The stand-in only shows what is sent; whether a model uses the
  context well is not measured.
- `SourceStale` from a real awr: the one real failure that was produced was `ContextIncomplete` (a
  ledger that does not parse); `SourceStale` is covered by a scripted test only.
- Forked conversations and subagents (DSH-016); a subagent has no binding and gets no context.
- A project whose required context is larger than the budget, other than the artificial budget of 50.
- Whether DSH removes older snapshots from a conversation that never compacts; the check above shows
  them staying, superseded by the newer one.
