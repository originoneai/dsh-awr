// The takeover through the AWR CLI (DSH-054).
//
// DSH-040 moved the orchestration of the takeover into `awr takeover` (originoneai/awr#620). This module is the
// plugin's side of it: it detects a `awr` that has the command, runs it, supplies the one judgment the CLI cannot
// make for itself (the review of the draft, done by a DeepSeek Harness subagent) through the host-driven review
// of the CLI (`--await-review`, then `--reviewed`, originoneai/awr#626), and turns the CLI's record and receipt
// into the view the panel and `/awr takeover status` already show. The plugin's own implementation
// (lib/takeover.js) stays for an `awr` that does not have the command yet.
//
//   awr takeover --await-review    runs preflight and preview, then stops: outcome "awaiting_review", with the
//                                  saved draft and the review request named in record.stop.detail
//   (the subagent reviews)         the answer is written to a file in the reviewer's answer format
//   awr takeover --reviewed FILE   applies the answer under the CLI's guards and runs accept, organize, receipt
//
// A review that fails cannot be recorded in the CLI's record (the run is paused, not stopped), so the reason is
// kept in `host.json` next to it and put into the view; the next start reviews again.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TakeoverStop } from './takeover.js'

const RUN_TIMEOUT_MS = 10 * 60_000
const AVAILABILITY_TTL_MS = 60_000
/** Reviews one run asks for at most: an answer the CLI refuses is a stop, not another round. */
const MAX_REVIEWS = 3

/** Where the CLI keeps its runs, apart from the records of the plugin's own implementation. */
export const cliStateDir = (stateBase) => join(stateBase, 'cli')

/** @type {WeakMap<object, Map<string, { at: number, document: object | null }>>} */
const documents = new WeakMap()

/** The commands `intake.takeover` has to list for the host-driven review this module uses. */
const NEEDED_COMMANDS = ['takeover', 'takeover --await-review', 'takeover --reviewed']

/**
 * The capability document of the `awr` of this project, or null when it cannot be read. It is kept for a minute so that a
 * panel that asks often does not start a process each time. `awr capabilities` is the negotiation every build answers;
 * the takeover command itself is never run to find out (below).
 */
async function capabilityDocument(awr, root, now) {
  let byRoot = documents.get(awr)
  if (!byRoot) documents.set(awr, (byRoot = new Map()))
  const known = byRoot.get(root)
  if (known && now() - known.at < AVAILABILITY_TTL_MS) return known.document
  let document = null
  try {
    document = await awr.run(root, ['capabilities'])
  } catch {
    document = null
  }
  byRoot.set(root, { at: now(), document })
  return document
}

/**
 * Whether the `awr` of this project lists `command` (for example `overview snapshot`) among the commands of its
 * capabilities. The command itself is never run to find out, for the reason below.
 */
export async function awrHasCommand(awr, root, command, now = Date.now) {
  const document = await capabilityDocument(awr, root, now)
  return (document?.capabilities ?? []).some((capability) => (capability?.commands ?? []).includes(command))
}

/**
 * Whether the `awr` of this project has `awr takeover` with the host-driven review: its capability document lists
 * `intake.takeover` with the commands this module calls. The command itself is never run to find out. An older awr
 * answers an unknown subcommand with `Unsupported`, and the plugin takes that for a reason to stop using awr for the
 * project, while `awr capabilities` is the negotiation that every build answers.
 */
export async function cliTakeoverAvailable(awr, root, now = Date.now) {
  const document = await capabilityDocument(awr, root, now)
  const capability = (Array.isArray(document?.capabilities) ? document.capabilities : []).find((entry) => entry?.id === 'intake.takeover')
  return capability?.available === true && NEEDED_COMMANDS.every((command) => Array.isArray(capability.commands) && capability.commands.includes(command))
}

