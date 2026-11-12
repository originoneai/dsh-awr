// Unattended takeover of an existing project (DSH-020).
//
// Takes a project that has no AWR runtime to an accepted `awr init` and an organization state, in
// steps that are persisted one by one, with no question asked on the way. The module is independent
// of DeepSeek Harness: it reaches AWR only through the runner (argv), reads Git's HEAD, and asks its
// caller for two judgments through callbacks (`review`, and optionally `organize`). DSH-021 supplies
// those from a subagent; it could as well be another host, or the AWR CLI (DSH-040).
//
//   preflight  awr is usable, the project is not initialized, no active session, Git HEAD noted
//   preview    `awr init` preview and `--write-draft` to a directory outside the project
//   review     the callback turns the generated draft into a reviewed one
//   accept     `init --from-draft` preview, a check of what it would write, then `--accept
//              --expected-preview <fingerprint>`; a changed inventory sends the run back to preview
//   organize   `intake inspect`, and while it asks for work and a callback exists: the callback edits
//              the authoritative sources, `source reindex`, inspect again (bounded)
//   receipt    what was mapped, what was created, what awaits confirmation
//
// Everything before accept leaves the project byte-identical: preview and `--write-draft` write
// nothing in it, and the run's own record and drafts live in a state directory outside it. After
// accept the project gains `.awr/` and the `.gitignore` entries AWR's own init lists in its preview;
// a preview that lists any other path outside `.awr/` stops the run before accept. Nothing is
// committed or pushed.
//
// A run that cannot go on stops with a recorded reason and is not an error of the module:
// secret_boundary, source_unreadable, unsupported, migration_prompt, active_session, ... A stopped or
// failed run is resumed by calling again; a step that finished is not repeated.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AwrError, explain } from './awr-runtime.js'

export const STEPS = ['preflight', 'preview', 'review', 'accept', 'organize', 'receipt']
export const RECORD_VERSION = 1
const DEFAULT_ROUNDS = 3
const DEFAULT_ORGANIZE_ROUNDS = 3
const MAX_GENERATED_FILE_BYTES = 1024 * 1024
/** What AWR's init may add outside `.awr/`: its ignore entries for runtime files. */
const ALLOWED_OUTSIDE_AWR = new Set(['.gitignore'])
const SETTLED_STATES = new Set(['ready', 'blocked', 'awaiting_verification', 'completed', 'closed_without_completion'])

/** Thrown by a callback (or inside the module) to end the run with a recorded reason. */
export class TakeoverStop extends Error {
  constructor(reason, message, detail) {
    super(message ?? reason)
    this.name = 'TakeoverStop'
    this.reason = reason
    this.detail = detail
  }
}

const active = new Set()

export function defaultStateBase(env = process.env) {
  const base = env.DSH_AWR_STATE ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.local', 'state'), 'dsh-awr')
  return join(base, 'takeovers')
}

/** The directory that holds one project's run record, drafts and receipt. */
export function runDirFor(projectRoot, base = defaultStateBase()) {
  const root = resolve(projectRoot)
  const name = root.split(sep).filter(Boolean).at(-1) ?? 'project'
  return join(base, `${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`)
}

// --- small helpers --------------------------------------------------------------------------------------

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Git's HEAD for the project, or null when it is not a repository. Read-only. */
function gitHead(root) {
  return new Promise((done) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 15_000 }, (error, stdout) => done(error ? null : String(stdout).trim() || null))
  })
}

/**
 * A path from an AWR locator (`file:///...`) relative to the project, so no absolute path of this machine
 * is kept. AWR reports real paths (`/private/var/...` for `/var/...` on macOS), so both spellings of the
 * root are tried.
 */
function relativeLocator(locator, root) {
  if (typeof locator !== 'string') return undefined
  let path = locator
  try {
    path = locator.startsWith('file://') ? fileURLToPath(locator.split('#')[0]) : locator
  } catch {
    return locator
  }
  const roots = [root]
  try {
    roots.push(realpathSync(root))
  } catch {
    // the root is gone; the plain spelling is all there is
  }
  for (const base of roots) {
    const relativePath = relative(base, path)
    if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) return relativePath
  }
  return path
}

const insideAwr = (path) => path === '.awr' || path.startsWith('.awr/')

