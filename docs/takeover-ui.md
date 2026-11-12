# One-click takeover in DSH (DSH-021)

The module (`docs/takeover.md`) does the work; this is how DSH starts it, who reviews the draft, and
where the result is shown. Code: `lib/takeover-host.js` (host), `client/*.js` built into `client.js` (browser), the
command in `lib/commands.js`.

## What the user does

Opens the **AWR** action in the conversation header (it sits with the subagent and job lists), or the **Progress** tab,
and clicks **Start taking over**. The card then shows the steps as they finish, and at the end what it did (one line,
"Takeover done · 1 goal, 8 details still to fill in"); the receipt's facts are in the technical details. Nothing is
committed or pushed. The same thing is available as `/awr takeover` and
`/awr takeover status [--json]`. The conversation stays usable the whole time, and when the takeover
completes the conversation is bound to AWR (`bindings.rebind`), so its next step carries the AWR context
and tools (`docs/prompt-context.md`, `docs/tools.md`).

## Host

- **Which project:** the Git top level of the conversation's working directory, else the directory. The
  filesystem root and the home directory are refused. An AWR project is not taken over again; its panel
  says so.
- **In the background:** `start` returns at once with "Started the takeover…" and the run continues; a
  second click while it runs says so. The record lives in the state directory (`docs/takeover.md`), so
  a stopped, failed or interrupted run is shown as such and the button becomes "Continue the takeover".
- **The review:** `createSubagentReview` starts one child of the conversation (`ctx.subagents`,
  provider `spawn`, `delivery: 'caller'` so the conversation gets no completion notice). The prompt
  gives it the draft `awr init` generated, the file inventory and the Git history (it has no shell), the
  rules (no questions, nothing invented, goals at most `candidate`/`needs_confirmation`, provenance in
  every goal), and asks for ONE JSON object with the complete text of each intake file it rewrites. The
  module validates it (same project, same inventory, only text under `.awr/intake/`) and AWR accepts or
  refuses it. A review that fails, takes more than 15 minutes, or returns something unusable stops the
  run with `review_failed` and the project untouched; "Continue" runs the review again.
- **What the reviewer can do:** `read` and `glob`, nothing else, and only inside the project. This is
  stricter than the criterion ("reading files, calling awr and writing the takeover scope"): the host
  calls awr and writes, and the child returns its draft as text, so it needs neither. A guard refuses
  paths outside the project (symlinks resolved), credential files (`.env*`, keys, `.npmrc`, ...: what it
  reads goes to the model provider), and every other tool. `grep` is left out on purpose: it returns
  matching lines, and no guard can keep those from coming out of a `.env` the search covers.
- **Only the four owned files:** AWR accepts exactly `GOALS.md`, `PLAN.md`, `RULES.md` and `work-ledger.yaml` under
  `.awr/intake/`. A real model (DeepSeek-V4.1-Flash, in the desktop app) wrote a `WORK_ITEMS.md` next to `GOALS.md` and AWR
  refused the draft at accept. The prompt now names the four files and says that a project with a ledger of its own (no
  `work-ledger.yaml` in the draft) gets no work items; and `parseReview` drops any other file and says so in the
  receipt's review note, instead of letting the run stop later. If nothing usable is left the review fails with the names.
- **The generated work is kept:** a real model once returned a ledger with `work_items: []`, removing the generated
  intake item; with no work item AWR has nothing to bind a conversation to, so the new conversation got no AWR
  context (docs/evidence/DSH-022/run1-findings.json). The reviewer prompt now says to keep INTAKE-001 unless the
  material names concrete work, and `keepIntakeWork` puts the draft's `work_items:` back when a returned YAML ledger
  has none (not when it has any, and not when other content follows the empty key). The receipt's review note says so.
- **Goals stay the owner's:** whatever the reviewer writes, `status=active` or `confirmed` on a goal is
  lowered to `candidate` (Markdown goal headings and the `goals:` part of a YAML ledger); work items are
  left as the material says.

How the child is recognized: DSH creates it with its parent's working directory and moves it to
`request.cwd` afterwards, so it cannot be told apart by directory. The host says "the next child of this
conversation is a reviewer" before starting it, and the `agent/created` listener (serial, awaited before
the child's first step) restricts the child whose header `parentSession` matches. A listener that throws
fails the child's creation, so a reviewer that cannot be restricted never runs. The first attempt keyed
on the child's directory did not restrict it at all; the live check caught that.

## Client

