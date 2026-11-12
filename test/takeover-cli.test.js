// The takeover through `awr takeover` (DSH-054): detection, the host-driven review loop, the view of a run the CLI
// recorded, and the controller on a real awr that has the command.
//
// The loop and the view are tested with a scripted `awr`. The end-to-end tests need an awr built with
// `awr takeover --await-review` and the `intake.takeover` capability (originoneai/awr#621, #623, #626); they run
// when AWR_TAKEOVER_BIN names one (docs/lab-environment.md) and are skipped otherwise.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAwr } from '../lib/awr-runtime.js'
import { TakeoverStop } from '../lib/takeover.js'
import { awrInfo, cliStateDir, cliTakeoverAvailable, normalizeReceipt, normalizeRecord, readCliRun, runTakeoverViaCli } from '../lib/takeover-cli.js'
import { createTakeoverController, describeRun } from '../lib/takeover-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const cliBin = process.env.AWR_TAKEOVER_BIN
const withCli = cliBin && existsSync(cliBin) ? test : test.skip

const tmp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const CAPABILITY = { id: 'intake.takeover', available: true, commands: ['takeover', 'takeover status', 'takeover --await-review', 'takeover --reviewed', 'takeover --manifest'] }

// --- detection ------------------------------------------------------------------------------------------------

test('the CLI path is used only when the capability document lists the commands it calls', async () => {
  const doc = (capabilities) => ({ run: async () => ({ capabilities }) })
  assert.equal(await cliTakeoverAvailable(doc([CAPABILITY]), '/p'), true)
  assert.equal(await cliTakeoverAvailable(doc([]), '/p'), false, 'an awr without the capability')
  assert.equal(await cliTakeoverAvailable(doc([{ ...CAPABILITY, available: false }]), '/p'), false)
  assert.equal(await cliTakeoverAvailable(doc([{ ...CAPABILITY, commands: ['takeover'] }]), '/p'), false, 'a takeover without the host-driven review')
  assert.equal(await cliTakeoverAvailable(doc([{ ...CAPABILITY, commands: ['takeover', 'takeover --await-review'] }]), '/p'), false)
  assert.equal(await cliTakeoverAvailable({ run: async () => ({}) }, '/p'), false)
  assert.equal(await cliTakeoverAvailable({ run: async () => { throw new Error('no awr') } }, '/p'), false)
})

test('detection never runs the takeover command, so an older awr is not stopped for the project', async () => {
  const calls = []
  const awr = { run: async (root, args) => { calls.push(args); return { capabilities: [] } } }
  await cliTakeoverAvailable(awr, '/p')
  assert.deepEqual(calls, [['capabilities']])
})

test('the answer is kept for a minute and asked again after that', async () => {
  let asked = 0
  const awr = { run: async () => { asked += 1; return { capabilities: [CAPABILITY] } } }
  let clock = 1_000_000
  const now = () => clock
  await cliTakeoverAvailable(awr, '/p', now)
  clock += 30_000
  await cliTakeoverAvailable(awr, '/p', now)
  assert.equal(asked, 1)
  clock += 31_000
  await cliTakeoverAvailable(awr, '/p', now)
  assert.equal(asked, 2)
  await cliTakeoverAvailable(awr, '/other', now)
  assert.equal(asked, 3, 'each project is asked for itself')
})

test('which awr is used, why, and how the takeover runs, for the panel', async () => {
  const awr = (found, document) => ({ resolve: async () => found, run: async () => document })
  const withCli = awr({ cli: '/dev/awr', source: 'env' }, { program: { version: '0.8.0-dev' }, capabilities: [CAPABILITY] })
  assert.deepEqual(await awrInfo(withCli, '/p'), { cli: '/dev/awr', source: 'env', version: '0.8.0-dev', takeover: 'awr' })
  const released = awr({ cli: '/opt/homebrew/bin/awr', source: 'path' }, { program: { version: '0.7.0' }, capabilities: [] })
  assert.deepEqual(await awrInfo(released, '/p'), { cli: '/opt/homebrew/bin/awr', source: 'path', version: '0.7.0', takeover: 'plugin' })
  const unknown = awr({ cli: '/x/awr', source: 'binding', report: { program: { version: '0.4.0' } } }, null)
  assert.equal((await awrInfo(unknown, '/p')).version, '0.4.0', 'the binding report gives the version when the capabilities cannot be read')
  const missing = { resolve: async () => { throw new Error('No awr was found on PATH and the project has no .awr/runtime-binding.json.') }, run: async () => ({}) }
  const gone = await awrInfo(missing, '/p')
  assert.match(gone.error, /No awr was found/)
  assert.equal(gone.cli, undefined)
})

