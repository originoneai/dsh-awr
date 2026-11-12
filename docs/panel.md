# The AWR card in the conversation header (DSH-051, DSH-052, DSH-061)

The **AWR** action in the conversation header (`client/40-popover.js`, built into `client.js`) is a small light and
the card it opens. It says in plain words how the project stands and what needs the person; every engineering fact
(identifiers, revisions, paths, the `awr` in use) is folded under **Technical details**, closed until someone opens it.
The whole project is on the **Progress** tab (`docs/progress-page.md`), not here.

## What the card shows

For a project AWR manages:

- the project's name and "Managed by AWR", and after a takeover one line of what it did ("Takeover done · 1 goal, 8
  details still to fill in");
- three numbers: **In progress**, **Ready**, **Not ready**. They are what `awr status` counts for the whole queue
  (`current_total`, `ready_count`, `blocked_count`); the lists it also returns are a sample of five each and are not
  counted. The third is red only when something is recorded as blocking work;
- **This conversation is on:** the work the conversation's AWR session is bound to, with its next step or its blocker;
- **Needs you:** work with a recorded blocker, goals nobody confirmed, and, while the project is incomplete, one line
  saying that no work can start until the missing details are filled in. Work that merely is not ready is not listed one
  by one in that case: AWR starts nothing in a project whose goal, acceptance criteria and next steps are incomplete
  (`organization.business_execution_ready` is false), and saying so once is the truth;
- the plugin's version, and for a plugin installed from GitHub **Check for updates** (below).

The light is green when the person has nothing to do, amber when something needs them (a recorded blocker, an
incomplete project, a goal waiting for confirmation), blue while a takeover runs and red where one stopped. A project
AWR does not manage shows the offer to take it over (`docs/takeover-ui.md`).

## No controls for what the agent does

The card has no buttons or fields for claiming work, saving a checkpoint or ending the session. The agent does these
itself through its `awr` tools, and a person who wants to can type `/awr claim`, `/awr checkpoint DIGEST :: NEXT` or
`/awr end ended|interrupted|incomplete`. They were buttons and two text fields in DSH-052; the first real use showed
people asking what to type into them and what a "digest" was, so they were taken out (DSH-061).

## Where the numbers come from

Everything is what awr says, passed on as it came; the card cannot disagree with `awr status` for the same project:

| Shown | From |
| --- | --- |
| name, revision, the queues, the next action | `awr status` |
| the three numbers | `awr status` `current_total`, `ready_count`, `blocked_count` (an older awr that counts none: the length of the list) |
| whether work can start | `awr status` `organization.business_execution_ready`, and the gaps `project_gap_total` |
| why work is held back | `awr status` `blocked[].structural_codes`, kept in the file for the technical details |
| session status | `awr session show <session>` |
| bound work | `awr work show <key>`; the key is the binding's, or for a conversation resumed from an earlier run the compiled context of the session names it |
| claim and expiry | the items of `awr status` that this session claims, then `awr work show <key>` |

The card reads its data from a file the host writes, not from a command (`lib/panel-snapshot.js`), because every command
run is a row in the conversation and no plugin can switch that off. Opening the card on a file written in the last 30 s
leaves nothing in the conversation; the host writes the file again after the agent ran an awr command that can change
the work, and every 2 s while a takeover runs. A closed card reads nothing but, once, to colour its light.

## After the plugin is updated

DeepSeek Harness loads an updated plugin without a restart, and a conversation that was open then has no `agent/created`
for the new instance, so nothing is bound for it. The binding store (`lib/conversation.js`) looks the conversation up in
awr when it holds none (`client show`, `session show`: read-only, an active session only) and keeps what it finds; the
card, the `/awr` commands and the awr tools use it (`lib/binding.js`, `bindingFor`). Without it the card lost the
project's numbers and the agent lost its AWR context until DeepSeek Harness restarted.

## Updating from GitHub (DSH-059)

A plugin installed from GitHub (`github:owner/repo`) keeps the version of its package.json however many commits it has,
and DeepSeek Harness's plugin page updates registry packages only. The card therefore checks and installs itself.

- **Check for updates** asks GitHub (`git ls-remote`, no credentials, no prompt, 10 s) for the newest commit of the
  branch the plugin follows and compares it with the commit the profile's `pnpm-lock.yaml` names. The answer is shown as
  "Update available" with an **Update** button, or "Up to date".