/**
 * Which awr the plugin uses for a project and how the takeover will run, for the panel: the program and its version, where it
 * is, why it was chosen (`binding`: the project is pinned to it, `env`: DSH_AWR_CLI, `path`), and whether the takeover runs
 * through `awr takeover` or through the plugin's own implementation. `error` says why there is none.
 */
export async function awrInfo(awr, root, now = Date.now) {
  let found
  try {
    found = await awr.resolve(root)
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) }
  }
  const document = await capabilityDocument(awr, root, now)
  return {
    cli: found.cli,
    source: found.source,
    version: document?.program?.version ?? found.report?.program?.version ?? null,
    takeover: (await cliTakeoverAvailable(awr, root, now)) ? 'awr' : 'plugin',
  }
}

// --- the view ---------------------------------------------------------------------------------------------

/** A step the host is reviewing is running, as far as the panel is concerned. */
const stepStatus = (status) => (status === 'awaiting_review' ? 'running' : status)

/**
 * The CLI's record in the shape of the plugin's own: camelCase keys, and a run that waits for the review is a running
 * one (it is `interrupted` when no process of the plugin is working on it). A review the host could not do (`hostStop`)
 * is the stop of the run.
 */
export function normalizeRecord(record, hostStop) {
  if (!record || typeof record !== 'object') return undefined
  const steps = {}
  for (const [name, step] of Object.entries(record.steps ?? {})) {
    steps[name] = { status: stepStatus(step?.status), startedAt: step?.started_at, finishedAt: step?.finished_at, ...(step?.result !== undefined ? { result: step.result } : {}) }
  }
  const waiting = record.status === 'awaiting_review'
  const stopped = waiting && hostStop
  if (stopped) steps.review = { ...steps.review, status: 'stopped' }
  return {
    version: record.version,
    id: record.id,
    projectRoot: record.project_root,
    startedAt: record.started_at,
    updatedAt: record.updated_at,
    status: stopped ? 'stopped' : waiting ? 'running' : record.status,
    rounds: record.rounds,
    steps,
    stop: stopped ? { step: hostStop.step ?? 'review', reason: hostStop.reason, message: hostStop.message, ...(hostStop.detail ? { detail: hostStop.detail } : {}) } : waiting ? null : record.stop ?? null,
  }
}

/** The CLI's receipt in the shape the panel reads. */
export function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return undefined
  const organization = receipt.organization ?? {}
  return {
    result: receipt.result,
    mapped: receipt.mapped,
    created: { writes: receipt.created?.writes ?? [], writtenOutsideAwr: receipt.created?.written_outside_awr ?? [], recovered: receipt.created?.recovered === true },
    organization: { state: organization.state, goalTotal: organization.goal_total, gapTotal: organization.gap_total, executableWorkTotal: organization.executable_work_total, actions: organization.actions, gaps: organization.gaps },
    awaitingConfirmation: receipt.awaiting_confirmation ?? [],
    reviewed: { byReviewer: receipt.reviewed?.by_reviewer === true, changedFiles: receipt.reviewed?.changed_files ?? [], rounds: receipt.reviewed?.rounds, ...(receipt.reviewed?.notes ? { notes: receipt.reviewed.notes } : {}) },
    git: receipt.git,
  }
}

const readJson = (path) => readFile(path, 'utf8').then(JSON.parse)

/**
 * The state of the last CLI run for a project, as `{ record, receipt }` in the plugin's shapes. `awr takeover status`
 * is the authority; the run directory it names holds `host.json` when the host could not review the draft.
 */
export async function readCliRun(awr, root, stateBase) {
  let shown
  try {
    // `--state-dir` belongs to `takeover`, so it comes before the subcommand.
    shown = await awr.run(root, ['takeover', '--state-dir', cliStateDir(stateBase), 'status'])
  } catch {
    return { record: undefined, receipt: undefined }
  }
  const hostStop = shown?.run_dir ? await readJson(join(shown.run_dir, 'host.json')).catch(() => undefined) : undefined
  const record = normalizeRecord(shown?.record, hostStop)
  return { record, receipt: record?.status === 'completed' ? normalizeReceipt(shown?.receipt) : undefined }
}

