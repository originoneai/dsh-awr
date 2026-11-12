# Reporting native compactions to AWR (DSH-031)

Each completed DSH compaction is recorded in AWR through its context-continuity protocol
(`awr session compaction observe`, described in the AWR repository's
`docs/integrations/context-continuity.md`). Code: `lib/compaction.js`.

## What DSH gives

Read from the session events of real compactions (`compaction/*` are log-only events that the plugin follows
through `session/event`; there is no hook before a compaction, `docs/dsh-surfaces.md`):

| Event | Data |
| --- | --- |
| `compaction/start` | `compactionId`, `turn` |
| `compaction/summary` | `compactionId`, `shadowedTokenCount`, `shadowedRange`, `usage` (`inputTokens`, `outputTokens`, `totalTokens` of the summarizing call), `provider`, `model`, `maxTokens`, the summary |
| `compaction/end` | `compactionId`, `turn` |

`shadowedTokenCount` is DSH's own count of the history span that was condensed (the same figure DSH prints:
"compressed 6 history records, about 5569 tokens"). It is **history only** (not the request that is sent), it
is **the condensed span** and not all of the history, and it is **measured by DSH's token meter**, not reported
by the model provider. `usage` is the provider's report for the summarizing call.

What DSH does not give: the size of the request before or after a compaction, the context window, and whether
the user (`/compact`) or the pressure policy started it.

## What is reported, with its labels

| AWR field | Value |
| --- | --- |
| `compaction_id`, `observed_at` | DSH's id; the time of `compaction/end` |
| `sequence` | one more than the latest AWR holds for the conversation's session (read with `session compaction inspect`, then counted), so a restart of DSH continues the series |
| `trigger` | `manual` when a `/compact` command was running (`command/run` to `command/done`) when the compaction started, `automatic` otherwise: the two values AWR accepts |
| `measurement_scope` | `history_only` |
| `measurement_basis` | `estimated` |
| `before_tokens` | `shadowedTokenCount`; absent when DSH gave none |
| `after_tokens`, `context_window_tokens` | **absent**: DSH reports neither |
| `duration_ms` | `compaction/end` minus `compaction/start` |
| `usage` | the provider's input and output tokens for the summarizing call; no cost |
| `source` | says which events it comes from, that `before_tokens` is DSH's own estimate of the condensed history span (history only, not the request, not all of the history), and that no request size after compaction and no window were reported |

So AWR computes no occupancy percentage (it does so only for `full_request` and `host_reported`) and gives no
threshold advice from it; its own words for these observations are "Summary length and cumulative billed
tokens cannot establish occupancy" and, for a manual one, "Manual observation retained separately from
automatic compaction policy". Nothing is inferred from the length of the summary, from billing or from AWR's
own context estimate, and the summary text is never sent. AWR's guidance is not delivered to the model:
for these observations it is "continue the existing workflow". If DSH ever reports full-request figures, the
mapping is where they would be added with `full_request` and `host_reported`.

A conversation that is not bound is not reported (nothing is queued). Reports of one conversation go one at a
time in the order the compactions ended, because the sequence must grow. A report that fails is logged and
does not use up its number. A compaction reported twice under the same id is refused by AWR as a changed
observation and does not disturb the series.

## Checked

- `test/compaction.test.js` (9 tests): the mapping (labels, nothing invented, garbage and negative values dropped,
  the summary text not sent, the explanation in `source`); the file written and removed, the session and
  revision it carries; manual and automatic triggers; the sequence continuing from AWR, growing, not used up
  by a failure; ordering of back-to-back compactions; unbound conversations, unknown ids and garbage events;
  the listener. Against the real awr: what AWR stores for the observation (every field above, `after_tokens`
  and `context_window_tokens` null, no occupancy percentage), a manual one after `/compact`, a restart that
  continues at 3, and a replay of the same compaction that does not disturb the series. Ten mutation checks
  (claiming `full_request`, claiming `host_reported`, inventing `after_tokens`, every trigger automatic,
  the sequence not advancing, a file left behind, no ordering, a restart that restarts the sequence, no
  explanation in `source`, accepting events without a start) each fail tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-031`): `/compact` typed in a conversation of the web profile
  (DSH: "about 5569 tokens") was recorded as sequence 1, `manual`, `history_only`, `estimated`, `before_tokens`
  5569 (the figure DSH printed), 15 ms, no after figure, no window, and AWR reported no occupancy; with the
  compaction threshold forced down in the headless profile, the second run of a conversation compacted twice and
  AWR held sequences 1 and 2, both `automatic`.

## Not checked

- A compaction by a real model: the stand-in's usage figures (10 and 5 tokens) are the numbers it reports.
- A compaction triggered by an overflow error recovery (`automatic` here; DSH does not say it was a recovery).
- Compactions of a conversation resumed after DSH restarted with several compactions behind it, other than in the
  real-awr test with a restarted reporter.
- Delivering AWR's guidance to the model, which would matter only if DSH reported full-request figures.