// --- the view ---------------------------------------------------------------------------------------------------

const cliRecord = (over = {}) => ({
  version: 1, id: 'abc', project_root: '/p', started_at: 1, updated_at: 5, status: 'completed', rounds: 1, stop: null,
  steps: { preflight: { status: 'done', started_at: 1, finished_at: 2 }, review: { status: 'done', finished_at: 3 }, receipt: { status: 'done', finished_at: 4 } },
  ...over,
})
const cliReceipt = () => ({
  result: 'needs_organization',
  mapped: { sources: [{ path: 'README.md', adapter: 'markdown-heading-v1' }], inventory: 1 },
  created: { writes: [{ action: 'create', path: '.awr/project.toml' }], written_outside_awr: ['.gitignore'], recovered: false },
  reviewed: { by_reviewer: true, changed_files: ['.awr/intake/GOALS.md'], rounds: 1, notes: 'from README.md' },
  organization: { state: 'needs_organization', goal_total: 1, gap_total: 2, executable_work_total: 0, actions: ['goals'], gaps: [] },
  awaiting_confirmation: [{ key: 'portal', status: 'candidate', title: 'A portal' }],
  git: { committed: false, pushed: false },
})

test('the CLI record and receipt are shown as the plugin\'s own are', () => {
  const record = normalizeRecord(cliRecord())
  assert.equal(record.projectRoot, '/p')
  assert.equal(record.startedAt, 1)
  assert.equal(record.updatedAt, 5)
  assert.equal(record.status, 'completed')
  assert.equal(record.steps.preflight.finishedAt, 2)
  const receipt = normalizeReceipt(cliReceipt())
  assert.deepEqual({ goalTotal: receipt.organization.goalTotal, gapTotal: receipt.organization.gapTotal, state: receipt.organization.state }, { goalTotal: 1, gapTotal: 2, state: 'needs_organization' })
  assert.equal(receipt.awaitingConfirmation[0].key, 'portal')
  assert.equal(receipt.reviewed.byReviewer, true)
  assert.deepEqual(receipt.created.writtenOutsideAwr, ['.gitignore'])
  const view = describeRun({ root: '/p', record, receipt, running: false, initialized: true })
  assert.equal(view.state, 'completed')
  assert.equal(view.receipt.organization.goalTotal, 1)
  assert.equal(view.receipt.awaitingConfirmation[0].title, 'A portal')
  assert.equal(normalizeRecord(undefined), undefined)
  assert.equal(normalizeReceipt(null), undefined)
})

test('a run that waits for the host\'s review is running; one whose review failed is stopped with the reason', () => {
  const waiting = cliRecord({ status: 'awaiting_review', steps: { preflight: { status: 'done' }, preview: { status: 'done' }, review: { status: 'awaiting_review' } }, stop: { step: 'review', reason: 'awaiting_review', message: 'waiting' } })
  const running = normalizeRecord(waiting)
  assert.equal(running.status, 'running')
  assert.equal(running.steps.review.status, 'running')
  assert.equal(running.stop, null, 'waiting is not a stop')
  assert.equal(describeRun({ root: '/p', record: running, running: false, initialized: false }).state, 'interrupted', 'no process of the plugin is reviewing it')

  const failed = normalizeRecord(waiting, { step: 'review', reason: 'review_failed', message: 'The review subagent failed: the model refused' })
  assert.equal(failed.status, 'stopped')
  assert.equal(failed.steps.review.status, 'stopped')
  assert.deepEqual({ step: failed.stop.step, reason: failed.stop.reason }, { step: 'review', reason: 'review_failed' })
  const view = describeRun({ root: '/p', record: failed, running: false, initialized: false })
  assert.equal(view.state, 'stopped')
  assert.match(view.stop.message, /the model refused/)
})

// --- the run ----------------------------------------------------------------------------------------------------

/** A scripted awr: each call is checked against the next step, which answers it. */
function scripted(t, steps) {
  const runDir = tmp(t, 'dsh-awr-cli-run-')
  const calls = []
  const awr = {
    calls,
    runDir,
    async run(root, args, options) {
      calls.push({ root, args, options })
      const step = steps.shift()
      assert.ok(step, `an unexpected call: ${args.join(' ')}`)
      return step({ root, args, runDir })
    },
  }
  return awr
}