`client.js` is one file loaded through `window.__ModuleLoader__.load` (React from the module table; `package.json` has
`dsh.client` and the `./client` export). It is **generated**: the source is the parts in `client/` (`10-text.js`
dictionaries, `20-core.js` styles and shared pieces, `30-data.js` the data hooks, `40-popover.js` the header card,
`50-page.js` the Progress tab, `60-rows.js` the conversation rows, `90-tail.js` the registrations), and
`npm run build` (`scripts/build-client.mjs`) writes them in file-name order into the one factory. A test fails when
`client.js` is not what the parts build. The client registers three things: the header card
(`conversation.session.header.actions`), the Progress tab (`conversation.view`) and the renderer of the `/awr` rows
(`conversation.chat.commandview`, `docs/conversation-rows.md`). It holds no logic of AWR: it reads files the host writes
and runs `/awr` commands through `ctx.remote.commands.execute(sessionId, line, [])`, each with `--ui <language>` so the
host answers in the interface's language. Text goes through the client locale service (English and Chinese); colors and
radii come from DSH's theme variables; the card is portaled to the page body and closes on an outside click or Escape.
`remote.pluginManager` (the update, `docs/panel.md`) is an optional service: the client asks for it with
`ctx.inject(['remote.pluginManager'], …)` and shows no Update button without it.

The panel also shows where a stop is (`README.md:1468 (credential)` for a secret-boundary stop), and for a
project AWR manages the work state of `docs/panel.md`.

DeepSeek Harness records every command run as a row in the conversation and shows the text the command returned; no
plugin can switch that off. A first design hid the panel's data in an HTML comment after a sentence (DSH-056); the real
app showed the comment in the row, so the data now does not travel in any command text (DSH-056, finished):

- **The data is a file.** The host writes `<home>/.local/state/dsh-awr/panel/<conversation>.json`
  (`{ version, updatedAt, view, work }`, `lib/panel-snapshot.js`) and the panel reads it through DeepSeek Harness's
  workspace-file service, `ctx.remote.workspaceFiles.read(sessionId, path, {})` (the plugin injects
  `remote.workspaceFiles`; the path is built from `ctx.remote.hostFacts.home`, the same way on both sides). Reading
  writes nothing to the conversation. A file read may name a path outside the workspace; the real app read it with the
  default sandbox.
- **A command is used only when the file cannot do it.** `/awr panel zh|en` makes the host write the file and answers
  with **one sentence** ("Taking the project over · reviewing the draft (step 3 of 6)", `lib/panel-text.js`): that is
  its whole row. The panel runs it when the file is missing or older than 30 s at opening, when someone presses
  Refresh, after an action whose command did not write the file, and once when a running takeover's file has not
  changed for 12 s (the host stopped writing). It never asks with `--json`.
- **The host keeps the file current.** `/awr claim`, `checkpoint`, `end` and `takeover` write it before they answer;
  the awr tools the agent runs write it again 1.5 s after the last command that can change the work (only for a
  conversation whose card or tab was opened); while a takeover runs the host writes it every 2 s until it is no longer
  running. The card reads it every 2.5 s while it is open and a takeover runs. A closed card reads it once, to colour its
  light. The progress file of the Progress tab (`docs/progress-page.md`) is written next to it the same way.
- `inject` has to be the plain list (`['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles']`):
  DeepSeek Harness's client loader does not load a plugin whose `inject` is an object with `optional`. A profile whose
  DeepSeek Harness does not mount `workspaceFiles` therefore does not show the panel at all (0.2.2-rc.2 does).

## Checked

