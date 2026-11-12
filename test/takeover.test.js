// The unattended takeover (DSH-020), against the real awr on disposable projects, and scripted
// where the real awr cannot be made to fail on demand.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AwrError, createAwr } from '../lib/awr-runtime.js'
import { STEPS, TakeoverStop, classify, defaultStateBase, runDirFor, runTakeover, validateReviewedDraft } from '../lib/takeover.js'

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/** Every file under `dir`, with content, as one digest: two equal digests mean byte-identical trees. */
function digest(dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      const name = relative(dir, full)
      if (entry.isDirectory()) {
        hash.update(`d:${name}\n`)
        walk(full)
      } else if (entry.isFile()) {
        hash.update(`f:${name}:${statSync(full).size}\n`)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.name === '.git' && current === dir) continue
      if (entry.isDirectory()) walk(full)
      else out.push(relative(dir, full))
    }
  }
  walk(dir)
  return out.sort()
}

const PORTAL = {
  'README.md': '# Portal\n\nA document portal for the support team. Readers should be able to find a document by title or text.\n',
  'docs/plan.md': '# Plan\n\n## Milestone 1: Upload\nUpload and store documents.\n\n## Milestone 2: Search\nSearch by title and body text.\n',
  'TODO.md': '# TODO\n- [x] Upload endpoint\n- [ ] Search endpoint\n- [ ] Access control\n',
  'package.json': '{"name":"portal"}\n',
}
const README_ONLY = { 'README.md': '# Notes app\n\nA small notes app. Users can write and tag notes.\n' }

/** A project with two commits, in a temporary directory removed at the end of the test. */
function fixture(t, files = PORTAL) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-proj-'))
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-state-'))
  const local = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-local-'))
  t.after(() => {
    for (const dir of [root, state, local]) rmSync(dir, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(root, 'NOTES.txt'), 'more\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'second')
  const env = { ...process.env, AWR_LOCAL_HOME: local, AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const head = () => String(git('rev-parse', 'HEAD')).trim()
  const commits = () => String(git('rev-list', '--count', 'HEAD')).trim()
  return { root, state, env, awr: createAwr({ env }), head, commits, git }
}

/** A review that records a concrete goal, with its provenance, as the reviewer of the draft would. */
const concreteLedger = `goals:
- id: notes
  status: active
  title: Users write and tag notes
  success_criteria:
  - A user can write a note and tag it
  summary: "README.md: A small notes app. Users can write and tag notes."
work_items:
- id: NOTES-1
  title: Add tags to notes
  kind: implementation
  status: planned
  priority: P1
  required: true
  goal: notes
  acceptance:
  - A note can be tagged and found by its tag
  next_action: Add a tag field to the note model
`
function reviewLedger(draft) {
  const reviewed = structuredClone(draft)
  reviewed.generated_files['.awr/intake/work-ledger.yaml'] = concreteLedger
  return reviewed
}
function reviewPortalGoal(draft) {
  const reviewed = structuredClone(draft)
  reviewed.generated_files['.awr/intake/GOALS.md'] = '# Deliver a document portal for the support team {#portal status=candidate}\n\nReaders find a document by title or text.\n\nProvenance: README.md and docs/plan.md; candidate until the owner confirms.\n'
  return reviewed
}

// --- the happy paths ----------------------------------------------------------------------------------------

real('a project with a Markdown ledger goes from nothing to an accepted init and an organization state, with no human input', async (t) => {
  const f = fixture(t)
  const before = { head: f.head(), commits: f.commits(), files: listFiles(f.root) }
  const events = []
  const result = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state, review: ({ draft }) => reviewPortalGoal(draft), onEvent: (e) => events.push(`${e.step}:${e.status}`) })
  assert.equal(result.outcome, 'completed', JSON.stringify(result.record.stop))
  assert.deepEqual(STEPS.filter((step) => result.record.steps[step]?.status === 'done'), STEPS)
  assert.ok(existsSync(join(f.root, '.awr', 'project.toml')))
  const organized = result.record.steps.organize.result
  assert.equal(organized.state, 'needs_organization', 'a goal the owner has not confirmed does not make the project ready')
  assert.equal(organized.goalTotal, 1)
  assert.match(organized.goals[0].key, /GOALS\.md#portal$/)
  assert.equal(organized.goals[0].status, 'candidate')
  assert.ok(organized.actions.includes('goals'))
  assert.ok(events.includes('preview:running') && events.includes('receipt:done'))

  // The receipt lists what was mapped, created and left for confirmation.
  const receipt = JSON.parse(readFileSync(join(f.root, '.awr', 'takeover', 'receipt.json'), 'utf8'))
  assert.ok(receipt.mapped.sources.some((source) => source.path === 'TODO.md' && source.adapter === 'markdown-ledger-v1'))
  assert.ok(receipt.created.writes.some((write) => write.path === '.awr/intake/GOALS.md'))
  assert.deepEqual(receipt.created.writtenOutsideAwr, ['.gitignore'])
  assert.deepEqual(receipt.reviewed.changedFiles, ['.awr/intake/GOALS.md'])
  assert.equal(receipt.awaitingConfirmation[0].status, 'candidate')
  assert.equal(receipt.result, 'needs_organization')
  assert.deepEqual(receipt.git, { headBefore: before.head, headAfter: before.head, committed: false, pushed: false, headMoved: false })
  assert.ok(existsSync(join(result.runDir, 'receipt.json')))

  // Nothing is committed or pushed, and only .awr/ and AWR's own .gitignore entries were added.
  assert.equal(f.head(), before.head)
  assert.equal(f.commits(), before.commits)
  const added = listFiles(f.root).filter((path) => !before.files.includes(path))
  assert.ok(added.length > 0 && added.every((path) => path.startsWith('.awr/') || path === '.gitignore'), added.join(', '))
  assert.deepEqual(before.files.filter((path) => !listFiles(f.root).includes(path)), [], 'no existing file was removed')
  assert.match(readFileSync(join(f.root, '.gitignore'), 'utf8'), /\.awr\/state\.db/)
})

real('a project with only a README is organized to ready when the review writes concrete work', async (t) => {
  const f = fixture(t, README_ONLY)
  const result = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state, review: ({ draft }) => reviewLedger(draft) })
  assert.equal(result.outcome, 'completed', JSON.stringify(result.record.stop))
  const organized = result.record.steps.organize.result
  assert.equal(organized.state, 'ready', JSON.stringify(organized.gaps))
  assert.ok(organized.executableWorkTotal >= 1)
  assert.equal(result.receipt.result, 'ready')
  // The goal AWR read back is the one the reviewer wrote, not a placeholder.
  assert.equal(result.receipt.organization.goalTotal, 1)
})

