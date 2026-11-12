# The AWR workflow skill (DSH-032)

A skill, `awr-workflow`, registered with DSH's skill registry (`ctx.skills.register`, `lib/skill.js`). Its
one-line description is in the catalog the model sees in every conversation; the model loads the full text
with the `skill` tool when it is about to work in an AWR project (`whenToUse`), and the user can invoke
it too (`invocation: { modelInvocable: true, userInvocable: true }`).

## What it teaches

- **Read before you write:** `status` first, then `work show` and `work prepare`; read the context given
  and not only its completeness flag; `SourceStale`, `BudgetExceeded` and `ContextIncomplete` are answers
  to act on, not obstacles.
- **Sessions, claims, checkpoints:** the conversation already has an AWR session; claiming is separate and is
  ownership, not progress; `work progress` needs the claim; how to write a checkpoint (compile the context,
  then `session checkpoint` with the context hash, digest, next action and open loops, written from what
  happened); ending a session does not complete work.
- **Expected revisions:** every write takes the revision read right before; on `RevisionConflict` read again
  and decide again, never force.
- **Preview, then accept:** `init`, `work edit`, `work create`, `batch` and `proposal` preview first, then
  accept with the returned fingerprint; what `work edit` can and cannot change; source edits and `source
  reindex`; the YAML `#` trap.
- **Evidence and completion:** the conditions (dependencies, every acceptance criterion verified, evidence
  registered, work in progress, `work complete` and nothing else), the completion report format, and the
  sequence `work prepare-completion`, `evidence add`, `work complete`.
- **Boundaries:** never edit `.awr/state.db*`, never run migrate, restore, recover or downgrade, nothing
  for `overview`, `workspace`, `remote` or `team` (the `awr` tool refuses them), no secrets in sources.

It names the plugin's tools (`awr`, `awr_project_status`, `docs/tools.md`) and the `/awr` commands.

## It is kept true

Every statement in it is something awr was seen to do while this plugin was built (the claim needed for
`work progress`, the draft-only `work edit`, the in-progress rule of `work complete` and `work block`, the
canonical form of a completion report, `RevisionConflict`, and so on). `test/skill.test.js` runs the real
awr and checks that each command the skill names exists (`<command> --help`), that each option it gives for
it is in that command's help, and that the outcome words are the ones `session end` accepts; a change in awr
that renames one of them fails the test instead of leaving the model with a wrong instruction.

## Checked

- `test/skill.test.js` (5 tests): the definition against what dsh-skill checks when a skill is registered
  and when it is loaded; the four topics of the acceptance criterion and the rest of the list above are in
  the text; registration through `ctx.inject(['skills'], ...)` and without the service; the commands and
  options against the real awr.
- In DeepSeek Harness 0.2.2-rc.1 (`docs/evidence/DSH-032`, web profile): the catalog the model receives lists
  `awr-workflow` with its description, and the `skill` tool loads it by name and returns its text
  (`<skill_content name="awr-workflow">` with all sections). The first attempt failed there with "loaded
  skill source must be a string": a skill needs `content` (the text) and `source` (a label), which the
  registry checks when the skill is loaded, not when it is registered. The unit test now checks both.

## Not checked

- Whether a model that has loaded the skill follows it. The stand-in only shows that the text arrives.
- The skill in the desktop app (same registry), and in a profile without the skill service (the plugin loads
  without the skill; not exercised in DSH).
- How often a model decides to load it; the description and `whenToUse` are written for that and not
  measured.
