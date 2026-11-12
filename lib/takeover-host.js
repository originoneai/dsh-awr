// The DSH half of the takeover (DSH-021): starts lib/takeover.js in the background for the project of a
// conversation, supplies its draft review from a subagent that can only read, and reports the state and
// the receipt in a form the client panel and the /awr command show.
//
// The subagent is a child of the user's conversation (it shows in DSH's subagent list), started with
// `delivery: 'caller'` so the conversation is not interrupted. Its tools are restricted to `read`, `glob`
// and a guard keeps those inside the project, and it answers with the reviewed intake files as
// JSON in its final message. Nothing is written by it: the module validates what it returns and AWR
// accepts it, so the project is byte-identical until accept (docs/takeover.md).
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { findProjectRoot } from './project.js'
import { STEPS, TakeoverStop, defaultStateBase, runDirFor, runTakeover } from './takeover.js'

/**
 * The only tools the reviewing subagent keeps. `grep` is not one of them: it returns the matching lines, and a
 * guard cannot keep those from coming out of a `.env` file the search happens to cover, while `read` can be
 * refused by path and `glob` returns names only.
 */
export const REVIEW_TOOLS = ['read', 'glob']
export const REVIEW_MARKER = '[AWR-TAKEOVER-REVIEW]'
const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60_000
/** Files the reviewer is not given, whatever the project says: what it reads goes to the model provider. */
export const SENSITIVE_FILE = /(^|[\\/])(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|credentials?(\.[^\\/]*)?|secrets?(\.[^\\/]*)?)$/i

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function git(root, args) {
  return new Promise((done) => {
    execFile('git', args, { cwd: root, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error ? '' : String(stdout).trim()))
  })
}

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The project a conversation would take over: the Git top level of its working directory, else the
 * directory itself. A directory that is too broad (the filesystem root or the home directory) is refused.
 *
 * @returns {Promise<{ root?: string, initialized?: boolean, refused?: string }>}
 */
export async function takeoverRootFor(cwd, { home = homedir() } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { refused: 'This conversation has no working directory.' }
  const existing = await findProjectRoot(cwd)
  if (existing) return { root: existing, initialized: true }
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top ? real(top) : real(cwd)
  if (root === '/' || root === real(home) || root.split('/').filter(Boolean).length < 2) {
    return { refused: `${root} is too broad to take over; open the conversation in the project's own directory.` }
  }
  return { root }
}

/** Recent history, for the reviewer: it has no shell, so the host reads it. */
export async function gitHistory(root, limit = 40) {
  const log = await git(root, ['log', `-n${limit}`, '--date=short', '--format=%h %ad %s'])
  const count = await git(root, ['rev-list', '--count', 'HEAD'])
  return log ? `${count ? `${count} commits; ` : ''}newest first:\n${log}` : ''
}

export function buildReviewPrompt({ root, draft, history }) {
  const draftView = {
    generated_files: draft.generated_files,
    sources: (draft.authority_mapping?.sources ?? []).map((s) => ({ domain: s.domain, role: s.role, path: s.path, adapter: s.adapter })),
    ambiguous_domains: draft.ambiguous_domains ?? [],
    gaps: draft.gaps ?? [],
  }
  const files = (draft.inventory ?? []).slice(0, 200).map((f) => `${f.path} (${f.bytes} bytes)`).join('\n')
  return [
    REVIEW_MARKER,
    `You are reviewing an AWR (Agent Work Runtime) intake draft for the project at ${root}.`,
    'You can only read files (read, glob) under that directory. You cannot change anything and nobody is available to answer questions, so do not ask any.',
    '',
    'Task: replace the generic placeholder goal and work in the draft with what the project\'s own material establishes (its README, docs, plans, ledgers and the history below), and nothing more.',
    '',
    'Rules:',
    '- A goal needs a title, a summary that names the files it comes from ("Provenance: README.md, docs/plan.md"), and success criteria that can be observed. Use status=candidate when the material states the purpose, status=needs_confirmation when you inferred it. Never use active or confirmed: only the owner confirms a goal.',
    '- Work items only for work the material names (milestones, TODOs, open items). Each needs kind, status, goal (the goal id), acceptance (observable) and next_action. Use status planned unless the material itself says the work is done; say that as the material states it, it is not verified.',
    '- Never invent business intent, owners, dates or completion. What the material does not establish stays a placeholder or needs_confirmation.',
    '- Do not read or copy secrets, tokens, keys or personal data; .env files and key files are not available to you.',
    '- Existing ledger files (for example TODO.md) stay authoritative and are not edited; you only write the intake files listed in the draft. Quote YAML values that contain "#" or ": ".',
    '',
    'Reply with ONE JSON object in a ```json fence and nothing after it:',
    '{ "generated_files": { "<a path from the draft>": "<the complete new text of that file>" }, "notes": "<at most three short sentences: what you based it on and what stays unconfirmed>" }',
    'Keep the paths of the draft\'s generated_files; the text must be in the same format as the draft shows.',
    '',
    '<draft>',
    JSON.stringify(draftView, null, 1),
    '</draft>',
    '',
    '<files>',
    files || '(none listed)',
    '</files>',
    '',
    '<history>',
    history || '(no Git history)',
    '</history>',
  ].join('\n')
}