real('without a review callback the draft is applied as generated and the project ends in needs_organization, not ready', async (t) => {
  const f = fixture(t, README_ONLY)
  const result = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state })
  assert.equal(result.outcome, 'completed', JSON.stringify(result.record.stop))
  assert.equal(result.record.steps.review.result.reviewed, false)
  assert.equal(result.record.steps.organize.result.state, 'needs_organization')
  assert.notEqual(result.receipt.result, 'ready')
})

real('the organize callback edits the authoritative sources between inspections, a bounded number of times', async (t) => {
  const f = fixture(t, README_ONLY)
  const rounds = []
  const result = await runTakeover({
    awr: f.awr,
    projectRoot: f.root,
    stateDir: f.state,
    organize: async ({ projectRoot, summary, round }) => {
      rounds.push({ round, state: summary.state, actions: summary.actions })
      writeFileSync(join(projectRoot, '.awr', 'intake', 'work-ledger.yaml'), concreteLedger)
    },
  })
  assert.equal(result.outcome, 'completed', JSON.stringify(result.record.stop))
  assert.equal(rounds.length, 1, 'one round was enough: the second inspection was ready')
  assert.equal(rounds[0].state, 'needs_organization')
  assert.equal(result.record.steps.organize.result.state, 'ready')
  assert.equal(result.record.steps.organize.result.rounds, 1)

  // A callback that changes nothing is called at most maxOrganizeRounds times.
  const g = fixture(t, README_ONLY)
  let calls = 0
  const stuck = await runTakeover({ awr: g.awr, projectRoot: g.root, stateDir: g.state, maxOrganizeRounds: 2, organize: async () => { calls += 1 } })
  assert.equal(stuck.outcome, 'completed')
  assert.equal(calls, 2)
  assert.equal(stuck.record.steps.organize.result.state, 'needs_organization')
})

// --- before accept, nothing changes -----------------------------------------------------------------------------

