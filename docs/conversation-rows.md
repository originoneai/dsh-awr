# What the conversation shows of AWR (DSH-060)

DeepSeek Harness records every command run as a row in the conversation and shows the text the command returned; no
plugin can switch that off. The first AWR integration therefore filled the conversation with what its own interface
asked and what the agent did: JSON, revisions, hashes, run logs (35 rows in one test conversation). That is engineering
information, and a person reading the conversation cannot use it.

The plugin now draws its own rows (`client/60-rows.js`, the `conversation.chat.commandview` slot, keyed by the command's
name `awr`), so the conversation holds what a person can read and nothing else.

## What is drawn

| The row of | Is drawn as |
| --- | --- |
| a command of the plugin's own interface: `/awr panel`, `/awr progress`, anything with `--ui` (what the card and the tab run) or `--json` | nothing, whether it succeeded or failed |
| a command a person typed (`/awr status`, `/awr claim`, …) | one quiet line: the first line of the answer, which the host writes in plain words |
| the lines after the first (identifiers, revisions, AWR's own messages) | folded under that line until someone opens them |
| a row an earlier version of the plugin wrote (raw JSON, a sentence with data in a comment, an answer that started with identifiers) | hidden when it is JSON or carries the data comment; otherwise a plain sentence in front of the old text, which is folded whole |

The data the card and the tab need does not travel in any row: it is in files (`docs/panel.md`, `docs/progress-page.md`).
So looking at the project, pressing a button and a whole takeover add no row to the conversation.

A hidden row would still leave the 4 px DeepSeek Harness puts between rows; one rule in the plugin's stylesheet
(`[data-chat-flow-key]:has([data-awr-row="hidden"])`) takes that margin off, so a hidden row leaves no gap either.

## What the commands answer

Every answer starts with a line a person understands, in the language of the interface (the card and the tab append
`--ui zh|en` to what they run; a typed command answers in English), and the technical details follow on the next lines
(`lib/commands.js`: `compose`, `say`, `splitUi`):

- `/awr status` → "3 in progress, 4 ready, 2 blocked" (the totals AWR counts for the whole queue, not the five it lists)
- `/awr claim` → "Claimed “Search endpoint” for this conversation." (the title, read with `work show`; the key and the
  project revision are in the details)
- `/awr checkpoint`, `/awr end`, `/awr takeover`, `/awr update`, `/awr progress` likewise

A refusal reads the same way: a sentence first, then the code and the message AWR gave.

## Not done

- Consecutive old rows are not merged into one folded block. DeepSeek Harness draws each command row on its own and a
  plugin can only replace the row it is asked to draw; merging neighbours would mean reading the page's DOM from the
  plugin, which breaks with the next change of the host. New behaviour produces no rows at all, and old rows are one
  line each.

## Checked

- `test/client-rows.test.js` (9 tests): hidden rows (internal, failed internal, JSON, the data comment), one line for
  a typed command with its details folded, the plain sentence for rows of earlier versions, the running and failed
  states, no identifier visible.
- `test/product-text.test.js` (10 tests): the first line of each command, in both languages, details after it,
  `--ui` taken off the line wherever it stands.
- In the desktop app: the 35 raw rows of a conversation read as eight one-line sentences; a whole takeover and every
  press of a button in the plugin's interface added none.