/** The text of a subagent's result, whatever shape DSH gives it. */
export function resultText(result) {
  const output = result?.output ?? result?.text ?? result
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  return ''
}

/**
 * Goals are the owner's to confirm. Whatever the reviewer wrote, a goal in the intake files is at most a
 * candidate: `status=active`/`confirmed` in a Markdown goal heading and `status: active`/`confirmed` in the
 * `goals:` part of a YAML ledger are lowered to `candidate`. Work items are not touched (`work_items:` and
 * everything after it). Returns the files and how many statuses were lowered.
 */
export function capGoalStatuses(files) {
  let lowered = 0
  const out = {}
  for (const [path, text] of Object.entries(files)) {
    let next = text
    if (/\.md$/i.test(path)) {
      next = text.replace(/(\{#[^}\n]*?\bstatus=)(active|confirmed)\b/gi, (_, head) => ((lowered += 1), `${head}candidate`))
    } else if (/\.ya?ml$/i.test(path)) {
      const cut = next.search(/^work_items\s*:/m)
      const goals = cut === -1 ? next : next.slice(0, cut)
      const rest = cut === -1 ? '' : next.slice(cut)
      next = goals.replace(/^(\s*(?:-\s+)?status\s*:\s*)(["']?)(active|confirmed)\2[ \t]*$/gim, (_, head, quote) => ((lowered += 1), `${head}${quote}candidate${quote}`)) + rest
    }
    out[path] = next
  }
  return { files: out, lowered }
}

/** The reviewed draft from the reviewer's final message, or a TakeoverStop that says what was wrong. */
export function parseReview(text, draft) {
  const fenced = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/gi)].at(-1)?.[1]
  const candidate = fenced ?? String(text ?? '').slice(String(text ?? '').indexOf('{'), String(text ?? '').lastIndexOf('}') + 1)
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new TakeoverStop('review_failed', 'The reviewer did not return a JSON object with the reviewed intake files.')
  }
  const files = parsed?.generated_files
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    throw new TakeoverStop('review_failed', 'The reviewer\'s answer has no generated_files.')
  }
  const capped = capGoalStatuses(files)
  const notes = [typeof parsed.notes === 'string' ? oneLine(parsed.notes).slice(0, 600) : '', capped.lowered ? `${capped.lowered} goal status(es) the reviewer set to active or confirmed were lowered to candidate: only the owner confirms a goal.` : ''].filter(Boolean).join(' ')
  return { draft: { ...draft, generated_files: { ...draft.generated_files, ...capped.files } }, ...(notes ? { notes } : {}) }
}

/**
 * Restricts the reviewing subagent and keeps it inside its project.
 *
 * A child is created with its parent's working directory (DSH moves it to `request.cwd` afterwards), so it
 * cannot be told apart by directory. `expect(parentSessionId, root)` says that the next child of that
 * conversation, created while its start is awaited, is a reviewer; `restrict(agent)` (the `agent/created`
 * listener) then claims it. A listener that throws fails the child's creation, so a reviewer that cannot be
 * restricted does not run.
 */
export function createReviewerPolicy() {
  /** @type {Map<string, { root: string, claimed: boolean }>} parent session id -> the review being started */
  const expected = new Map()
  /** @type {Map<string, { root: string }>} child session id -> its project */
  const reviewers = new Map()
  const inside = (root, path) => {
    const resolved = real(isAbsolute(path) ? path : join(root, path))
    const rel = relative(real(root), resolved)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  const parentOf = (agent) => {
    const parent = agent?.session?.header?.parentSession
    return typeof parent === 'string' ? parent : parent?.id
  }
  return {
    /** A review is about to start for a child of `parentSessionId`. Returns the function that ends the expectation. */
    expect(parentSessionId, root) {
      expected.set(parentSessionId, { root, claimed: false })
      return () => expected.delete(parentSessionId)
    },
    /** The session ids of the reviewers that are restricted now. */
    reviewers: () => [...reviewers.keys()],
    forget: (childSessionId) => reviewers.delete(childSessionId),
    /** `agent/created`: keep only the reading tools for the reviewer being started. Returns whether `agent` is one. */
    restrict(agent) {
      const wait = expected.get(parentOf(agent))
      if (!wait || wait.claimed) return false
      wait.claimed = true
      agent.ctx.tools.restrict({ allow: REVIEW_TOOLS })
      reviewers.set(agent.session.id, { root: wait.root })
      return true
    },
    /** `ctx.tools.guard`: a reason to refuse the call, or undefined. */
    guard(exec) {
      const reviewer = reviewers.get(exec?.agent?.session?.id)
      if (!reviewer) return undefined
      if (!REVIEW_TOOLS.includes(exec.name)) return `The takeover reviewer may only use ${REVIEW_TOOLS.join(', ')}.`
      const args = exec.arguments ?? {}
      const target = exec.name === 'read' ? args.file_path : (args.path ?? reviewer.root)
      if (typeof target !== 'string') return 'A path is required.'
      if (!inside(reviewer.root, target)) return `The takeover reviewer may only read inside ${reviewer.root}.`
      if (exec.name === 'read' && SENSITIVE_FILE.test(target)) return 'That file may hold credentials and is not available to the takeover reviewer.'
      return undefined
    },
  }
}

/**
 * The review callback of `runTakeover`, answered by a subagent.
 *
 * @param {{ getSubagents: () => any, policy: ReturnType<typeof createReviewerPolicy>, stateBase: string, timeoutMs?: number, trace?: Function }} deps
 * @param {{ parent: any }} call the conversation whose child the reviewer is
 */
export function createSubagentReview({ getSubagents, policy, stateBase, timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS, trace }, { parent }) {
  return async ({ projectRoot, draft }) => {
    const subagents = getSubagents()
    if (!subagents?.startActivation) throw new TakeoverStop('review_unavailable', 'This DeepSeek Harness profile has no subagent service, so the draft cannot be reviewed.')
    const reviewDir = join(runDirFor(projectRoot, stateBase), 'review')
    await rm(reviewDir, { recursive: true, force: true })
    await mkdir(reviewDir, { recursive: true })
    const endExpectation = policy.expect(parent?.session?.id, projectRoot)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('the review took too long')), timeoutMs)
    timer.unref?.()
    let activation
    try {
      const prompt = buildReviewPrompt({ root: projectRoot, draft, history: await gitHistory(projectRoot) })
      activation = await subagents.startActivation({
        provider: 'spawn',
        label: 'AWR takeover: review the intake draft',
        request: { cwd: reviewDir, prompt: [{ type: 'text', text: prompt }], parent },
        signal: abort.signal,
        delivery: 'caller',
      })
      trace?.({ event: 'takeover-review-started', child: activation.childId })
      const finished = await Promise.race([
        activation.result,
        new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })),
      ])
      const text = resultText(finished)
      trace?.({ event: 'takeover-review-finished', chars: text.length })
      return parseReview(text, draft)
    } catch (error) {
      if (error instanceof TakeoverStop) throw error
      throw new TakeoverStop('review_failed', `The review subagent failed: ${oneLine(error?.message ?? error)}`)
    } finally {
      clearTimeout(timer)
      endExpectation()
      policy.forget(activation?.childId)
      try {
        await activation?.dispose?.()
      } catch {
        // the child is gone either way
      }
    }
  }
}

