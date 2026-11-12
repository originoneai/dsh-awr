# One-click takeover in DSH (DSH-021)

The module (`docs/takeover.md`) does the work; this is how DSH starts it, who reviews the draft, and
where the result is shown. Code: `lib/takeover-host.js` (host), `client.js` (browser), the command in
`lib/commands.js`.

## What the user does

Opens the **AWR** action in the conversation header (it sits with the subagent and job lists) and clicks
**Take over this project**. The panel then shows the steps as they finish, and at the end the receipt:
what the project's files were read as, what was created, the goals that wait for the owner to confirm,
and that nothing was committed or pushed. The same thing is available as `/awr takeover` and
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

`client.js` registers a lazy factory into `conversation.session.header.actions`
(`window.__ModuleLoader__.load`, React from the module table, no build step; `package.json` has
`dsh.client` and the `./client` export). It holds no logic: it runs `/awr takeover` and
`/awr takeover status --json` through `ctx.remote.commands.execute(sessionId, line, [])` and draws the
reply. Text goes through the client locale service (English and Chinese); colors and radii come from
DSH's theme variables; the panel is portaled to the page body and closes on an outside click or Escape.

A command run is a line in the conversation's timeline and an entry in its log, and there is no quiet
way to ask for a state. So the panel asks only when it is opened, after a click, and while a takeover is
running (a growing interval when open, every 10 seconds when closed). A conversation nobody looked at
costs nothing.

## Checked

- `test/takeover-host.test.js` (18 tests) and the changed ones in the other files (144 in all): the
  project of a conversation; the prompt; parsing of the reviewer's answer; the restriction of the next
  child of the expecting conversation and nothing else; the guard (inside the project, symlink out,
  credential files, other tools, other agents untouched); a restriction that fails; the review with a
  fake subagent service (delivery, `request.cwd` outside the project, a missing service, a failing child,
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
- The desktop app. The web profile runs the same plugins and client; the desktop shell around it is DSH's.
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