/** Why an error from awr ends the run: `{ reason, message, detail }`. */
export function classify(error, root) {
  if (error instanceof TakeoverStop) return { reason: error.reason, message: error.message, detail: error.detail }
  if (error instanceof AwrError) {
    const code = error.details?.code
    const awrDetails = error.details?.awrDetails
    if (code === 'RuleViolation' && /sensitive content/i.test(error.details?.awrMessage ?? '')) {
      return {
        reason: 'secret_boundary',
        message: `AWR refused source content that looks like a ${awrDetails?.category ?? 'secret'}: ${awrDetails?.next_action ?? error.details?.awrMessage}`,
        // Where it is, never what it is.
        detail: { category: awrDetails?.category, path: relativeLocator(awrDetails?.location?.locator, root), line: awrDetails?.location?.line },
      }
    }
    if (error.kind === 'missing') return { reason: 'awr_unavailable', message: explain(error) }
    if (error.kind === 'unsupported') return { reason: 'unsupported', message: explain(error), detail: { code } }
    if (error.kind === 'schema_mismatch' || error.kind === 'recovery_required') return { reason: 'migration_prompt', message: explain(error), detail: { code } }
    if (error.kind === 'binary_changed' || error.kind === 'version_mismatch') return { reason: 'runtime_changed', message: explain(error) }
    if (error.kind === 'timeout') return { reason: 'timeout', message: error.message }
    if (error.kind === 'invalid_output') return { reason: 'invalid_output', message: error.message }
    if (code === 'SourceConflict' && /multiple authority/i.test(error.details?.awrMessage ?? '')) {
      return { reason: 'ambiguous_authority', message: `${error.details.awrMessage}. The reviewed draft has to choose: add the authoritative source of each ambiguous domain to authority_mapping.sources and clear ambiguous_domains.`, detail: { code } }
    }
    if (code === 'SourceConflict') return { reason: 'inventory_changed', message: error.details?.awrMessage ?? error.message, detail: { code } }
    return { reason: 'awr_error', message: `${code ?? error.kind}: ${error.details?.awrMessage ?? error.message}`, detail: { code } }
  }
  return undefined
}

function summarizeSources(mapping) {
  return (mapping?.sources ?? []).map((source) => ({ path: source.path, domain: source.domain, adapter: source.adapter, role: source.role }))
}

function sample(list, count = 20) {
  return (Array.isArray(list) ? list : []).slice(0, count)
}

/** Reject a reviewed draft that is not the draft AWR produced for this directory, or that writes outside the intake files. */
export function validateReviewedDraft(draft, reviewed) {
  if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)) return 'the reviewed draft must be a JSON object'
  for (const key of ['schema_version', 'project_root', 'inventory_fingerprint']) {
    if (reviewed[key] !== draft[key]) return `the reviewed draft changes "${key}", which ties it to the project it was generated for`
  }
  const files = reviewed.generated_files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return 'generated_files must be an object of intake file text'
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith('.awr/intake/') || path.split('/').includes('..') || isAbsolute(path)) return `generated file "${path}" is outside .awr/intake/`
    if (typeof text !== 'string') return `generated file "${path}" must be text`
    if (Buffer.byteLength(text) > MAX_GENERATED_FILE_BYTES) return `generated file "${path}" is larger than 1 MiB`
  }
  return undefined
}

// --- the steps ---------------------------------------------------------------------------------------------

async function preflight(run) {
  const { awr, root } = run
  let info
  try {
    info = await stat(root)
  } catch {
    throw new TakeoverStop('not_a_directory', `${root} does not exist`)
  }
  if (!info.isDirectory()) throw new TakeoverStop('not_a_directory', `${root} is not a directory`)
  await awr.resolve(root)
  const initialized = await exists(join(root, '.awr', 'project.toml'))
  let adopted = false
  if (initialized) {
    const sessions = await awr.run(root, ['session', 'list', '--active'])
    const open = (sessions?.sessions ?? []).filter((session) => session?.status === 'active')
    if (open.length > 0) {
      throw new TakeoverStop('active_session', `The project already has ${open.length} active AWR session(s); a takeover does not run next to one.`, {
        sessions: open.slice(0, 5).map((session) => ({ id: session.id, agent: session.agent_id, started_at: session.started_at })),
      })
    }
    if (!run.options.adopt) throw new TakeoverStop('already_initialized', 'The project is already initialized; a takeover starts from a project without an AWR runtime.')
    adopted = true
  }
  return { initialized, adopted, gitHead: await gitHead(root) }
}