real('a failure before accept leaves the project byte-identical: secret, a failing review, a rejected review, a stop from the callback', async (t) => {
  const cases = [
    { name: 'secret in a source', files: { ...PORTAL, 'docs/plan.md': `${PORTAL['docs/plan.md']}\nexport AWS_SECRET_ACCESS_KEY=${SECRET}\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----\n` }, options: {}, reason: 'secret_boundary', outcome: 'stopped' },
    { name: 'review throws', options: { review: async () => { throw new Error('the reviewer lost its model') } }, reason: 'unexpected_error', outcome: 'failed' },
    { name: 'review changes the inventory', options: { review: ({ draft }) => ({ ...draft, inventory_fingerprint: 'sha256:other' }) }, reason: 'review_rejected', outcome: 'stopped' },
    { name: 'review writes outside .awr/intake', options: { review: ({ draft }) => ({ ...draft, generated_files: { '../escape.md': 'x' } }) }, reason: 'review_rejected', outcome: 'stopped' },
    { name: 'callback stops the run', options: { review: async () => { throw new TakeoverStop('needs_owner', 'the material does not say what this project is for') } }, reason: 'needs_owner', outcome: 'stopped' },
  ]
  for (const item of cases) {
    const f = fixture(t, item.files)
    const before = digest(f.root)
    const result = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state, ...item.options })
    assert.equal(result.outcome, item.outcome, `${item.name}: ${JSON.stringify(result.record.stop)}`)
    assert.equal(result.record.stop.reason, item.reason, item.name)
    assert.equal(digest(f.root), before, `${item.name}: the project is byte-identical`)
    assert.ok(!existsSync(join(f.root, '.awr')), item.name)
    assert.equal(result.record.steps.accept, undefined, `${item.name}: accept was never reached`)
  }
})

real('a secret stops the run with where it is and what kind it is, and never what it is', async (t) => {
  const f = fixture(t, { ...PORTAL, 'docs/plan.md': `${PORTAL['docs/plan.md']}\nexport AWS_SECRET_ACCESS_KEY=${SECRET}\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----\n` })
  const result = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state })
  assert.equal(result.record.stop.step, 'preview')
  assert.equal(result.record.stop.reason, 'secret_boundary')
  assert.equal(result.record.stop.detail.category, 'credential')
  assert.equal(result.record.stop.detail.path, 'docs/plan.md')
  assert.ok(Number.isInteger(result.record.stop.detail.line))
  const everything = readFileSync(join(result.runDir, 'takeover.json'), 'utf8')
  assert.ok(!everything.includes(SECRET) && !everything.includes('MIIEowIBAAKCAQEAfake'))
  assert.deepEqual(readdirSync(result.runDir).filter((name) => name.endsWith('.json')).sort(), ['takeover.json'], 'no draft was written for a project that failed the boundary')
})

real('a source AWR cannot read stops the run before anything is written', async (t) => {
  const bad = fixture(t, { 'README.md': '# P\n', 'docs/plan.md': '# Plan\n\u0000\u0000\n' })
  writeFileSync(join(bad.root, 'docs', 'plan.md'), Buffer.from([0x23, 0x20, 0x50, 0x0a, 0xff, 0xfe, 0x0a]))
  const before = digest(bad.root)
  const result = await runTakeover({ awr: bad.awr, projectRoot: bad.root, stateDir: bad.state })
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.record.stop.reason, 'source_unreadable')
  assert.match(result.record.stop.message, /UTF-8/, 'AWR\'s own reason is kept')
  assert.equal(digest(bad.root), before)

  const yaml = fixture(t, { 'README.md': '# P\n', 'work-ledger.yaml': 'goals:\n  - id: g\nwork_items: [\n  : broken\n' })
  const second = await runTakeover({ awr: yaml.awr, projectRoot: yaml.root, stateDir: yaml.state })
  assert.equal(second.record.stop.reason, 'source_unreadable')
  assert.ok(!existsSync(join(yaml.root, '.awr')))
})

real('several candidate ledgers: the run stops before writing unless the review chooses one', async (t) => {
  const table = (id) => `# Tasks\n| id | title | status |\n|---|---|---|\n| ${id} | do ${id} | pending |\n`
  const files = { 'README.md': '# A\n', 'alpha-ledger.md': table('a'), 'beta-ledger.md': table('b') }
  const f = fixture(t, files)
  const before = digest(f.root)
  const seen = []
  const stopped = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state, review: ({ draft, ambiguousDomains }) => (seen.push(ambiguousDomains), draft) })
  assert.deepEqual(seen, [['ledger']], 'the reviewer is told which domain is ambiguous')
  assert.equal(stopped.outcome, 'stopped')
  assert.equal(stopped.record.stop.reason, 'ambiguous_authority')
  assert.equal(stopped.record.stop.step, 'accept')
  assert.deepEqual(stopped.record.stop.detail.domains, ['ledger'])
  assert.equal(stopped.record.rounds, 1, 'not retried as if the inventory had changed')
  assert.equal(digest(f.root), before)

  const g = fixture(t, files)
  const resolved = await runTakeover({
    awr: g.awr,
    projectRoot: g.root,
    stateDir: g.state,
    review: ({ draft }) => {
      const reviewed = structuredClone(draft)
      reviewed.authority_mapping.sources.push({ domain: 'ledger', role: 'primary', path: 'alpha-ledger.md', locator: null, adapter: 'markdown-ledger-v1', options: {} })
      reviewed.ambiguous_domains = []
      return reviewed
    },
  })
  assert.equal(resolved.outcome, 'completed', JSON.stringify(resolved.record.stop))
  assert.equal(resolved.record.steps.preview.result.ambiguousDomains[0], 'ledger')
})