// --- state for the panel and the command -----------------------------------------------------------------

/** What the panel and `/awr takeover status --json` show. */
export function describeRun({ root, record, receipt, running, initialized }) {
  const steps = STEPS.map((name) => ({ name, status: record?.steps?.[name]?.status ?? 'pending' }))
  let state
  if (running) state = 'running'
  else if (record?.status === 'completed') state = 'completed'
  else if (record?.status === 'stopped') state = 'stopped'
  else if (record?.status === 'failed') state = 'failed'
  else if (record?.status === 'running') state = 'interrupted'
  else state = initialized ? 'initialized' : 'not_initialized'
  return {
    projectRoot: root,
    state,
    steps,
    startedAt: record?.startedAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    stop: record?.stop ?? null,
    receipt: receipt
      ? {
          result: receipt.result,
          mapped: receipt.mapped,
          created: receipt.created,
          organization: { state: receipt.organization?.state, goalTotal: receipt.organization?.goalTotal, gapTotal: receipt.organization?.gapTotal, actions: receipt.organization?.actions },
          awaitingConfirmation: receipt.awaitingConfirmation,
          reviewed: receipt.reviewed,
          git: receipt.git,
        }
      : null,
  }
}

/** The same, in words. */
export function formatRun(view) {
  const lines = [`Takeover of ${view.projectRoot}: ${view.state}`]
  const done = view.steps.filter((step) => step.status === 'done' || step.status === 'skipped').map((step) => step.name)
  if (view.state !== 'not_initialized' && view.state !== 'initialized') lines.push(`Steps done: ${done.join(', ') || 'none yet'}`)
  if (view.stop) lines.push(`Stopped at ${view.stop.step}: ${view.stop.reason}: ${view.stop.message}`)
  if (view.receipt) {
    lines.push(`Result: ${view.receipt.result}; ${view.receipt.organization?.goalTotal ?? 0} goal(s), ${view.receipt.organization?.gapTotal ?? 0} open gap(s)`)
    lines.push(`Mapped: ${(view.receipt.mapped?.sources ?? []).map((s) => s.path).join(', ') || 'nothing'}`)
    lines.push(`Created: ${(view.receipt.created?.writes ?? []).map((w) => w.path).join(', ') || 'nothing'}`)
    const waiting = view.receipt.awaitingConfirmation ?? []
    lines.push(`Awaiting your confirmation: ${waiting.length ? waiting.map((g) => `${g.title ?? g.key} (${g.status})`).join('; ') : 'nothing'}`)
  }
  return lines.join('\n')
}