- `test/takeover-host.test.js` (18 tests) and the changed ones in the other files (144 in all): the
  project of a conversation; the prompt; parsing of the reviewer's answer; the restriction of the next
  child of the expecting conversation and nothing else; the guard (inside the project, symlink out,
  credential files, other tools, other agents untouched); a restriction that fails; the review with a
  fake subagent service that fails a start without `parent` as DeepSeek Harness 0.2.2-rc.2 does (delivery, `cwd` outside the project, a missing service, a failing child,
  an unusable answer, a timeout); the controller against the real awr (start returns before the run ends,
  a second start is refused while it runs, the receipt, the conversation rebound, nothing committed; a
  failing review stops the run and the next start resumes it; no subagent service); the lowering of goal
  statuses; `/awr takeover`. Eleven mutation checks (never restricting the reviewer, reading outside the
  project, credential files, any tool, `delivery: 'parent'`, several children per expectation, goals
  confirmed by the reviewer, no rebind, a second start while running, the home directory, no reviewer) each
  fail tests.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-021`), the web profile opened in the app's browser
  pane, `scripts/fake-model.mjs` as the model, a project with two commits and no AWR:
  the AWR action appeared in the header; the panel offered the takeover; one click ran the six steps in
  the background (the panel went from "running" to "done" with the receipt); the reviewer was a child of
  the conversation (it shows in DSH's subagent list) and was offered `glob` and `read` only, read the
  README and the plan, and was refused `/etc/hosts`, the project's `.env` and `bash`; the project ended
  with `.awr/` and `.gitignore`, no commit, and a candidate goal; a message sent in the conversation while
  the reviewer worked was answered at once; afterwards the conversation was offered `awr` and
  `awr_project_status` and its prompt carried the AWR context, marked incomplete with its three gaps.

## Not checked

- A real model as the reviewer: the stand-in reads two files and rewrites the goal from the README. Whether a
  model writes a good draft, and keeps to "nothing invented", is DSH-022.
- The permission preset and approval policy of a real session: the headless and web runs raised no prompt
  for the child's reads or for the plugin's tools.
- The panel in a narrow window, and other languages than English and Chinese (the locale service falls
  back to English).
- A conversation closed while its takeover runs: the reviewer child is cancelled, the run stops with
  `review_failed` and resumes on the next click; not exercised in DSH.

## Repeat the check

```sh
node scripts/fake-model.mjs 18765 /tmp/requests.jsonl &
DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime
PATH="$DSH/bin:$PATH" "$DSH/cli/bin/dsh" dsh-awr-web --from-default-profile web --dump-config >/dev/null
PATH="$DSH/bin:$PATH" "$DSH/cli/bin/dsh" plugin --profile dsh-awr-web add link:"$PWD"
cd <an uninitialized Git project inside a workspace DSH knows> && \
  DEEPSEEK_BASE_URL=http://127.0.0.1:18765 DEEPSEEK_API_KEY=dummy PATH="<lab awr dir>:$DSH/bin:$PATH" \
  "$DSH/cli/bin/dsh" dsh-awr-web --no-open --host 127.0.0.1 --port 18790
```

Open the printed URL, start a conversation in that project, open the AWR action. The web client's "add
workspace" needs a native folder dialog, so the project has to be in a workspace that already exists.

## Checked in the desktop app (DSH-056, DSH-058)

DeepSeek Harness 0.2.2-rc.2 desktop, the plugin installed from its local directory, an awr built from the changed code
(`DSH_AWR_CLI`), the real model (DeepSeek-V4.1-Flash) as the reviewer, the demo project `ui-demo`:

- The conversation shows one row per thing the person did and nothing else. Opening the panel on a file older than
  30 s added one row, "AWR 项目 · 0 项进行中，0 项就绪，2 项阻塞"; opening it again at once added none. Continuing a
  stopped takeover added one row ("Resumed the takeover of …"); the whole run (review by the real model, accept,
  organize, receipt, under a minute) added none, and the panel followed it step by step.
- The takeover ran through `awr takeover` and finished: the reviewer's extra file was dropped, `.awr/` and the intake
  files were created, the receipt said "目标还需要整理；2 个目标，9 个未决缺口".
- Claim, checkpoint and end from the buttons, each one row, the panel updated without asking: claim (after the fix to
  name the session's work), checkpoint (after the fix to save it marked incomplete with its four gaps as open loops,
  as AWR says), end. `awr session show` confirmed the active claim, the checkpoint
  (`01M785HHWFCW5CRYK4NB996PEF`) and the ended session.
- The two refusals the first presses met are in the conversation as readable red lines: "Name the work to claim: /awr
  claim WORK" and "ContextIncomplete: …".

## Checked in the desktop app (DSH-060, DSH-061, DSH-062)

The same setup, the awr rebuilt from all the modified code, the demo project `ui-demo` reset to a plain Markdown TODO and
the real model (DeepSeek-V4.1-Flash) as the reviewer:

- A takeover started from the Progress tab ran in about 20 s (three subagents, "step 3 of 6" on the way) and finished
  without a single row in the conversation; the 35 raw JSON rows of earlier runs read as eight one-line sentences, each
  with its details folded.
- The card and the tab told one story after it: "0 in progress, 0 ready, 2 not ready", "8 details still to fill in", one
  goal waiting for confirmation. (They had not at first: the tab called the two items ready because AWR's dependency
  graph does, and `awr status` counted them blocked because the project is incomplete. The tab now holds ready work back
  while AWR starts none.)
- The 597-item AWR project: the card's numbers are the whole queue (24, 23, 39), not the five listed; the tab drew the
  mainlines, the dependency graph (with the chain of a card picked out) and the lanes, and the detail of a card.
- The plugin installed from a GitHub branch replaced the local link in one step, and **Check for updates** / **Update**
  worked across five commits (`docs/panel.md`).