// --- stops that need an initialized project -------------------------------------------------------------------

real('an existing active session stops the run; an initialized project with none stops unless adopted', async (t) => {
  const f = fixture(t, README_ONLY)
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', f.root, '--json', ...args], { env: f.env, encoding: 'utf8' }))
  cli('init', '--goal', 'A goal', '--accept')
  const revision = cli('status').project_revision
  const started = cli('session', 'start', '--work', 'INTAKE-001', '--claim', '--agent', 'someone-else', '--provider', 'p', '--model', 'm', '--expected-revision', String(revision))
  const stopped = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state })
  assert.equal(stopped.outcome, 'stopped')
  assert.equal(stopped.record.stop.reason, 'active_session')
  assert.equal(stopped.record.stop.detail.sessions[0].id, started.session.id)
  assert.equal(stopped.record.stop.detail.sessions[0].agent, 'someone-else')

  cli('session', 'end', '--session', started.session.id, '--outcome', 'ended', '--expected-revision', String(cli('status').project_revision))
  const initialized = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state })
  assert.equal(initialized.record.stop.reason, 'already_initialized')

  const adopted = await runTakeover({ awr: f.awr, projectRoot: f.root, stateDir: f.state, adopt: true })
  assert.equal(adopted.outcome, 'completed', JSON.stringify(adopted.record.stop))
  assert.equal(adopted.record.steps.preview.status, 'skipped')
  assert.equal(adopted.record.steps.accept.status, 'skipped')
  assert.equal(adopted.record.steps.organize.status, 'done')
})

test('a directory that does not exist and a missing awr stop with a reason', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-state-'))
  t.after(() => rmSync(state, { recursive: true, force: true }))
  const gone = await runTakeover({ awr: { run: async () => ({}), resolve: async () => ({}) }, projectRoot: join(state, 'nowhere'), stateDir: state })
  assert.equal(gone.record.stop.reason, 'not_a_directory')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-dir-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const missing = await runTakeover({ awr: { run: async () => ({}), resolve: async () => { throw new AwrError('missing', 'No awr was found.') } }, projectRoot: dir, stateDir: state })
  assert.equal(missing.record.stop.reason, 'awr_unavailable')
})

// --- scripted awr: the stops the real awr cannot be made to give on demand -----------------------------------

/** A runner over a real directory that answers init and inspect from a script. */
function scriptedAwr(root, script = {}) {
  const calls = []
  const draft = { schema_version: 1, project_root: root, inventory_fingerprint: 'fp-1', inventory: [{ path: 'README.md' }], generated_files: { '.awr/intake/GOALS.md': '# g {#g status=draft}\n' }, authority_mapping: { sources: [] }, gaps: [], git: { head: null } }
  return {
    calls,
    async resolve() {
      return { cli: 'scripted' }
    },
    async run(projectRoot, args) {
      calls.push(args.join(' '))
      const key = args.join(' ')
      if (script[key]) return script[key](args)
      if (args[0] === 'init' && args.includes('--write-draft')) {
        writeFileSync(args[args.indexOf('--write-draft') + 1], JSON.stringify(draft))
        return { ok: true }
      }
      if (args[0] === 'init' && args.includes('--accept')) {
        mkdirSync(join(root, '.awr'), { recursive: true })
        writeFileSync(join(root, '.awr', 'project.toml'), '[project]\n')
        return { initialized: true }
      }
      if (args[0] === 'init' && args.includes('--from-draft')) return { status: 'preview', preview: { can_apply: true, fingerprint: 'sha256:fd', writes: [{ action: 'create', path: '.awr/project.toml' }, { action: 'create', path: '.gitignore' }] } }
      if (args[0] === 'init') return { status: 'preview', preview: { can_apply: true, fingerprint: 'sha256:p', source_issues: [], writes: [] } }
      if (args[0] === 'intake') return { organization: { state: 'needs_organization', gap_total: 1, goal_total: 1, goals: [{ key: 'g', status: 'draft' }], actions: [{ id: 'goals' }], gaps: [] } }
      if (args[0] === 'source') return { ok: true }
      if (args[0] === 'session') return { sessions: [] }
      throw new Error(`unexpected awr call: ${key}`)
    },
  }
}

function scratchProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-s-'))
  const state = mkdtempSync(join(tmpdir(), 'dsh-awr-takeover-ss-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  writeFileSync(join(root, 'README.md'), '# P\n')
  return { root, state }
}

test('Unsupported, a migration prompt, a runtime that changed and a timeout each stop the run with their own reason', async (t) => {
  const cases = [
    ['Unsupported', new AwrError('unsupported', 'Unsupported: this awr cannot do that', { code: 'Unsupported' }), 'unsupported'],
    ['schema', new AwrError('schema_mismatch', 'The database is newer than this awr.', { code: 'Storage' }), 'migration_prompt'],
    ['recovery', new AwrError('recovery_required', 'MutationIncomplete: inspect the receipt', { code: 'MutationIncomplete' }), 'migration_prompt'],
    ['changed binary', new AwrError('binary_changed', 'The binary changed.'), 'runtime_changed'],
    ['timeout', new AwrError('timeout', 'awr did not finish within 60000 ms.'), 'timeout'],
  ]
  for (const [name, error, reason] of cases) {
    const { root, state } = scratchProject(t)
    const awr = scriptedAwr(root, { init: () => { throw error } })
    const before = digest(root)
    const result = await runTakeover({ awr, projectRoot: root, stateDir: state })
    assert.equal(result.outcome, 'stopped', name)
    assert.equal(result.record.stop.reason, reason, name)
    assert.equal(result.record.stop.step, 'preview', name)
    assert.ok(result.record.stop.message.length > 10, name)
    assert.equal(digest(root), before, name)
  }
})

test('an organization state of source_unreadable after accept stops the run, and an uninitialized one is reported', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root, { 'intake inspect': () => ({ organization: { state: 'source_unreadable', gaps: [{ code: 'x', detail: 'cannot read' }] } }) })
  const result = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(result.record.stop.reason, 'source_unreadable')
  assert.equal(result.record.stop.step, 'organize')
  const other = scratchProject(t)
  const awr2 = scriptedAwr(other.root, { 'intake inspect': () => ({ organization: { state: 'not_initialized' } }) })
  assert.equal((await runTakeover({ awr: awr2, projectRoot: other.root, stateDir: other.state })).record.stop.reason, 'accept_incomplete')
})

test('init would write outside .awr/ beyond .gitignore: the run stops before accept; allowGitignore false stops on .gitignore', async (t) => {
  const { root, state } = scratchProject(t)
  const evil = scriptedAwr(root)
  const original = evil.run.bind(evil)
  evil.run = async (projectRoot, args) => {
    if (args[0] === 'init' && args.includes('--from-draft') && !args.includes('--accept')) {
      return { status: 'preview', preview: { can_apply: true, fingerprint: 'sha256:fd', writes: [{ action: 'create', path: '.awr/project.toml' }, { action: 'update', path: 'src/index.js' }, { action: 'create', path: '../outside.txt' }] } }
    }
    return original(projectRoot, args)
  }
  const result = await runTakeover({ awr: evil, projectRoot: root, stateDir: state })
  assert.equal(result.record.stop.reason, 'unexpected_write')
  assert.deepEqual(result.record.stop.detail.paths, ['src/index.js', '../outside.txt'])
  assert.ok(!evil.calls.some((call) => call.includes('--accept')), 'accept was not run')
  assert.ok(!existsSync(join(root, '.awr')))

  const strict = scratchProject(t)
  const strictAwr = scriptedAwr(strict.root)
  const refused = await runTakeover({ awr: strictAwr, projectRoot: strict.root, stateDir: strict.state, allowGitignore: false })
  assert.equal(refused.record.stop.reason, 'unexpected_write')
  assert.deepEqual(refused.record.stop.detail.paths, ['.gitignore'])
})

test('a project that changes while it is reviewed goes back to preview, up to maxRounds, then stops', async (t) => {
  const { root, state } = scratchProject(t)
  let conflicts = 1
  const conflict = new AwrError('failed', 'SourceConflict: project inventory changed', { code: 'SourceConflict', awrMessage: 'project inventory changed' })
  const awr = scriptedAwr(root)
  const original = awr.run.bind(awr)
  awr.run = async (projectRoot, args) => {
    if (args[0] === 'init' && args.includes('--from-draft') && !args.includes('--accept') && conflicts-- > 0) throw conflict
    return original(projectRoot, args)
  }
  const rounds = []
  const result = await runTakeover({ awr, projectRoot: root, stateDir: state, review: ({ draft, round }) => (rounds.push(round), draft) })
  assert.equal(result.outcome, 'completed')
  assert.deepEqual(rounds, [1, 2], 'the draft was reviewed again')
  assert.equal(result.record.rounds, 2)

  const stubborn = scratchProject(t)
  const always = scriptedAwr(stubborn.root)
  const originalAlways = always.run.bind(always)
  always.run = async (projectRoot, args) => {
    if (args[0] === 'init' && args.includes('--from-draft') && !args.includes('--accept')) throw conflict
    return originalAlways(projectRoot, args)
  }
  const stopped = await runTakeover({ awr: always, projectRoot: stubborn.root, stateDir: stubborn.state, maxRounds: 2 })
  assert.equal(stopped.outcome, 'stopped')
  assert.equal(stopped.record.stop.reason, 'inventory_changed')
  assert.match(stopped.record.stop.message, /2 rounds/)
  assert.ok(!existsSync(join(stubborn.root, '.awr')))
})