const awaiting = (runDir, draft = { generated_files: { '.awr/intake/work-ledger.yaml': 'goals: []\n' } }) => {
  writeFileSync(join(runDir, 'request.json'), JSON.stringify({ project_root: '/p', draft, draft_path: join(runDir, 'draft.json'), round: 1, sources: [{ path: 'README.md' }], ambiguous_domains: [] }))
  return { outcome: 'awaiting_review', run_dir: runDir, record: cliRecord({ status: 'awaiting_review', stop: { step: 'review', reason: 'awaiting_review', message: 'waiting', detail: { draft_path: join(runDir, 'draft.json'), request_path: join(runDir, 'request.json') } } }) }
}

test('the run pauses for the review, hands the draft to the subagent, and goes on with its answer', async (t) => {
  const events = []
  let asked
  const awr = scripted(t, [
    ({ args, runDir }) => {
      assert.deepEqual(args, ['takeover', '--state-dir', cliStateDir('/state'), '--await-review'])
      return awaiting(runDir)
    },
    ({ args, runDir }) => {
      assert.deepEqual(args, ['takeover', '--state-dir', cliStateDir('/state'), '--reviewed', join(runDir, 'answer.json')])
      assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'answer.json'), 'utf8')), { generated_files: { '.awr/intake/work-ledger.yaml': 'goals: [x]\n' }, notes: 'from README.md' }, 'the answer file holds the reviewed files and the notes')
      return { outcome: 'completed', run_dir: runDir, record: cliRecord(), receipt: cliReceipt() }
    },
  ])
  const result = await runTakeoverViaCli({
    awr, projectRoot: '/p', stateDir: '/state', onEvent: (e) => events.push(`${e.step}:${e.status}`),
    review: async (request) => {
      asked = request
      return { draft: { generated_files: { '.awr/intake/work-ledger.yaml': 'goals: [x]\n' } }, notes: 'from README.md' }
    },
  })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.runDir, awr.runDir)
  assert.equal(result.receipt.organization.goalTotal, 1)
  assert.equal(result.record.projectRoot, '/p')
  assert.deepEqual(Object.keys(asked).sort(), ['ambiguousDomains', 'draft', 'draftPath', 'projectRoot', 'round', 'sources'])
  assert.equal(asked.draft.generated_files['.awr/intake/work-ledger.yaml'], 'goals: []\n')
  assert.ok(events.includes('review:running'))
  assert.equal(awr.calls[0].options.timeoutMs, 600_000, 'a long takeover is not cut at the default timeout of one command')
})

test('without a review callback the CLI is not asked to wait; an initialized project is adopted', async (t) => {
  const awr = scripted(t, [({ args, runDir }) => {
    assert.deepEqual(args, ['takeover', '--state-dir', cliStateDir('/state'), '--adopt'])
    return { outcome: 'completed', run_dir: runDir, record: cliRecord() }
  }])
  const result = await runTakeoverViaCli({ awr, projectRoot: '/p', stateDir: '/state', adopt: true })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.receipt, undefined)
})

test('a review that fails ends the run with its reason, the next one reviews again, and nothing is applied in between', async (t) => {
  const awr = scripted(t, [({ runDir }) => awaiting(runDir)])
  const result = await runTakeoverViaCli({
    awr, projectRoot: '/p', stateDir: '/state',
    review: async () => { throw new TakeoverStop('review_failed', 'The review subagent failed: the model refused') },
  })
  assert.equal(result.outcome, 'stopped')
  assert.deepEqual({ step: result.record.stop.step, reason: result.record.stop.reason }, { step: 'review', reason: 'review_failed' })
  assert.equal(awr.calls.length, 1, 'no answer was sent to the CLI')
  const hostFile = JSON.parse(readFileSync(join(awr.runDir, 'host.json'), 'utf8'))
  assert.match(hostFile.message, /the model refused/)

  // The panel reads the CLI's status, finds the run waiting, and the reason beside it.
  const statusCalls = []
  const statusAwr = { run: async (_root, args) => (statusCalls.push(args), { run_dir: awr.runDir, record: cliRecord({ status: 'awaiting_review', steps: { review: { status: 'awaiting_review' } } }), receipt: null }) }
  const shown = await readCliRun(statusAwr, '/p', '/state')
  assert.deepEqual(statusCalls[0], ['takeover', '--state-dir', cliStateDir('/state'), 'status'], 'the state directory comes before the subcommand')
  assert.equal(shown.record.status, 'stopped')
  assert.match(shown.record.stop.message, /the model refused/)

  // The next review succeeds: the reason is gone and the run finishes.
  const second = scripted(t, [
    () => awaiting(awr.runDir),
    ({ runDir }) => ({ outcome: 'completed', run_dir: runDir, record: cliRecord(), receipt: cliReceipt() }),
  ])
  const again = await runTakeoverViaCli({ awr: second, projectRoot: '/p', stateDir: '/state', review: async () => ({ draft: { generated_files: { a: 'b' } } }) })
  assert.equal(again.outcome, 'completed')
  assert.equal(existsSync(join(awr.runDir, 'host.json')), false)
  assert.equal((await readCliRun(statusAwr, '/p', '/state')).record.status, 'running')
})

