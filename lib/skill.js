// The skill that teaches the AWR workflow (DSH-032), registered on DSH's skill registry (`ctx.skills.register`),
// where it appears in the catalog the model sees and can be loaded by name with the `skill` tool.
//
// Everything in the body is something the plugin's own work with awr has shown to be so; it is a description
// of how awr behaves, not a rule invented here. The tools it names are the plugin's (docs/tools.md).

export const SKILL_NAME = 'awr-workflow'

export const SKILL_DESCRIPTION = 'How to work in a project managed by AWR (Agent Work Runtime): read the state, claim, checkpoint, preview then accept, expected revisions, evidence and when work may be completed.'

export const SKILL_WHEN_TO_USE = 'Use when the conversation is bound to AWR (the prompt has an "AWR work context" and the awr tools are offered), or the project has a .awr/ directory, before you claim, change, checkpoint or complete work there.'

export const SKILL_BODY = `# Working in an AWR project

AWR keeps a project's work state in source files (the ledger under .awr/intake/ or the project's own ledger and goal files). The SQLite database next to them is only a projection: never edit .awr/state.db*, and never edit AWR's state by any path other than awr.

You reach awr through the \`awr\` tool (\`args\`: the command without "awr"; the project and JSON output are fixed) and \`awr_project_status\`. The user can run the same as /awr status, /awr state, /awr claim, /awr checkpoint and /awr end. The "AWR work context" in your prompt names this conversation's AWR session id and the work it is bound to.

## Read before you write

1. \`status\` first: the project revision, what is in progress, ready, blocked and waiting, and the next action. Read the work with \`work show KEY\` (acceptance, dependencies, blocker, evidence) and \`work prepare KEY\` when you are about to start it.
2. Read the context you were given, not only its completeness flag. A context AWR marks INCOMPLETE says which facts are missing: treat them as unknown, do not fill them in.
3. \`SourceStale\`, \`BudgetExceeded\` and \`ContextIncomplete\` are answers, not obstacles to route around: do what awr's message suggests (reindex, a larger budget it names, record the gap) or tell the user.

## Sessions, claims, checkpoints

- This conversation already has an AWR session. Claiming is separate: \`work claim KEY --session <id> --expected-revision <revision>\` takes the work (with \`--ttl-ms\` for an expiry). A claim is ownership for the runtime, not progress and not completion. Do not take, release or work around another session's claim.
- \`work progress KEY --session <id> --reason ... --next-action ... --expected-revision <r>\` records progress in the source ledger and needs your claim. \`work block KEY --session <id> --reason ... --blocker "<what blocks it>" --expected-revision <r>\` records a concrete blocker (the work must be in progress), \`work unblock\` clears it.
- Checkpoint at meaningful points and before a long step: compile the context for the session (\`context compile --session <id> --budget 5000\`), then \`session checkpoint --session <id> --context-hash <its context_hash> --digest "<what was done>" --next-action "<what is next>" --open-loop "<anything unfinished>" --expected-project-revision <r>\`. Write the digest, next action and open loops yourself from what happened; do not leave them generic. Only true statements: never record a pass, a review or an acceptance that did not happen.
- End the session when you stop for good (\`session end --session <id> --outcome ended|interrupted|incomplete --expected-revision <r>\`). Ending a session does not complete work.

## Expected revisions

Every write takes \`--expected-revision\` (or \`--expected-project-revision\` for a checkpoint): the project revision you read in \`status\`. Read it again right before the write. If awr answers \`RevisionConflict\`, someone else changed the project: read \`status\` again, look at what changed, and decide again. Never retry with a number you did not read, and never force.

## Preview, then accept

Changes that rewrite what AWR manages go in two steps. First the preview: the same command without \`--accept\` (\`init\`, \`work edit\`, \`work create\`, \`batch\`, \`proposal\`). It writes nothing and returns a fingerprint. Read what it would change. Then apply the exact reviewed change with \`--accept\` and the fingerprint it returned (\`--expected-preview\`, and for \`work edit\` also \`--source-fingerprint\`). If anything changed in between, awr refuses and you preview again. \`work edit\` can only change the planning fields of a draft, and not while the work is claimed. Edits to the source files themselves are ordinary file edits followed by \`source reindex\`; quote YAML values that contain "#" (an unquoted "next_action: Follow PR #322" keeps only "Follow PR").

## Evidence and completion

A work item is completed only by \`work complete\`, never by editing its status and never by ending a session. It needs all of: the dependencies done, a verified result for every acceptance criterion, and evidence registered for it.

1. Do the verification yourself and keep the real output. State what was not verified.
2. Write a completion report (JSON, version 1, ending with exactly one newline): \`work_item\`, \`source_sha\` (the full Git commit that was verified), \`command\`, \`scope\` (the paths), \`verified_at\` (epoch milliseconds) and \`checks\`: one entry per acceptance criterion with \`name\`, \`passed\`, \`details\` (what was run, what was seen, the limits) and \`criteria\` (the acceptance text copied exactly).
3. \`work prepare-completion KEY --report <file> --evidence-key <key> --source-sha <sha>\` validates it and returns the evidence record and the completion mapping; it runs nothing and registers nothing.
4. \`evidence add --input <evidence record> --expected-revision <r>\`.
5. If the work is still planned, \`work progress\` first (it must be in progress). Then \`work complete KEY --session <id> --reason "..." --input <completion mapping> --expected-revision <r>\`.

If a criterion cannot be met as written, say so and change the criterion through the proper edit, or leave the work open. Do not complete work whose evidence is a claim.

The prompt may carry "AWR evidence candidates": finished test runs and commits the plugin noticed in this conversation. They are leads. The plugin registers nothing; whether a run verifies a criterion, and what it did not cover, is yours to judge from its output.

## Things awr never does for you here

Never run migrate, downgrade, restore or recover commands, or anything for \`overview\`, \`workspace\`, \`remote\` or \`team\`; the \`awr\` tool refuses them. Put no secrets in sources, reports or checkpoints. Do not commit, push or change files outside the task unless the user asked.
`

/** The definition for `ctx.skills.register`. Offered to the model and to the user. */
export const awrSkill = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  whenToUse: SKILL_WHEN_TO_USE,
  // `content` is the instructions the model gets when it loads the skill; `source` says where the skill is from.
  // DSH rejects a skill without a string for each of them when it is loaded, not when it is registered.
  content: SKILL_BODY,
  source: '@originoneai/dsh-awr',
  invocation: { modelInvocable: true, userInvocable: true },
}

/**
 * Register the skill. The skill registry is an optional service: a profile without it loads the plugin without the
 * skill, and the registration goes when the service does.
 *
 * @param {{ inject?: Function, effect?: Function, skills?: any }} ctx
 */
export function registerAwrSkill(ctx) {
  const mount = (scope) => {
    const register = () => scope.skills.register(awrSkill)
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['skills'], mount)
  else if (ctx.skills?.register) mount(ctx)
}