async function preview(run) {
  const { awr, root, runDir } = run
  let shown
  try {
    shown = await awr.run(root, ['init'])
  } catch (error) {
    // AWR could not make sense of a source it found (for example a ledger that is not valid YAML).
    if (error instanceof AwrError && error.details?.code === 'InvalidInput') {
      throw new TakeoverStop('source_unreadable', `AWR cannot read the project's sources: ${error.details.awrMessage}`, { code: 'InvalidInput' })
    }
    throw error
  }
  const issues = shown?.preview?.source_issues ?? []
  if (issues.length > 0) {
    throw new TakeoverStop('source_unreadable', `AWR cannot read ${issues.length} source(s) of this project.`, {
      issues: sample(issues, 5).map((issue) => ({ domain: issue.domain, code: issue.error?.code ?? issue.code, message: issue.error?.message ?? issue.message, path: relativeLocator(issue.locator ?? issue.path, root) })),
    })
  }
  if (shown?.status !== 'preview' || shown?.preview?.can_apply !== true) {
    throw new TakeoverStop('cannot_apply', 'AWR reports that the initialization cannot be applied to this project.', { status: shown?.status })
  }
  const draftPath = join(runDir, 'draft.json')
  // awr will not overwrite a draft file, and a draft left by an interrupted attempt is this run's own.
  await rm(draftPath, { force: true })
  await awr.run(root, ['init', '--write-draft', draftPath])
  const draft = await readJson(draftPath)
  if (typeof draft?.inventory_fingerprint !== 'string' || typeof draft?.generated_files !== 'object') {
    throw new TakeoverStop('invalid_draft', 'AWR wrote a draft this module does not recognize.')
  }
  return {
    draftPath,
    inventoryFingerprint: draft.inventory_fingerprint,
    inventory: (draft.inventory ?? []).length,
    sources: summarizeSources(draft.authority_mapping),
    ambiguousDomains: draft.ambiguous_domains ?? [],
    gaps: sample(draft.gaps, 10),
    generatedFiles: Object.keys(draft.generated_files),
    git: draft.git ?? null,
  }
}

async function review(run) {
  const { root, runDir, record } = run
  const draftPath = join(runDir, 'draft.json')
  const draft = await readJson(draftPath)
  const round = record.rounds
  let reviewed = draft
  let notes
  if (run.options.review) {
    const answer = await run.options.review({
      projectRoot: root,
      draft: structuredClone(draft),
      draftPath,
      round,
      sources: summarizeSources(draft.authority_mapping),
      ambiguousDomains: draft.ambiguous_domains ?? [],
    })
    if (answer && typeof answer === 'object' && 'draft' in answer && !('generated_files' in answer)) {
      reviewed = answer.draft
      notes = answer.notes
    } else {
      reviewed = answer
    }
    const problem = validateReviewedDraft(draft, reviewed)
    if (problem) throw new TakeoverStop('review_rejected', problem)
  }
  const reviewedPath = join(runDir, 'reviewed.json')
  await writeJson(reviewedPath, reviewed)
  return { reviewedPath, reviewed: Boolean(run.options.review), changedFiles: Object.keys(reviewed.generated_files).filter((path) => reviewed.generated_files[path] !== draft.generated_files[path]), ...(notes ? { notes } : {}) }
}