- **Update** has DeepSeek Harness's plugin manager install `github:owner/repo#<newest commit>` (`installBundle`). It
  replaces the dependency in one step and puts the profile back if that fails. Only a spec of exactly that shape is
  ever sent. The result is `applied` (the client and the host are loaded again; the card closes and the plugin is
  as new as the commit), `restart-required` (the card says so) or a failure (said in words; the raw code is in the
  technical details).
- A plugin installed at a **release tag** (`#v0.2.0`) follows the releases: a tag never moves, so the check lists the tags
  (`git ls-remote`, one call) and offers the highest version from the installed one on (a prerelease only to one that is
  itself a prerelease; `v0.10.0` is newer than `v0.2.0`). A commit that is none of the release tags is not called older
  than the newest release, so a plugin somebody installed from a branch by hand is not offered a downgrade.
- The dependency of an updated plugin names a commit, not a branch, so the branch it follows is remembered in
  `<home>/.local/state/dsh-awr/follow.json` (repository and branch, nothing else) and asked at the next check. Without it
  the second check asked the repository's default branch and offered to move the plugin there.
- The host reads the installed commit and version each time it describes itself, and says which version its own process
  loaded. When the files on disk are newer than that, the card says a restart is needed.
- DeepSeek Harness loads the updated plugin while `installBundle` is still answering, so the answer can be lost or arrive
  as an error for an update that went through. The card asks the host after any outcome and does not report a failed or
  running update once the host says the commit that was offered is the one installed. A card that opens on an offered
  update asks the host again, so it does not offer what is installed already.
- A plugin that runs from a folder (a development checkout) or from a registry package offers no update and says why.
- The check and the install run in the host and the client respectively; neither is a command in the conversation (the
  check is `/awr update check --ui <language>`, which the conversation shows as no row).

## Checked

- `test/state-view.test.js`, `test/panel-text.test.js`, `test/product-text.test.js`: the view with scripted awr output
  (bound work, claim and expiry, blocked work and its blocker, the queues and their totals, whether work can start, the
  structural codes, who else claims what, a session without claims, an unbound conversation), and that the typed state
  and status count the whole queue. Against the real awr: the view equals `awr status` for the same project.
- `test/client.test.js`: `client.js` run in a `vm` context against a small stand-in for React (hook state per instance)
  and a stub host that records command lines: the light, the numbers (sample versus total, red only for a recorded
  blocker), the incomplete-project line, that no engineering fact is visible until the details are opened, that there are
  no buttons or fields for the agent's actions, the offer and the running takeover, and the update (check, install,
  the exact spec, a restart, failures, a lost answer, a host still running old code, an offer asked again on opening).
- `test/plugin-update.test.js` (16 tests): the repository and branch in every form pnpm saves a dependency, the commit
  of the lockfile, the commit-pinned dependency that remembers its branch, release tags (the highest version, prereleases,
  a commit that is no release), an install that happened after the check,
  `git ls-remote` without credentials, and that no raw spec (so no credential) reaches the panel.
- `test/conversation.test.js`, `test/panel-snapshot.test.js`: a conversation the instance never bound is found in awr
  without starting or claiming anything, and the panel's data has its work.
- In DeepSeek Harness 0.2.2-rc.2 with the real model (DeepSeek-V4.1-Flash) and an awr built from the modified code
  (`DSH_AWR_CLI`): the card on a taken-over project (the three numbers, the incomplete-project line, the plugin line,
  the technical details), and the host's view of the 597-item AWR project read with the real awr (totals 24, 23 and 39,
  five items in each list); the plugin installed from a GitHub branch, **Check for updates** and **Update** from the card
  across five commits, which found the stale answer, the lost branch and the lost binding fixed above and, in a fourth, the
  lost answer. The lost-answer fix was run with the real `client.js` in a browser against a stand-in host.

## Not checked

- The card in the headless or web profile: the tests use a stand-in for React and a stub host, the desktop app was
  driven by hand.
- The corrected lost-answer handling in the app after the last fix: the failure was seen in the app, the fix has unit
  tests.
- A plugin installed from a registry (`npm`): it offers no update here.
- Several claims at once and claims by other conversations (the lists mark them; the card does not draw them).