/**
 * Starts takeovers and reports on them.
 *
 * @param {{ awr: { run: Function, resolve: Function }, getSubagents: () => any, policy?: ReturnType<typeof createReviewerPolicy>, stateBase?: string, rebind?: (agent: any) => Promise<any>, trace?: Function, warn?: Function, reviewTimeoutMs?: number, runner?: typeof runTakeover }} deps
 */
export function createTakeoverController({ awr, getSubagents, policy = createReviewerPolicy(), stateBase = defaultStateBase(), rebind, trace, warn, reviewTimeoutMs, runner = runTakeover }) {
  /** @type {Map<string, { promise: Promise<any>, startedAt: number }>} */
  const running = new Map()

  async function read(root) {
    const dir = runDirFor(root, stateBase)
    const record = await readFile(join(dir, 'takeover.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    const receipt = record?.status === 'completed' ? await readFile(join(dir, 'receipt.json'), 'utf8').then(JSON.parse).catch(() => undefined) : undefined
    return { record: record?.projectRoot === root ? record : undefined, receipt }
  }

  return {
    policy,

    /** The state for a conversation, as the panel shows it. */
    async status(agent) {
      const found = await takeoverRootFor(agent?.session?.header?.cwd)
      if (!found.root) return { projectRoot: null, state: 'unavailable', steps: [], stop: found.refused ? { step: 'preflight', reason: 'too_broad', message: found.refused } : null, receipt: null }
      const { record, receipt } = await read(found.root)
      return describeRun({ root: found.root, record, receipt, running: running.has(found.root), initialized: found.initialized === true })
    },

    /**
     * Start (or resume) the takeover of the conversation's project and return at once; the run goes on in
     * the background and the conversation stays usable.
     */
    async start(agent) {
      const found = await takeoverRootFor(agent?.session?.header?.cwd)
      if (found.refused) return { started: false, reason: 'too_broad', message: found.refused }
      const root = found.root
      if (running.has(root)) return { started: false, reason: 'running', message: `The takeover of ${root} is already running.`, projectRoot: root }
      const { record } = await read(root)
      if (found.initialized && record?.status !== 'running' && record?.status !== 'stopped' && record?.status !== 'failed') {
        return { started: false, reason: 'already_initialized', message: `${root} is already an AWR project.`, projectRoot: root }
      }
      const review = createSubagentReview({ getSubagents, policy, stateBase, timeoutMs: reviewTimeoutMs, trace }, { parent: agent })
      const promise = runner({
        awr,
        projectRoot: root,
        stateDir: stateBase,
        review: getSubagents()?.startActivation ? review : undefined,
        adopt: found.initialized === true,
        onEvent: ({ step, status }) => trace?.({ event: 'takeover', root, step, status }),
      })
        .then(async (result) => {
          trace?.({ event: 'takeover-finished', root, outcome: result.outcome, stop: result.record?.stop ?? null })
          if (result.outcome === 'completed' && rebind) {
            try {
              await rebind(agent)
            } catch (error) {
              warn?.(`The conversation could not be bound to AWR after the takeover: ${error?.message ?? error}`)
            }
          }
          return result
        })
        .catch((error) => {
          warn?.(`The takeover of ${root} ended unexpectedly: ${error?.message ?? error}`)
          trace?.({ event: 'takeover-error', root, message: String(error?.message ?? error) })
        })
        .finally(() => running.delete(root))
      running.set(root, { promise, startedAt: Date.now() })
      return { started: true, resumed: Boolean(record), projectRoot: root, message: `${record ? 'Resumed' : 'Started'} the takeover of ${root}. It runs in the background; this conversation stays usable.` }
    },

    /** Resolves when the takeover of `root` that is running, if any, has finished. For tests and shutdown. */
    async idle(root) {
      await running.get(root)?.promise
    },
  }
}
