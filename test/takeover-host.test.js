// The DSH half of the takeover (DSH-021): the controller, the reviewing subagent and its restrictions,
// the state the panel shows, and the /awr takeover command.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAwr } from '../lib/awr-runtime.js'
import { createAwrCommand } from '../lib/commands.js'
import { TakeoverStop } from '../lib/takeover.js'
import {
  REVIEW_MARKER,
  REVIEW_TOOLS,
  SENSITIVE_FILE,
  buildReviewPrompt,
  capGoalStatuses,
  keepIntakeWork,
  createReviewerPolicy,
  createSubagentReview,
  createTakeoverController,
  describeRun,
  formatRun,
  parseReview,
  resultText,
  takeoverRootFor,
} from '../lib/takeover-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

function portal(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-host-proj-'))
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-host-state-'))
  const local = mkdtempSync(join(tmpdir(), 'dsh-awr-host-local-'))
  t.after(() => {
    for (const dir of [root, state, local]) rmSync(dir, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'README.md'), '# Portal\n\nA document portal for the support team.\n')
  writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\n\n## Milestone 1: Upload\nUpload.\n')
  writeFileSync(join(root, 'TODO.md'), '# TODO\n- [x] Upload endpoint\n- [ ] Search endpoint\n')
  for (const [path, text] of Object.entries(extra)) writeFileSync(join(root, path), text)
  git('add', '-A')
  git('commit', '-q', '-m', 'upload endpoint')
  const env = { ...process.env, AWR_LOCAL_HOME: local, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  return { root: execFileSync('realpath', [root], { encoding: 'utf8' }).trim(), state, env, awr: createAwr({ env }), git }
}

const agentAt = (cwd, id = 'conv-1', extra = {}) => ({ session: { id, header: { cwd, ...extra } }, ...extra })

// --- which project -----------------------------------------------------------------------------------------

test('the project is the Git top level of the conversation\'s directory; an AWR project is recognized; broad directories are refused', async (t) => {
  const { root } = portal(t)
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  assert.deepEqual(await takeoverRootFor(join(root, 'packages', 'app')), { root })
  assert.deepEqual(await takeoverRootFor(root), { root })

  mkdirSync(join(root, '.awr'))
  writeFileSync(join(root, '.awr', 'project.toml'), '[project]\n')
  assert.deepEqual(await takeoverRootFor(join(root, 'packages', 'app')), { root, initialized: true })

  assert.match((await takeoverRootFor('/')).refused, /too broad/)
  assert.match((await takeoverRootFor(homedir())).refused, /too broad/)
  assert.match((await takeoverRootFor(undefined)).refused, /no working directory/)
  assert.match((await takeoverRootFor('relative/path')).refused, /no working directory/)
  const plain = mkdtempSync(join(tmpdir(), 'dsh-awr-host-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  assert.equal((await takeoverRootFor(plain)).root, execFileSync('realpath', [plain], { encoding: 'utf8' }).trim(), 'no Git: the directory itself')
})

// --- the prompt and the answer ------------------------------------------------------------------------------

const DRAFT = {
  schema_version: 1,
  project_root: '/p',
  inventory_fingerprint: 'fp',
  inventory: [{ path: 'README.md', bytes: 40 }, { path: 'docs/plan.md', bytes: 30 }],
  generated_files: { '.awr/intake/GOALS.md': '# Project goal {#intake-goal status=draft}\n\nplaceholder\n' },
  authority_mapping: { sources: [{ domain: 'ledger', role: 'primary', path: 'TODO.md', adapter: 'markdown-ledger-v1' }] },
  ambiguous_domains: [],
  gaps: ['No authoritative goal source was identified'],
}

test('the review prompt names the project, forbids questions and writes, and carries the draft, the files and the history', () => {
  const prompt = buildReviewPrompt({ root: '/work/portal', draft: DRAFT, history: '2 commits; newest first:\nabc1234 2026-11-12 search stub' })
  assert.ok(prompt.startsWith(REVIEW_MARKER))
  assert.match(prompt, /project at \/work\/portal\./)
  assert.match(prompt, /nobody is available to answer questions, so do not ask any/)
  assert.match(prompt, /only read files \(read, glob\)/)
  assert.match(prompt, /Never use active or confirmed/)
  assert.match(prompt, /Never invent business intent/)
  assert.match(prompt, /`priority` and `required` on a work item only when the material states them/)
  assert.match(prompt, /\.env files and key files are not available/)
  assert.match(prompt, /<draft>[\s\S]*placeholder[\s\S]*<\/draft>/)
  assert.match(prompt, /README\.md \(40 bytes\)/)
  assert.match(prompt, /abc1234 2026-11-12 search stub/)
  assert.match(buildReviewPrompt({ root: '/p', draft: { ...DRAFT, inventory: [] }, history: '' }), /\(no Git history\)/)
})

test('the reviewer\'s answer is parsed from a json fence or bare, merged over the draft, and refused when it is not usable', () => {
  const files = { '.awr/intake/GOALS.md': '# A goal {#g status=candidate}\n' }
  const fenced = parseReview(`I read the README.\n\n\`\`\`json\n${JSON.stringify({ generated_files: files, notes: '  Based   on README.md.  ' })}\n\`\`\`\n`, DRAFT)
  assert.equal(fenced.draft.generated_files['.awr/intake/GOALS.md'], files['.awr/intake/GOALS.md'])
  assert.equal(fenced.draft.inventory_fingerprint, 'fp', 'the rest of the draft is untouched')
  assert.equal(fenced.notes, 'Based on README.md.')
  assert.deepEqual(parseReview(JSON.stringify({ generated_files: files }), DRAFT).draft.generated_files, files)
  const merged = parseReview(JSON.stringify({ generated_files: { '.awr/intake/extra.md': 'x' } }), DRAFT)
  assert.equal(Object.keys(merged.draft.generated_files).length, 2, 'files it did not return keep the draft\'s text')
  // the last fence wins when the reviewer quotes an example first
  assert.deepEqual(parseReview('```json\n{"generated_files":{"a":"b"}}\n```\nand then\n```json\n' + JSON.stringify({ generated_files: files }) + '\n```', DRAFT).draft.generated_files, files)
  for (const bad of ['', 'no json here', '```json\nnot json\n```', '{"notes":"x"}', '{"generated_files":[]}', '{"generated_files":{}}', '[1]']) {
    assert.throws(() => parseReview(bad, DRAFT), (error) => error instanceof TakeoverStop && error.reason === 'review_failed', bad)
  }
})

test('a goal the reviewer calls active or confirmed is lowered to candidate; work items and other text are left alone', () => {
  const markdown = '# A goal {#g status=active}\n\nstatus=active in the body stays.\n\n# Another {#h status=Confirmed owner=x}\n\n# Fine {#i status=needs_confirmation}\n'
  const yaml = 'goals:\n- id: a\n  status: active\n  title: x\n- id: b\n  status: "confirmed"\n- id: c\n  status: candidate\nwork_items:\n- id: W-1\n  status: active\n  goal: a\n- id: W-2\n  status: confirmed\n'
  const { files, lowered } = capGoalStatuses({ '.awr/intake/GOALS.md': markdown, '.awr/intake/work-ledger.yaml': yaml })
  assert.equal(lowered, 4)
  assert.match(files['.awr/intake/GOALS.md'], /\{#g status=candidate\}/)
  assert.match(files['.awr/intake/GOALS.md'], /\{#h status=candidate owner=x\}/)
  assert.match(files['.awr/intake/GOALS.md'], /\{#i status=needs_confirmation\}/)
  assert.match(files['.awr/intake/GOALS.md'], /status=active in the body stays/)
  const y = files['.awr/intake/work-ledger.yaml']
  assert.match(y, /- id: a\n  status: candidate/)
  assert.match(y, /- id: b\n  status: "candidate"/)
  assert.match(y, /- id: c\n  status: candidate/)
  assert.match(y, /work_items:\n- id: W-1\n  status: active/, 'work items keep what the material says')
  assert.match(y, /- id: W-2\n  status: confirmed/)
  assert.deepEqual(capGoalStatuses({ '.awr/intake/GOALS.md': '# ok {#g status=candidate}\n' }), { files: { '.awr/intake/GOALS.md': '# ok {#g status=candidate}\n' }, lowered: 0 })
  const parsed = parseReview(JSON.stringify({ generated_files: { '.awr/intake/GOALS.md': '# G {#g status=confirmed}\n' }, notes: 'ok' }), DRAFT)
  assert.match(parsed.draft.generated_files['.awr/intake/GOALS.md'], /status=candidate/)
  assert.match(parsed.notes, /ok 1 goal status\(es\) the reviewer set to active or confirmed were lowered to candidate/)
})

test('resultText reads a string, content parts, or an object with output', () => {
  assert.equal(resultText('plain'), 'plain')
  assert.equal(resultText({ output: 'text' }), 'text')
  assert.equal(resultText({ output: [{ type: 'text', text: 'a' }, 'b'] }), 'ab')
  assert.equal(resultText({ text: 't' }), 't')
  assert.equal(resultText(undefined), '')
})

// --- the restriction and the guard ---------------------------------------------------------------------------

function restrictable() {
  const calls = []
  return { calls, ctx: { tools: { restrict: (filter) => calls.push(filter) } } }
}
const child = (id, parent, tools) => ({ session: { id, header: { cwd: '/p', parentSession: parent } }, ctx: tools.ctx })

test('the next child of the expecting conversation is restricted to reading, once; other agents are left alone', () => {
  const policy = createReviewerPolicy()
  const a = restrictable()
  const b = restrictable()
  const c = restrictable()
  assert.equal(policy.restrict(child('x', 'conv-1', a)), false, 'nothing expected yet')
  const end = policy.expect('conv-1', '/p')
  assert.equal(policy.restrict(child('other', 'conv-2', b)), false, 'a child of another conversation')
  assert.equal(policy.restrict({ session: { id: 'top', header: { cwd: '/p' } }, ctx: c.ctx }), false, 'a conversation, not a child')
  assert.equal(policy.restrict(child('rev', 'conv-1', a)), true)
  assert.deepEqual(a.calls, [{ allow: REVIEW_TOOLS }])
  assert.equal(policy.restrict(child('second', 'conv-1', c)), false, 'one reviewer per expectation')
  assert.deepEqual([b.calls, c.calls], [[], []])
  assert.deepEqual(policy.reviewers(), ['rev'])
  end()
  policy.forget('rev')
  assert.deepEqual(policy.reviewers(), [])
  assert.equal(policy.restrict(child('late', 'conv-1', a)), false, 'the expectation is over')
  // a parentSession given as an object
  const policy2 = createReviewerPolicy()
  policy2.expect('conv-1', '/p')
  assert.equal(policy2.restrict({ session: { id: 'r', header: { cwd: '/p', parentSession: { id: 'conv-1' } } }, ctx: a.ctx }), true)
})

test('a reviewer that cannot be restricted makes its creation fail, so it never runs unrestricted', () => {
  const policy = createReviewerPolicy()
  policy.expect('conv-1', '/p')
  assert.throws(() => policy.restrict({ session: { id: 'r', header: { parentSession: 'conv-1' } }, ctx: { tools: { restrict: () => { throw new Error('unknown tool') } } } }), /unknown tool/)
})

test('the guard keeps a reviewer to reading inside its project, and refuses credential files and every other tool', (t) => {
  const { root } = portal(t, { '.env': 'A=1\n' })
  const outside = mkdtempSync(join(tmpdir(), 'dsh-awr-host-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'secret.txt'), 'x')
  symlinkSync(outside, join(root, 'link'))
  const policy = createReviewerPolicy()
  policy.expect('conv-1', root)
  const tools = restrictable()
  policy.restrict(child('rev', 'conv-1', tools))
  const call = (name, args, id = 'rev') => policy.guard({ name, arguments: args, agent: { session: { id } } })
  assert.equal(call('read', { file_path: join(root, 'README.md') }), undefined)
  assert.equal(call('read', { file_path: 'docs/plan.md' }), undefined, 'relative to the project')
  assert.equal(call('glob', { pattern: '**/*.md' }), undefined, 'no path: the project')
  assert.match(call('read', { file_path: '/etc/hosts' }), /only read inside/)
  assert.match(call('read', { file_path: join(root, '..', 'elsewhere.txt') }), /only read inside/)
  assert.match(call('read', { file_path: join(root, 'link', 'secret.txt') }), /only read inside/, 'a symlink out of the project')
  assert.match(call('glob', { pattern: '*', path: '/' }), /only read inside/)
  assert.match(call('read', { file_path: join(root, '.env') }), /credentials/)
  for (const name of ['bash', 'write', 'edit', 'web_fetch', 'subagent', 'plugin_manager']) assert.match(call(name, { command: 'x' }), /may only use read, glob/, name)
  assert.match(call('grep', { pattern: 'x' }), /may only use read, glob/, 'grep could return lines of a credential file')
  assert.match(call('read', {}), /A path is required|only read/)
  assert.equal(call('bash', { command: 'x' }, 'someone-else'), undefined, 'other agents are not governed by this guard')
  assert.equal(call('read', { file_path: '/etc/hosts' }, 'someone-else'), undefined)
})

test('what counts as a credential file', () => {
  for (const name of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'tls/private.key', 'cert.p12', '.npmrc', '.netrc', 'credentials', 'credentials.json', 'secrets.yaml', 'secret.txt', '.git-credentials']) {
    assert.ok(SENSITIVE_FILE.test(name), name)
  }
  for (const name of ['README.md', 'docs/plan.md', 'src/environment.js', 'keyboard.js', 'package.json', 'monkey.md']) assert.ok(!SENSITIVE_FILE.test(name), name)
})

// --- the review by a subagent --------------------------------------------------------------------------------------

function fakeSubagents(answer, { onStart } = {}) {
  const started = []
  const subagents = {
    started,
    disposed: 0,
    async startActivation(spec) {
      started.push(spec)
      onStart?.(spec)
      const result = typeof answer === 'function' ? answer(spec) : answer
      return { childId: 'child-1', result: result instanceof Promise ? result : Promise.resolve(result), dispose: async () => { subagents.disposed += 1 } }
    },
  }
  return subagents
}
const goodAnswer = `\`\`\`json\n${JSON.stringify({ generated_files: { '.awr/intake/GOALS.md': '# A goal {#g status=candidate}\n' }, notes: 'n' })}\n\`\`\``

test('the review starts a child of the conversation with delivery to the caller, and returns the reviewed draft', async (t) => {
  const { root, state } = portal(t)
  const policy = createReviewerPolicy()
  const parent = agentAt(root, 'conv-1')
  let expectedWhileStarting
  const subagents = fakeSubagents({ output: goodAnswer }, { onStart: () => { expectedWhileStarting = true; policy.restrict(child('child-1', 'conv-1', restrictable())) } })
  const review = createSubagentReview({ getSubagents: () => subagents, policy, stateBase: state }, { parent })
  const answer = await review({ projectRoot: root, draft: DRAFT })
  assert.equal(answer.draft.generated_files['.awr/intake/GOALS.md'], '# A goal {#g status=candidate}\n')
  const [spec] = subagents.started
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller', 'the conversation is not interrupted by a completion notice')
  assert.equal(spec.request.parent, parent)
  assert.ok(spec.request.cwd.startsWith(state) && spec.request.cwd.endsWith('/review'), 'its own directory, outside the project')
  assert.ok(!spec.request.cwd.startsWith(root))
  assert.match(spec.request.prompt[0].text, new RegExp(REVIEW_MARKER.replace(/[[\]]/g, '\\$&')))
  assert.match(spec.request.prompt[0].text, /upload endpoint/, 'the Git history the reviewer cannot read itself')
  assert.ok(expectedWhileStarting && policy.reviewers().length === 0, 'the reviewer is forgotten when the review is over')
  assert.equal(subagents.disposed, 1)
})

test('a missing subagent service, a failing child, an unusable answer and a timeout each end the review with a reason', async (t) => {
  const { root, state } = portal(t)
  const parent = agentAt(root, 'conv-1')
  const run = (subagents, extra = {}) => createSubagentReview({ getSubagents: () => subagents, policy: createReviewerPolicy(), stateBase: state, ...extra }, { parent })({ projectRoot: root, draft: DRAFT })
  await assert.rejects(run(undefined), (e) => e instanceof TakeoverStop && e.reason === 'review_unavailable')
  await assert.rejects(run(fakeSubagents(() => Promise.reject(new Error('the model refused')))), (e) => e.reason === 'review_failed' && /the model refused/.test(e.message))
  await assert.rejects(run(fakeSubagents({ output: 'I could not decide.' })), (e) => e.reason === 'review_failed')
  // A timeout that is over before the child has even started (the start takes longer than the limit) is still a timeout.
  const slowStart = { started: [], disposed: 0, async startActivation() { await new Promise((r) => setTimeout(r, 40)); return { childId: 'c', result: new Promise(() => {}), dispose: async () => { slowStart.disposed += 1 } } } }
  const keep = setTimeout(() => {}, 10_000)
  try {
    await assert.rejects(run(slowStart, { timeoutMs: 5 }), (e) => e.reason === 'review_failed' && /too long/.test(e.message))
    assert.equal(slowStart.disposed, 1)
  } finally {
    clearTimeout(keep)
  }
  const hung = fakeSubagents(new Promise(() => {}))
  const keepAlive = setTimeout(() => {}, 10_000)
  try {
    await assert.rejects(run(hung, { timeoutMs: 30 }), (e) => e.reason === 'review_failed' && /too long/.test(e.message))
    assert.equal(hung.disposed, 1, 'the child is cancelled')
  } finally {
    clearTimeout(keepAlive)
  }
  const refusing = { startActivation: async () => { throw new Error('ACTIVATION_LIMIT_REACHED') } }
  await assert.rejects(run(refusing), (e) => e.reason === 'review_failed' && /ACTIVATION_LIMIT_REACHED/.test(e.message))
})

// --- the controller ----------------------------------------------------------------------------------------------------

/** A reviewer that answers with a candidate goal built from the draft in its prompt. */
function reviewerFor(draftFromPrompt = true) {
  return fakeSubagents((spec) => {
    const draft = JSON.parse(spec.request.prompt[0].text.split('<draft>')[1].split('</draft>')[0])
    const files = { ...draft.generated_files }
    for (const path of Object.keys(files)) if (path.endsWith('GOALS.md')) files[path] = '# Deliver a document portal {#portal status=candidate}\n\nThe README says so.\n\nProvenance: README.md; candidate.\n'
    return { output: `\`\`\`json\n${JSON.stringify({ generated_files: files, notes: 'from README.md' })}\n\`\`\`` }
  })
}

real('one start takes a project over in the background and the state and receipt follow; the conversation is bound afterwards', async (t) => {
  const f = portal(t)
  const agent = agentAt(f.root, 'conv-1')
  const rebound = []
  const events = []
  const subagents = reviewerFor()
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => subagents, stateBase: f.state, rebind: async (a) => rebound.push(a.session.id), trace: (e) => events.push(e.event) })

  assert.equal((await controller.status(agent)).state, 'not_initialized')
  const started = await controller.start(agent)
  assert.equal(started.started, true)
  assert.match(started.message, /runs in the background; this conversation stays usable/)
  assert.equal((await controller.status(agent)).state, 'running', 'it returned before the run finished')
  assert.equal((await controller.start(agent)).reason, 'running', 'a second click does not start a second run')
  await controller.idle(f.root)

  const view = await controller.status(agent)
  assert.equal(view.state, 'completed')
  assert.deepEqual(view.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'done'])
  assert.equal(view.receipt.result, 'needs_organization')
  assert.ok(view.receipt.mapped.sources.some((s) => s.path === 'TODO.md'))
  assert.ok(view.receipt.created.writes.some((w) => w.path === '.awr/intake/GOALS.md'))
  assert.equal(view.receipt.awaitingConfirmation[0].status, 'candidate')
  assert.equal(view.receipt.git.committed, false)
  assert.deepEqual(rebound, ['conv-1'], 'the conversation that clicked is bound to AWR')
  assert.ok(events.includes('takeover-finished'))
  assert.equal(subagents.started.length, 1, 'the draft was reviewed by a subagent')
  assert.match(readFileSync(join(f.root, '.awr', 'intake', 'GOALS.md'), 'utf8'), /Deliver a document portal/)
  assert.equal(f.git('rev-list', '--count', 'HEAD').toString().trim(), '1', 'nothing was committed')

  // Once the project is AWR's, another click says so; the view is the AWR project's.
  assert.equal((await controller.start(agent)).reason, 'already_initialized')
  assert.match(formatRun(view), /Takeover of .*: completed/)
  assert.match(formatRun(view), /Awaiting your confirmation: Deliver a document portal/)
})

real('a review that fails stops the run with its reason, leaves the project untouched, and the next start resumes', async (t) => {
  const f = portal(t)
  const agent = agentAt(f.root, 'conv-1')
  let healthy = false
  const subagents = {
    startActivation: async (spec) => (healthy ? reviewerFor().startActivation(spec) : { childId: 'c', result: Promise.reject(new Error('the model is down')), dispose: async () => {} }),
  }
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => subagents, stateBase: f.state, warn: () => {} })
  await controller.start(agent)
  await controller.idle(f.root)
  const stopped = await controller.status(agent)
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.stop.reason, 'review_failed')
  assert.equal(stopped.stop.step, 'review')
  assert.match(stopped.stop.message, /the model is down/)
  assert.ok(!existsSync(join(f.root, '.awr')), 'the project is untouched')
  assert.match(formatRun(stopped), /Stopped at review: review_failed/)

  healthy = true
  const again = await controller.start(agent)
  assert.equal(again.started, true)
  assert.equal(again.resumed, true)
  await controller.idle(f.root)
  assert.equal((await controller.status(agent)).state, 'completed')
})

real('without a subagent service the draft is applied as generated and says so in the receipt', async (t) => {
  const f = portal(t)
  const agent = agentAt(f.root, 'conv-1')
  const controller = createTakeoverController({ awr: f.awr, getSubagents: () => undefined, stateBase: f.state })
  await controller.start(agent)
  await controller.idle(f.root)
  const view = await controller.status(agent)
  assert.equal(view.state, 'completed')
  assert.equal(view.receipt.reviewed.byCallback, false)
})

test('a conversation outside any project, in a too-broad directory, or with no directory has nothing to take over', async () => {
  const controller = createTakeoverController({ awr: { run: async () => ({}), resolve: async () => ({}) }, getSubagents: () => undefined, stateBase: tmpdir() })
  const view = await controller.status(agentAt(homedir()))
  assert.equal(view.state, 'unavailable')
  assert.equal(view.stop.reason, 'too_broad')
  const refused = await controller.start(agentAt('/'))
  assert.equal(refused.started, false)
  assert.equal(refused.reason, 'too_broad')
  assert.equal((await controller.status({ session: { id: 'x', header: {} } })).state, 'unavailable')
})

test('a run that ended unexpectedly is logged and does not break the controller; an interrupted record is offered for continuing', async (t) => {
  const { root, state } = portal(t)
  const warnings = []
  const controller = createTakeoverController({ awr: { run: async () => ({}), resolve: async () => ({}) }, getSubagents: () => undefined, stateBase: state, warn: (m) => warnings.push(m), runner: async () => { throw new Error('boom') } })
  const agent = agentAt(root)
  assert.equal((await controller.start(agent)).started, true)
  await controller.idle(root)
  assert.match(warnings[0], /ended unexpectedly: boom/)
  assert.equal((await controller.start(agent)).started, true, 'it can be started again')
  await controller.idle(root)
  // A record left running by a process that died is shown as interrupted, not running.
  const { runDirFor } = await import('../lib/takeover.js')
  const dir = runDirFor(root, state)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'takeover.json'), JSON.stringify({ version: 1, id: 'r', projectRoot: root, startedAt: 1, updatedAt: 2, status: 'running', rounds: 1, steps: { preflight: { status: 'done' }, preview: { status: 'running' } }, stop: null }))
  const view = await controller.status(agent)
  assert.equal(view.state, 'interrupted')
  assert.equal(view.steps[1].status, 'running')
})

test('describeRun and formatRun cover every state', () => {
  assert.equal(describeRun({ root: '/p', initialized: true }).state, 'initialized')
  assert.equal(describeRun({ root: '/p' }).state, 'not_initialized')
  assert.equal(describeRun({ root: '/p', running: true, record: { status: 'running', steps: {} } }).state, 'running')
  assert.equal(describeRun({ root: '/p', record: { status: 'failed', steps: {}, stop: { step: 'review', reason: 'unexpected_error', message: 'x' } } }).state, 'failed')
  assert.match(formatRun(describeRun({ root: '/p' })), /Takeover of \/p: not_initialized/)
  assert.doesNotMatch(formatRun(describeRun({ root: '/p' })), /Steps done/)
  assert.match(formatRun(describeRun({ root: '/p', record: { status: 'stopped', steps: { preflight: { status: 'done' } }, stop: { step: 'preview', reason: 'secret_boundary', message: 'AWR refused a credential', detail: { path: 'docs/plan.md', line: 3, category: 'credential' } } } })), /Steps done: preflight[\s\S]*Stopped at preview: secret_boundary: AWR refused a credential \(docs\/plan\.md:3, credential\)/)
})

// --- the command ------------------------------------------------------------------------------------------------------------

test('/awr takeover starts it and answers at once; /awr takeover status shows the state in words or as JSON; it works outside an AWR project', async () => {
  const calls = []
  const takeover = {
    start: async (agent) => (calls.push(['start', agent.session.id]), { started: true, message: 'Started the takeover of /p.' }),
    status: async () => ({ projectRoot: '/p', state: 'running', steps: [{ name: 'preflight', status: 'done' }], stop: null, receipt: null }),
  }
  const command = createAwrCommand({ awr: { run: async () => { throw new Error('awr must not run') } }, bindings: { get: () => undefined }, takeover })
  const agent = agentAt('/p', 'conv-1')
  const started = await command({ agent, rawInput: 'takeover' })
  assert.deepEqual([started.kind, started.text], ['success', 'Started the takeover of /p.'])
  assert.deepEqual(calls, [['start', 'conv-1']])
  const words = await command({ agent, rawInput: 'takeover status' })
  assert.match(words.text, /Takeover of \/p: running/)
  const json = await command({ agent, rawInput: 'takeover status --json' })
  assert.equal(JSON.parse(json.text).state, 'running')
  assert.equal((await command({ agent, rawInput: 'takeover banana' })).kind, 'error')
  const refused = createAwrCommand({ awr: {}, bindings: { get: () => undefined }, takeover: { start: async () => ({ started: false, message: '/p is already an AWR project.' }) } })
  assert.deepEqual([await refused({ agent, rawInput: 'takeover' })].map((r) => [r.kind, r.text]), [['error', '/p is already an AWR project.']])
  const none = createAwrCommand({ awr: {}, bindings: { get: () => undefined } })
  assert.match((await none({ agent, rawInput: 'takeover' })).text, /not available/)
  const failing = createAwrCommand({ awr: {}, bindings: { get: () => undefined }, takeover: { start: async () => { throw new Error('no disk') } } })
  assert.match((await failing({ agent, rawInput: 'takeover' })).text, /could not be started: no disk/)
  assert.match((await command({ agent, rawInput: 'help' })).text, /\/awr takeover status/)
})

// --- the generated intake work is kept when the review leaves none -----------------------------------------------

const INTAKE_LEDGER = 'goals:\n- id: intake-goal\n  status: draft\n  title: Project goal\nwork_items:\n- id: INTAKE-001\n  kind: intake\n  status: ready\n  title: Verify project goals\n'
const REVIEWED_GOALS = 'goals:\n- id: g1\n  status: candidate\n  title: A real goal\n  summary: |-\n    Provenance: README.md.\n'

test('a ledger the reviewer returns with no work items gets the draft\'s intake work back', () => {
  const path = '.awr/intake/work-ledger.yaml'
  for (const empty of [`${REVIEWED_GOALS}work_items: []\n`, `${REVIEWED_GOALS}work_items:\n`, `${REVIEWED_GOALS}work_items: [ ]\n# nothing yet\n`, REVIEWED_GOALS]) {
    const { files, kept } = keepIntakeWork({ [path]: empty }, { [path]: INTAKE_LEDGER })
    assert.deepEqual(kept, [path], JSON.stringify(empty))
    assert.match(files[path], /^goals:\n- id: g1\n/, 'the reviewer\'s goals stay')
    assert.match(files[path], /work_items:\n- id: INTAKE-001\n {2}kind: intake\n {2}status: ready\n {2}title: Verify project goals\n$/, 'the draft\'s work is back, once')
    assert.equal(files[path].match(/work_items:/g).length, 1)
  }
})

test('work the reviewer wrote is never replaced, and what cannot be restored safely is left alone', () => {
  const path = '.awr/intake/work-ledger.yaml'
  const real = `${REVIEWED_GOALS}work_items:\n- id: W-1\n  kind: task\n  status: planned\n  title: Real work\n`
  const flow = `${REVIEWED_GOALS}work_items: [{id: W-2, title: x}]\n`
  for (const text of [real, flow]) assert.deepEqual(keepIntakeWork({ [path]: text }, { [path]: INTAKE_LEDGER }), { files: { [path]: text }, kept: [] })
  // a draft with no work items, a file the draft does not have, Markdown, and content after the empty key
  assert.deepEqual(keepIntakeWork({ [path]: `${REVIEWED_GOALS}work_items: []\n` }, { [path]: REVIEWED_GOALS }).kept, [])
  assert.deepEqual(keepIntakeWork({ [path]: `${REVIEWED_GOALS}work_items: []\n` }, {}).kept, [])
  assert.deepEqual(keepIntakeWork({ '.awr/intake/GOALS.md': '# G\n' }, { '.awr/intake/GOALS.md': 'work_items:\n- x\n' }).kept, [])
  const trailing = `${REVIEWED_GOALS}work_items: []\nextras:\n  a: 1\n`
  assert.deepEqual(keepIntakeWork({ [path]: trailing }, { [path]: INTAKE_LEDGER }), { files: { [path]: trailing }, kept: [] })
})

test('parseReview puts the intake work back and says so, and the prompt tells the reviewer to keep it', () => {
  const path = '.awr/intake/work-ledger.yaml'
  const draft = { ...DRAFT, generated_files: { ...DRAFT.generated_files, [path]: INTAKE_LEDGER } }
  const parsed = parseReview(JSON.stringify({ generated_files: { [path]: `${REVIEWED_GOALS}work_items: []\n` }, notes: 'Based on README.md.' }), draft)
  assert.match(parsed.draft.generated_files[path], /id: INTAKE-001/)
  assert.match(parsed.notes, /Based on README\.md\. The reviewer left no work items, so the generated intake work was kept \(\.awr\/intake\/work-ledger\.yaml\)/)
  const untouched = parseReview(JSON.stringify({ generated_files: { [path]: `${REVIEWED_GOALS}work_items:\n- id: W-1\n  status: planned\n` } }), draft)
  assert.doesNotMatch(untouched.draft.generated_files[path], /INTAKE-001/)
  assert.equal(untouched.notes, undefined)
  const prompt = buildReviewPrompt({ root: '/p', draft: DRAFT, history: '' })
  assert.match(prompt, /Keep the draft's generated intake work item \(INTAKE-001\)/)
  assert.match(prompt, /never leave work_items empty/)
})