async function accept(run) {
  const { awr, root, runDir, record } = run
  const reviewedPath = join(runDir, 'reviewed.json')
  const attempted = record.steps.accept?.attempted === true
  if (await exists(join(root, '.awr', 'project.toml'))) {
    if (attempted) return { recovered: true, note: 'The project was initialized by an earlier attempt of this run that did not finish recording it.' }
    throw new TakeoverStop('already_initialized', 'The project was initialized while the run was in progress.')
  }
  // AWR takes the reviewer's word that an ambiguity is settled and refuses the draft while it is still listed.
  const reviewedDraft = await readJson(reviewedPath)
  if ((reviewedDraft.ambiguous_domains ?? []).length > 0) throw ambiguousAuthority(reviewedDraft.ambiguous_domains)
  let shown
  try {
    shown = await awr.run(root, ['init', '--from-draft', reviewedPath])
  } catch (error) {
    const stop = classify(error, root)
    if (stop?.reason === 'inventory_changed') return { retry: 'inventory_changed', message: stop.message }
    if (stop?.reason === 'ambiguous_authority') throw ambiguousAuthority(reviewedDraft.ambiguous_domains ?? [], stop.message)
    throw error
  }
  const writes = (shown?.preview?.writes ?? []).map((write) => ({ action: write.action, path: write.path }))
  const outside = writes.filter((write) => !insideAwr(write.path) && !(run.options.allowGitignore !== false && ALLOWED_OUTSIDE_AWR.has(write.path)))
  if (outside.length > 0) {
    throw new TakeoverStop('unexpected_write', 'AWR would write outside .awr/ beyond its own ignore entries; nothing was written.', { paths: outside.map((write) => write.path) })
  }
  const fingerprint = shown?.preview?.fingerprint
  if (typeof fingerprint !== 'string') throw new TakeoverStop('cannot_apply', 'AWR returned no preview fingerprint for the reviewed draft.')
  await run.mark('accept', { attempted: true, fingerprint })
  try {
    await awr.run(root, ['init', '--from-draft', reviewedPath, '--accept', '--expected-preview', fingerprint])
  } catch (error) {
    const stop = classify(error, root)
    if (stop?.reason === 'ambiguous_authority' && !(await exists(join(root, '.awr', 'project.toml')))) throw ambiguousAuthority(reviewedDraft.ambiguous_domains ?? [], stop.message)
    if (await exists(join(root, '.awr', 'project.toml'))) {
      throw new TakeoverStop('accept_failed_partial', `Accepting failed part way and left an incomplete .awr/ in the project: ${stop?.message ?? error?.message}`, stop?.detail)
    }
    throw error
  }
  return { fingerprint, writes, writtenOutsideAwr: writes.filter((write) => !insideAwr(write.path)).map((write) => write.path) }
}

function summarizeOrganization(inspected, root) {
  const organization = inspected?.organization ?? inspected ?? {}
  return {
    state: organization.state,
    gapTotal: organization.gap_total ?? 0,
    goalTotal: organization.goal_total ?? 0,
    executableWorkTotal: organization.executable_work_total ?? 0,
    goals: sample(organization.goals, 20).map((goal) => ({ key: goal.key, status: goal.status ?? goal.declared_status, ...(goal.title ? { title: goal.title } : {}) })),
    actions: (organization.actions ?? []).map((action) => action.id),
    gaps: sample(organization.gaps, 20).map((gap) => ({ code: gap.code, action: gap.action, detail: String(gap.detail ?? '').slice(0, 240), target: gap.target })),
    sources: sample(organization.sources, 20),
    truncated: organization.truncated ?? false,
  }
}

async function organize(run) {
  const { awr, root } = run
  const max = run.options.maxOrganizeRounds ?? DEFAULT_ORGANIZE_ROUNDS
  let summary
  let rounds = 0
  for (;;) {
    const inspected = await awr.run(root, ['intake', 'inspect'])
    summary = summarizeOrganization(inspected, root)
    if (summary.state === 'source_unreadable') {
      throw new TakeoverStop('source_unreadable', 'AWR cannot read the sources of the initialized project.', { gaps: summary.gaps.slice(0, 5) })
    }
    if (summary.state === 'not_initialized') throw new TakeoverStop('accept_incomplete', 'The project is not initialized after accept.')
    if (SETTLED_STATES.has(summary.state) || !run.options.organize || rounds >= max) break
    rounds += 1
    await run.options.organize({ projectRoot: root, organization: inspected?.organization ?? inspected, summary, round: rounds })
    await awr.run(root, ['source', 'reindex'])
  }
  return { ...summary, rounds }
}