test('an answer the CLI refuses is a stop of the run; a stop at the CLI\'s own step is passed on as it is', async (t) => {
  const refused = scripted(t, [
    ({ runDir }) => awaiting(runDir),
    ({ runDir }) => ({ outcome: 'stopped', run_dir: runDir, record: cliRecord({ status: 'stopped', stop: { step: 'review', reason: 'review_rejected', message: 'generated file "README.md" is outside .awr/intake/' } }) }),
  ])
  const result = await runTakeoverViaCli({ awr: refused, projectRoot: '/p', stateDir: '/state', review: async () => ({ draft: { generated_files: { 'README.md': 'x' } } }) })
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.record.stop.reason, 'review_rejected')
  assert.equal(refused.calls.length, 2)

  const secret = scripted(t, [({ runDir }) => ({ outcome: 'stopped', run_dir: runDir, record: cliRecord({ status: 'stopped', stop: { step: 'preview', reason: 'secret_boundary', message: 'AWR refused source content', detail: { path: 'README.md', line: 4, category: 'labelled_value' } } }) })])
  const stopped = await runTakeoverViaCli({ awr: secret, projectRoot: '/p', stateDir: '/state', review: async () => assert.fail('nothing to review') })
  assert.equal(stopped.outcome, 'stopped')
  assert.deepEqual(stopped.record.stop.detail, { path: 'README.md', line: 4, category: 'labelled_value' })
})

test('a run left waiting with no way to review it stops instead of applying the draft', async (t) => {
  const awr = scripted(t, [({ runDir }) => awaiting(runDir)])
  const result = await runTakeoverViaCli({ awr, projectRoot: '/p', stateDir: '/state' })
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.record.stop.reason, 'review_unavailable')
  assert.equal(awr.calls.length, 1)
})

// --- the controller on a real awr -------------------------------------------------------------------------------

function realPortal(t) {
  const root = tmp(t, 'dsh-awr-cli-proj-')
  const state = tmp(t, 'dsh-awr-cli-state-')
  const local = tmp(t, 'dsh-awr-cli-local-')
  const bin = tmp(t, 'dsh-awr-cli-bin-')
  symlinkSync(cliBin, join(bin, 'awr'))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'README.md'), '# Portal\n\nA document portal for the support team.\n')
  writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\n## Milestone 1: Upload\nUpload.\n')
  writeFileSync(join(root, 'TODO.md'), '# TODO\n- [x] Upload endpoint\n- [ ] Search endpoint\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'upload endpoint')
  const env = { ...process.env, AWR_LOCAL_HOME: local, AWR_LOCAL_WEB: '0', PATH: `${bin}:${process.env.PATH}` }
  return { root: execFileSync('realpath', [root], { encoding: 'utf8' }).trim(), state, awr: createAwr({ env }), git }
}

const agentAt = (cwd, id = 'conv-1') => ({ session: { id, header: { cwd } } })

function fakeSubagents(answer) {
  const started = []
  return {
    started,
    async startActivation(spec) {
      // As in DeepSeek Harness 0.2.2-rc.2: the parent is read from the spec, and a spec without one is a TypeError.
      if (spec.parent === undefined || spec.parent === null) throw new TypeError("Cannot read properties of undefined (reading 'id')")
      started.push(spec)
      const result = typeof answer === 'function' ? answer(spec) : answer
      return { childId: 'child-1', result: result instanceof Promise ? result : Promise.resolve(result), dispose: async () => {} }
    },
  }
}