test('an accept that fails part way is reported as partial and is not resumed over', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root, {})
  const original = awr.run.bind(awr)
  awr.run = async (projectRoot, args) => {
    if (args.includes('--accept')) {
      mkdirSync(join(root, '.awr'), { recursive: true })
      writeFileSync(join(root, '.awr', 'project.toml'), '[project]\n')
      throw new AwrError('failed', 'Io: disk full', { code: 'Io', awrMessage: 'disk full' })
    }
    return original(projectRoot, args)
  }
  const result = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(result.record.stop.reason, 'accept_failed_partial')
  assert.match(result.record.stop.message, /incomplete \.awr\//)
})

// --- persistence and resuming ------------------------------------------------------------------------------------

test('each step is persisted as it finishes, and a finished run is returned without running awr again', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  const first = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(first.outcome, 'completed')
  const saved = JSON.parse(readFileSync(join(first.runDir, 'takeover.json'), 'utf8'))
  assert.equal(saved.status, 'completed')
  assert.deepEqual(STEPS.map((step) => saved.steps[step].status), STEPS.map(() => 'done'))
  const accepted = awr.calls.filter((call) => call.includes('--accept'))
  assert.equal(accepted.length, 1)
  assert.match(accepted[0], /^init --from-draft \S+reviewed\.json --accept --expected-preview sha256:fd$/, 'accept names the fingerprint of the reviewed preview')
  const calls = awr.calls.length
  const again = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(again.outcome, 'completed')
  assert.equal(awr.calls.length, calls, 'nothing was run')
  assert.equal(again.receipt.result, 'needs_organization')
})

test('a run interrupted at any awr call resumes from that step and ends where an uninterrupted run ends', async (t) => {
  const baseline = scratchProject(t)
  const clean = scriptedAwr(baseline.root)
  await runTakeover({ awr: clean, projectRoot: baseline.root, stateDir: baseline.state })
  const total = clean.calls.length
  assert.ok(total >= 5)
  for (let crashAt = 1; crashAt <= total; crashAt += 1) {
    const { root, state } = scratchProject(t)
    const awr = scriptedAwr(root)
    const original = awr.run.bind(awr)
    let count = 0
    awr.run = async (projectRoot, args) => {
      count += 1
      if (count === crashAt) throw new Error('the process died')
      return original(projectRoot, args)
    }
    const interrupted = await runTakeover({ awr, projectRoot: root, stateDir: state })
    assert.equal(interrupted.outcome, 'failed', `crash at call ${crashAt}`)
    assert.equal(interrupted.record.stop.reason, 'unexpected_error')
    const stoppedAt = interrupted.record.stop.step
    const doneBefore = STEPS.filter((step) => interrupted.record.steps[step]?.status === 'done')
    const resumedCalls = []
    awr.run = async (projectRoot, args) => (resumedCalls.push(args.join(' ')), original(projectRoot, args))
    const resumed = await runTakeover({ awr, projectRoot: root, stateDir: state })
    assert.equal(resumed.outcome, 'completed', `resume after crash at call ${crashAt}: ${JSON.stringify(resumed.record.stop)}`)
    assert.deepEqual(STEPS.filter((step) => resumed.record.steps[step]?.status === 'done'), STEPS)
    assert.equal(resumed.record.id, interrupted.record.id, 'the same run was resumed')
    assert.equal(resumed.receipt.result, 'needs_organization')
    // A step that had finished is not run again.
    if (doneBefore.includes('preview')) assert.ok(!resumedCalls.some((call) => call === 'init' || call.startsWith('init --write-draft')), `crash at ${crashAt}: the preview was repeated`)
    if (doneBefore.includes('accept')) assert.ok(!resumedCalls.some((call) => call.includes('--from-draft')), `crash at ${crashAt}: accept was repeated`)
    if (doneBefore.includes('organize')) assert.ok(!resumedCalls.some((call) => call.startsWith('intake')), `crash at ${crashAt}: the inspection was repeated`)
    assert.ok(stoppedAt, `crash at ${crashAt}`)
  }
})

test('a crash inside the review or the organize callback resumes at that callback', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  let reviews = 0
  const options = { awr, projectRoot: root, stateDir: state, review: ({ draft }) => { reviews += 1; if (reviews === 1) throw new Error('model error'); return draft }, organize: async () => {} }
  const first = await runTakeover(options)
  assert.equal(first.outcome, 'failed')
  assert.equal(first.record.stop.step, 'review')
  assert.equal(first.record.steps.preview.status, 'done')
  const previewCalls = awr.calls.filter((call) => call === 'init').length
  const second = await runTakeover(options)
  assert.equal(second.outcome, 'completed')
  assert.equal(reviews, 2)
  assert.equal(awr.calls.filter((call) => call === 'init').length, previewCalls, 'the preview was not repeated')
})