async function receipt(run) {
  const { root, runDir, record } = run
  const steps = record.steps
  const headAfter = await gitHead(root)
  const organized = steps.organize?.result ?? {}
  const accepted = steps.accept?.result ?? {}
  const pendingConfirmation = (organized.goals ?? []).filter((goal) => !['active', 'confirmed'].includes(String(goal.status ?? '').toLowerCase()))
  const body = {
    version: RECORD_VERSION,
    run: record.id,
    project: root,
    startedAt: record.startedAt,
    finishedAt: run.now(),
    result: organized.state === 'ready' ? 'ready' : organized.state ?? 'unknown',
    mapped: { sources: steps.preview?.result?.sources ?? [], inventory: steps.preview?.result?.inventory ?? 0 },
    created: { writes: accepted.writes ?? [], writtenOutsideAwr: accepted.writtenOutsideAwr ?? [], recovered: accepted.recovered === true },
    reviewed: { byCallback: steps.review?.result?.reviewed === true, changedFiles: steps.review?.result?.changedFiles ?? [], rounds: record.rounds },
    organization: { state: organized.state, gapTotal: organized.gapTotal, goalTotal: organized.goalTotal, executableWorkTotal: organized.executableWorkTotal, rounds: organized.rounds, actions: organized.actions, gaps: organized.gaps },
    awaitingConfirmation: pendingConfirmation,
    git: { headBefore: steps.preflight?.result?.gitHead ?? null, headAfter, committed: false, pushed: false, headMoved: (steps.preflight?.result?.gitHead ?? null) !== headAfter },
  }
  await mkdir(join(root, '.awr', 'takeover'), { recursive: true })
  const inProject = join(root, '.awr', 'takeover', 'receipt.json')
  await writeJson(inProject, body)
  await writeJson(join(runDir, 'receipt.json'), body)
  return { receiptPath: inProject, body }
}

function ambiguousAuthority(domains, message) {
  return new TakeoverStop(
    'ambiguous_authority',
    message ?? `AWR found several candidates for ${domains.join(', ') || 'a domain'} and the reviewed draft did not choose. Add the authoritative source of each ambiguous domain to authority_mapping.sources (role: primary) and clear ambiguous_domains.`,
    { domains },
  )
}

const IMPLEMENTATIONS = { preflight, preview, review, accept, organize, receipt }

// --- the run ---------------------------------------------------------------------------------------------------

async function acquireLock(runDir) {
  const path = join(runDir, 'lock')
  try {
    const held = await readJson(path)
    if (held?.pid && held.pid !== process.pid) {
      try {
        process.kill(held.pid, 0)
        return { locked: held }
      } catch {
        // the process that held it is gone
      }
    }
  } catch {
    // no lock
  }
  await writeJson(path, { pid: process.pid, at: Date.now() })
  return { release: () => rm(path, { force: true }) }
}

/**
 * Run, or resume, the takeover of one project.
 *
 * @param {object} options
 * @param {{ run: Function, resolve: Function }} options.awr the runner from `createAwr()`
 * @param {string} options.projectRoot
 * @param {string} [options.stateDir] where the run's record and drafts live (outside the project); default `defaultStateBase()`
 * @param {(call: { projectRoot: string, draft: object, draftPath: string, round: number, sources: object[], ambiguousDomains: string[] }) => Promise<object>} [options.review]
 *        turns the generated draft into the reviewed one (the same shape, edited); absent: the draft is applied as generated
 * @param {(call: { projectRoot: string, organization: object, summary: object, round: number }) => Promise<void>} [options.organize]
 *        edits the authoritative sources the organization actions point at; absent: one inspection and no edits
 * @param {boolean} [options.adopt] continue organizing an already initialized project with no active session
 * @param {boolean} [options.allowGitignore] default true; false stops before accept when init would touch .gitignore
 * @param {number} [options.maxRounds] preview/review/accept rounds when the inventory keeps changing (default 3)
 * @param {number} [options.maxOrganizeRounds] default 3
 * @param {(event: { step: string, status: string, record: object }) => void} [options.onEvent]
 * @returns {Promise<{ outcome: 'completed' | 'stopped' | 'failed', record: object, receipt?: object, runDir: string }>}
 */