function reviewer() {
  return fakeSubagents((spec) => {
    const draft = JSON.parse(spec.prompt[0].text.split('<draft>')[1].split('</draft>')[0])
    const files = { ...draft.generated_files }
    for (const path of Object.keys(files)) if (path.endsWith('GOALS.md')) files[path] = '# Deliver a document portal {#portal status=active}\n\nThe README says so.\n\nProvenance: README.md.\n'
    return { output: `\`\`\`json\n${JSON.stringify({ generated_files: files, notes: 'from README.md' })}\n\`\`\`` }
  })
}

withCli('on an awr that has the command, one start takes the project over through it and the subagent reviews the draft', async (t) => {
  const f = realPortal(t)
  const agent = agentAt(f.root)
  const subagents = reviewer()
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => subagents, stateBase: f.state })
  assert.equal(await cliTakeoverAvailable(f.awr, f.root), true)
  assert.equal((await controller.status(agent)).state, 'not_initialized')

  const started = await controller.start(agent)
  assert.equal(started.started, true)
  assert.equal((await controller.status(agent)).state, 'running', 'it returned before the run finished')
  await controller.idle(f.root)

  const view = await controller.status(agent)
  assert.equal(view.state, 'completed')
  assert.deepEqual(view.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'done'])
  assert.equal(view.receipt.result, 'needs_organization')
  assert.ok(view.receipt.mapped.sources.some((s) => s.path === 'TODO.md'))
  assert.ok(view.receipt.created.writes.some((w) => w.path === '.awr/intake/GOALS.md'))
  assert.equal(view.receipt.awaitingConfirmation[0].status, 'candidate', 'the goal the subagent called active is capped by the CLI')
  assert.equal(view.receipt.reviewed.byReviewer, true)
  assert.equal(view.receipt.git.committed, false)
  assert.equal(subagents.started.length, 1)
  assert.match(readFileSync(join(f.root, '.awr', 'intake', 'GOALS.md'), 'utf8'), /Deliver a document portal \{#portal status=candidate\}/)
  assert.equal(f.git('rev-list', '--count', 'HEAD').toString().trim(), '1', 'nothing was committed')
  assert.ok(existsSync(join(cliStateDir(f.state))), 'the run is the CLI\'s, in its own directory')
  assert.equal((await controller.start(agent)).reason, 'already_initialized')
})

withCli('on a real awr, a failed review shows its reason, leaves the project untouched, and the next start reviews again', async (t) => {
  const f = realPortal(t)
  const agent = agentAt(f.root)
  let healthy = false
  const subagents = fakeSubagents((spec) => (healthy ? reviewer().startActivation(spec).then((a) => a.result) : Promise.reject(new Error('the model refused'))))
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => subagents, stateBase: f.state, warn: () => {} })

  await controller.start(agent)
  await controller.idle(f.root)
  const stopped = await controller.status(agent)
  assert.equal(stopped.state, 'stopped')
  assert.deepEqual({ step: stopped.stop.step, reason: stopped.stop.reason }, { step: 'review', reason: 'review_failed' })
  assert.match(stopped.stop.message, /the model refused/)
  assert.equal(existsSync(join(f.root, '.awr')), false, 'the project is untouched')

  healthy = true
  const resumed = await controller.start(agent)
  assert.equal(resumed.started, true)
  assert.equal(resumed.resumed, true)
  await controller.idle(f.root)
  assert.equal((await controller.status(agent)).state, 'completed')
})

withCli('on a real awr with no subagent service the draft is applied as generated and the receipt says so', async (t) => {
  const f = realPortal(t)
  const agent = agentAt(f.root)
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => undefined, stateBase: f.state })
  await controller.start(agent)
  await controller.idle(f.root)
  const view = await controller.status(agent)
  assert.equal(view.state, 'completed')
  assert.equal(view.receipt.reviewed.byReviewer, false)
})

const legacy = existsSync(lab) ? test : test.skip
legacy('an awr without the command keeps the plugin\'s own implementation, and the probe does not stop the project', async (t) => {
  const root = tmp(t, 'dsh-awr-cli-legacy-')
  const awr = createAwr({ env: { ...process.env, PATH: `${dirname(lab)}:${process.env.PATH}`, AWR_LOCAL_WEB: '0', AWR_LOCAL_HOME: tmp(t, 'dsh-awr-cli-legacy-home-') } })
  assert.equal(await cliTakeoverAvailable(awr, root), false)
  assert.equal(awr.stoppedError(root), undefined, 'asking did not stop awr for the project')
  assert.ok(await awr.run(root, ['capabilities']), 'awr still answers')
})