// --- the run ----------------------------------------------------------------------------------------------

/** The answer file the CLI takes: the reviewed files and the notes, whatever shape the review callback returned. */
function answerBody(answer) {
  if (answer && typeof answer === 'object' && answer.draft && !('generated_files' in answer)) return { generated_files: answer.draft.generated_files, ...(answer.notes ? { notes: answer.notes } : {}) }
  return answer
}

/**
 * Run (or resume) the takeover of a project through `awr takeover`, the review done by `options.review`. The same
 * options and result as `runTakeover` of lib/takeover.js.
 *
 * @param {{ awr: { run: Function }, projectRoot: string, stateDir: string, review?: Function, adopt?: boolean, onEvent?: Function }} options
 * @returns {Promise<{ outcome: 'completed' | 'stopped' | 'failed', record: object, receipt?: object, runDir: string }>}
 */
export async function runTakeoverViaCli(options) {
  const { awr, projectRoot, review, adopt, onEvent } = options
  const base = cliStateDir(options.stateDir)
  const common = ['takeover', '--state-dir', base, ...(adopt ? ['--adopt'] : [])]
  const run = (extra) => awr.run(projectRoot, [...common, ...extra], { timeoutMs: RUN_TIMEOUT_MS })
  const emit = (step, status) => {
    try {
      onEvent?.({ step, status })
    } catch {
      // a listener must not end the run
    }
  }

  emit('preflight', 'running')
  let outcome = await run(review ? ['--await-review'] : [])
  for (let reviews = 0; outcome?.outcome === 'awaiting_review'; reviews += 1) {
    const runDir = outcome.run_dir
    const detail = outcome.record?.stop?.detail ?? {}
    const hostFile = join(runDir, 'host.json')
    const hostStop = (reason, message) => ({ step: 'review', reason, message })
    if (!review || reviews >= MAX_REVIEWS) {
      const stop = hostStop('review_unavailable', review ? 'The draft was not accepted after several reviews.' : 'This conversation has no way to review the draft.')
      await writeFile(hostFile, JSON.stringify(stop))
      return { outcome: 'stopped', runDir, record: normalizeRecord({ ...outcome.record, status: 'awaiting_review' }, stop) }
    }
    let request
    try {
      request = await readJson(detail.request_path)
    } catch (error) {
      throw new Error(`the review request of the takeover could not be read: ${error?.message ?? error}`)
    }
    let answer
    emit('review', 'running')
    try {
      answer = await review({ projectRoot, draft: request.draft, draftPath: request.draft_path, round: request.round, sources: request.sources, ambiguousDomains: request.ambiguous_domains })
    } catch (error) {
      const stop = hostStop(error instanceof TakeoverStop ? error.reason : 'review_failed', String(error?.message ?? error))
      await writeFile(hostFile, JSON.stringify({ ...stop, at: Date.now() }))
      emit('review', 'stopped')
      return { outcome: 'stopped', runDir, record: normalizeRecord({ ...outcome.record, status: 'awaiting_review' }, stop) }
    }
    await rm(hostFile, { force: true })
    const answerPath = join(runDir, 'answer.json')
    await mkdir(runDir, { recursive: true })
    await writeFile(answerPath, JSON.stringify(answerBody(answer)))
    outcome = await run(['--reviewed', answerPath])
  }
  const record = normalizeRecord(outcome?.record)
  for (const [step, state] of Object.entries(record?.steps ?? {})) emit(step, state.status)
  return {
    outcome: outcome?.outcome === 'completed' ? 'completed' : outcome?.outcome === 'failed' ? 'failed' : 'stopped',
    record,
    ...(outcome?.receipt ? { receipt: normalizeReceipt(outcome.receipt) } : {}),
    runDir: outcome?.run_dir,
  }
}