test('an accept that awr completed but whose answer was lost is recognized on resume instead of being run again', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  const original = awr.run.bind(awr)
  let lost = false
  awr.run = async (projectRoot, args) => {
    const result = await original(projectRoot, args)
    if (args.includes('--accept') && !lost) {
      lost = true
      throw new Error('the answer never arrived')
    }
    return result
  }
  const first = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(first.outcome, 'stopped')
  assert.equal(first.record.stop.reason, 'accept_failed_partial', 'what is on disk says awr started; the run does not guess it finished')
  assert.equal(first.record.steps.accept.attempted, true)
  const acceptsBefore = awr.calls.filter((call) => call.includes('--accept')).length
  const second = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(second.outcome, 'completed', JSON.stringify(second.record.stop))
  assert.equal(second.record.steps.accept.result.recovered, true)
  assert.equal(awr.calls.filter((call) => call.includes('--accept')).length, acceptsBefore, 'accept was not run twice')
  assert.equal(second.receipt.created.recovered, true)
})

test('a run killed while accept was running (record says running) resumes by recognizing the initialized project', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  const done = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(done.outcome, 'completed')
  const recordPath = join(done.runDir, 'takeover.json')
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  record.status = 'running'
  record.steps.accept = { status: 'running', attempted: true, startedAt: 1 }
  delete record.steps.organize
  delete record.steps.receipt
  writeFileSync(recordPath, JSON.stringify(record))
  const acceptsBefore = awr.calls.filter((call) => call.includes('--accept')).length
  const resumed = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(resumed.outcome, 'completed', JSON.stringify(resumed.record.stop))
  assert.equal(resumed.record.steps.accept.result.recovered, true)
  assert.equal(awr.calls.filter((call) => call.includes('--accept')).length, acceptsBefore)
})

test('a project initialized by someone else while the run was in progress is not accepted over', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  const original = awr.run.bind(awr)
  awr.run = async (projectRoot, args) => {
    if (args[0] === 'init' && args.includes('--write-draft')) {
      mkdirSync(join(root, '.awr'), { recursive: true })
      writeFileSync(join(root, '.awr', 'project.toml'), '[project]\n')
    }
    return original(projectRoot, args)
  }
  const result = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(result.record.stop.reason, 'already_initialized')
  assert.ok(!awr.calls.some((call) => call.includes('--accept')))
})

test('a lock held by a live process of another run stops the run; a lock of a dead process is taken over', async (t) => {
  const { root, state } = scratchProject(t)
  const awr = scriptedAwr(root)
  const runDir = runDirFor(root, state)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }))
  const locked = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(locked.outcome, 'stopped')
  assert.equal(locked.record.stop.reason, 'locked')
  assert.deepEqual(awr.calls, [])
  writeFileSync(join(runDir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
  const taken = await runTakeover({ awr, projectRoot: root, stateDir: state })
  assert.equal(taken.outcome, 'completed')
  assert.ok(!existsSync(join(runDir, 'lock')), 'the lock is released')
})

test('two runs for one project in one process are not allowed at the same time', async (t) => {
  const { root, state } = scratchProject(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const awr = scriptedAwr(root)
  const original = awr.run.bind(awr)
  awr.run = async (projectRoot, args) => { await gate; return original(projectRoot, args) }
  const running = runTakeover({ awr, projectRoot: root, stateDir: state })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await assert.rejects(runTakeover({ awr, projectRoot: root, stateDir: state }), /already running/)
  release()
  assert.equal((await running).outcome, 'completed')
})

real('against the real awr: interrupted before or after any awr call, the run resumes and reaches the same state as an uninterrupted one', async (t) => {
  const clean = fixture(t, README_ONLY)
  const counted = { run: (root, args) => (counted.n += 1, clean.awr.run(root, args)), resolve: (root) => clean.awr.resolve(root), n: 0 }
  const expected = await runTakeover({ awr: counted, projectRoot: clean.root, stateDir: clean.state, review: ({ draft }) => reviewLedger(draft) })
  assert.equal(expected.outcome, 'completed', JSON.stringify(expected.record.stop))
  assert.equal(expected.record.steps.organize.result.state, 'ready')
  const total = counted.n
  assert.ok(total >= 5)
  const expectedFiles = listFiles(clean.root).filter((path) => !path.startsWith('.awr/takeover/') && !/state\.db/.test(path))

  for (const when of ['before', 'after']) {
    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const f = fixture(t, README_ONLY)
      let count = 0
      const flaky = {
        resolve: (root) => f.awr.resolve(root),
        run: async (root, args) => {
          count += 1
          if (count === crashAt && when === 'before') throw new Error('the process died')
          const answer = await f.awr.run(root, args)
          if (count === crashAt && when === 'after') throw new Error('the answer was lost')
          return answer
        },
      }
      const options = { projectRoot: f.root, stateDir: f.state, review: ({ draft }) => reviewLedger(draft) }
      const first = await runTakeover({ awr: flaky, ...options })
      assert.notEqual(first.outcome, 'completed', `${when} call ${crashAt}`)
      const second = await runTakeover({ awr: f.awr, ...options })
      assert.equal(second.outcome, 'completed', `${when} call ${crashAt}: ${JSON.stringify(second.record.stop)}`)
      assert.equal(second.record.id, first.record.id)
      assert.equal(second.record.steps.organize.result.state, 'ready', `${when} call ${crashAt}`)
      assert.deepEqual(listFiles(f.root).filter((path) => !path.startsWith('.awr/takeover/') && !/state\.db/.test(path)), expectedFiles, `${when} call ${crashAt}: same files as an uninterrupted run`)
      assert.equal(f.commits(), '2')
    }
  }
})

