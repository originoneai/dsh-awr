# The AWR state panel (DSH-051)

The **AWR** action in the conversation header (`client.js`, introduced for the takeover in
`docs/takeover-ui.md`) shows, for a project AWR manages, what `awr status` says about it and what this
conversation is doing in it. Code: `lib/state-view.js`; the host command is `/awr state [--json]`.

## What it shows

- **This conversation:** the project's revision, and the AWR session the conversation is bound to with its
  status.
- **Bound work:** the work item (key, title, status), its next action and its blocker, or "no blocker".
- **Claim:** each claim this session holds, with its expiry, or "no expiry", or "This session holds no
  claim".
- **Project:** how many items are in progress, ready and blocked, and the blocked ones with their
  blockers.
- Below that, for a project that was just taken over, the steps and the receipt (DSH-021).

A conversation that is not bound shows the project's counts and lists and says it is not bound.

## Where the numbers come from

Everything is what awr says, passed on as it came; nothing is derived or cached on the DSH side, so the
panel cannot disagree with `awr status` for the same project:

| Shown | From |
| --- | --- |
| project name, revision, counts, the lists, the next action | `awr status` |
| session status | `awr session show <session>` |
| bound work | `awr work show <key>`; the key is the binding's, or for a conversation resumed from an earlier run the compiled context of the session names it (also when AWR calls that context incomplete) |
| claim and expiry | the items of `awr status` that this session claims, then `awr work show <key>` (`active_claims[].expires_at`) |

AWR lists the intake task of a project that still needs organization under "blocked" even though its own
status is `ready` and it has no blocker text; the panel shows the list as AWR gives it.

The panel asks only when it is opened (two command runs, `/awr takeover status --json` and
`/awr state --json`), because every command run is a line in the conversation's timeline.

## Checked

- `test/state-view.test.js` (6 tests): the view with scripted awr output (the bound work, the claim and
  its expiry, the blocked work and its blocker, the four lists, who else claims what, a claim without
  an expiry, a session without claims, an unbound conversation, a work item that cannot be read, a
  conversation resumed without a work key, complete and incomplete contexts); `/awr state` in words and
  as JSON. Against the real awr on a disposable project: the view equals `awr status` for the same
  project (revision, name, counts, the four lists, the next action) when the conversation is bound with
  no claim, after a claim with a TTL (the expiry is `acquired_at + ttl`), after the work is blocked with a
  reason (the blocker shows in the bound work and the blocked list), and after the session ended (no
  claims).
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-051`, web profile in the app browser pane): on a real
  open-source project that had been taken over, the panel showed the bound session, the bound work with
  its next action, the claim with the expiry awr had set (checked to the second), and the project's
  counts and blocked list; after the work was moved to blocked with a reason the panel showed `[blocked]`,
  the blocker text and the same text in the blocked list, equal to `awr status` read from the CLI.

## Not checked

- Several claims at once, and claims by other conversations (the lists mark them; not drawn in the panel).
- A very long list: the panel shows the first six blocked items.
- Updating while the panel stays open: it reads when opened, not on every change in AWR.
- The desktop app (DSH's shell around the same client).