export async function runTakeover(options) {
  const root = resolve(options.projectRoot)
  const base = options.stateDir ?? defaultStateBase()
  const runDir = runDirFor(root, base)
  const now = options.now ?? Date.now
  if (active.has(root)) throw new Error(`a takeover of ${root} is already running in this process`)
  active.add(root)
  await mkdir(runDir, { recursive: true })
  const lock = await acquireLock(runDir)
  if (lock.locked) {
    active.delete(root)
    return { outcome: 'stopped', runDir, record: { status: 'stopped', projectRoot: root, stop: { step: 'preflight', reason: 'locked', message: `Another process (${lock.locked.pid}) is taking this project over.` } } }
  }
  const recordPath = join(runDir, 'takeover.json')
  let record
  try {
    record = await readJson(recordPath).catch(() => undefined)
    if (record && (record.version !== RECORD_VERSION || record.projectRoot !== root)) record = undefined
    if (record?.status === 'completed' && !options.rerun) {
      const receiptBody = await readJson(join(runDir, 'receipt.json')).catch(() => undefined)
      return { outcome: 'completed', record, ...(receiptBody ? { receipt: receiptBody } : {}), runDir }
    }
    if (!record || record.status === 'completed') {
      record = { version: RECORD_VERSION, id: randomBytes(6).toString('hex'), projectRoot: root, startedAt: now(), updatedAt: now(), status: 'running', rounds: 1, steps: {}, stop: null }
    }
    record.status = 'running'
    record.stop = null
    const save = async () => {
      record.updatedAt = now()
      await writeJson(recordPath, record)
    }
    const emit = (step, status) => {
      try {
        options.onEvent?.({ step, status, record: structuredClone(record) })
      } catch {
        // a listener must not end the run
      }
    }
    await save()

    const run = {
      awr: options.awr,
      root,
      runDir,
      record,
      options,
      now,
      mark: async (step, fields) => {
        record.steps[step] = { ...record.steps[step], ...fields }
        await save()
      },
    }
    const maxRounds = options.maxRounds ?? DEFAULT_ROUNDS
    const adoptedSkips = new Set(['preview', 'review', 'accept'])

    for (let index = 0; index < STEPS.length; ) {
      const name = STEPS[index]
      const existing = record.steps[name]
      if (existing?.status === 'done') {
        index += 1
        continue
      }
      if (name !== 'preflight' && record.steps.preflight?.result?.adopted && adoptedSkips.has(name)) {
        record.steps[name] = { status: 'skipped', finishedAt: now() }
        await save()
        index += 1
        continue
      }
      record.steps[name] = { ...existing, status: 'running', startedAt: now(), error: undefined }
      await save()
      emit(name, 'running')
      let result
      try {
        result = await IMPLEMENTATIONS[name](run)
      } catch (error) {
        const stop = classify(error, root)
        record.steps[name] = { ...record.steps[name], status: stop ? 'stopped' : 'failed', finishedAt: now() }
        record.status = stop ? 'stopped' : 'failed'
        record.stop = { step: name, reason: stop?.reason ?? 'unexpected_error', message: stop?.message ?? String(error?.message ?? error), ...(stop?.detail ? { detail: stop.detail } : {}) }
        await save()
        emit(name, record.steps[name].status)
        return { outcome: record.status, record, runDir }
      }
      if (name === 'accept' && result?.retry) {
        if (record.rounds >= maxRounds) {
          record.steps.accept = { ...record.steps.accept, status: 'stopped', finishedAt: now() }
          record.status = 'stopped'
          record.stop = { step: 'accept', reason: 'inventory_changed', message: `The project kept changing while it was being reviewed (${record.rounds} rounds): ${result.message}` }
          await save()
          emit('accept', 'stopped')
          return { outcome: 'stopped', record, runDir }
        }
        record.rounds += 1
        for (const earlier of ['preview', 'review', 'accept']) delete record.steps[earlier]
        await save()
        emit('accept', 'retry')
        index = STEPS.indexOf('preview')
        continue
      }
      record.steps[name] = { ...record.steps[name], status: 'done', finishedAt: now(), result: name === 'receipt' ? { receiptPath: result.receiptPath } : result }
      if (name === 'accept' && result?.recovered) record.steps.accept.status = 'done'
      await save()
      emit(name, 'done')
      if (name === 'receipt') run.receiptBody = result.body
      index += 1
    }
    record.status = 'completed'
    await save()
    return { outcome: 'completed', record, receipt: run.receiptBody, runDir }
  } finally {
    await lock.release?.()
    active.delete(root)
  }
}