// --- pieces ---------------------------------------------------------------------------------------------------------------

test('validateReviewedDraft accepts an edit of the generated files and refuses what would change the target or escape', () => {
  const draft = { schema_version: 1, project_root: '/p', inventory_fingerprint: 'fp', generated_files: { '.awr/intake/GOALS.md': 'a' } }
  assert.equal(validateReviewedDraft(draft, { ...draft, generated_files: { '.awr/intake/GOALS.md': 'b', '.awr/intake/work-ledger.yaml': 'c' } }), undefined)
  assert.match(validateReviewedDraft(draft, null), /JSON object/)
  assert.match(validateReviewedDraft(draft, [1]), /JSON object/)
  assert.match(validateReviewedDraft(draft, { ...draft, project_root: '/other' }), /project_root/)
  assert.match(validateReviewedDraft(draft, { ...draft, inventory_fingerprint: 'x' }), /inventory_fingerprint/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: 'text' }), /object/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: { 'src/a.js': 'x' } }), /outside \.awr\/intake/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: { '.awr/intake/../../x': 'x' } }), /outside/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: { '/etc/passwd': 'x' } }), /outside/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: { '.awr/intake/a.md': 5 } }), /must be text/)
  assert.match(validateReviewedDraft(draft, { ...draft, generated_files: { '.awr/intake/a.md': 'x'.repeat(1024 * 1024 + 1) } }), /larger than 1 MiB/)
})

test('classify turns awr failures into reasons and leaves unknown errors alone', () => {
  assert.equal(classify(new Error('x'), '/p'), undefined)
  assert.equal(classify(new TakeoverStop('why', 'because'), '/p').reason, 'why')
  const secret = new AwrError('failed', 'RuleViolation: ...', { code: 'RuleViolation', awrMessage: 'rule violation: sensitive content is not accepted; category=credential', awrDetails: { category: 'credential', location: { locator: 'file:///p/docs/a.md', line: 3, column: 1 }, next_action: 'remove it' } })
  assert.deepEqual(classify(secret, '/p').detail, { category: 'credential', path: 'docs/a.md', line: 3 })
  assert.equal(classify(new AwrError('failed', 'NotFound: x', { code: 'NotFound', awrMessage: 'x' }), '/p').reason, 'awr_error')
  assert.equal(classify(new AwrError('invalid_output', 'not json'), '/p').reason, 'invalid_output')
  assert.equal(classify(new AwrError('failed', 'SourceConflict: x', { code: 'SourceConflict', awrMessage: 'source fingerprint conflict: project inventory changed' }), '/p').reason, 'inventory_changed')
  assert.equal(classify(new AwrError('failed', 'SourceConflict: x', { code: 'SourceConflict', awrMessage: 'source fingerprint conflict: multiple authority candidates; resolve the draft' }), '/p').reason, 'ambiguous_authority')
})

test('the state directory is outside the project and stable per project', () => {
  const a = runDirFor('/work/portal', '/state')
  assert.match(a, /^\/state\/portal-[0-9a-f]{12}$/)
  assert.equal(a, runDirFor('/work/portal/', '/state'))
  assert.notEqual(a, runDirFor('/other/portal', '/state'))
  assert.match(defaultStateBase({ HOME: '/home/u' }), /^\/home\/u\/\.local\/state\/dsh-awr\/takeovers$/)
  assert.equal(defaultStateBase({ DSH_AWR_STATE: '/s' }), '/s/takeovers')
})
