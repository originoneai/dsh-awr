// The agent/created listener: project discovery, non-blocking binding, and never throwing.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAwr } from '../lib/awr-runtime.js'
import { watchConversations } from '../lib/conversation.js'
import { findProjectRoot } from '../lib/project.js'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-awr-conv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A project directory with the manifest file AWR looks for, and a nested working directory. */
function projectTree(t) {
  const root = scratch(t)
  mkdirSync(join(root, '.awr'))
  writeFileSync(join(root, '.awr', 'project.toml'), '[project]\nname="t"\n')
  const nested = join(root, 'src', 'deep')
  mkdirSync(nested, { recursive: true })
  return { root, nested }
}
function fakeCtx() {
  const handlers = {}
  const warnings = []
  return {
    handlers,
    warnings,
    on: (event, handler) => {
      handlers[event] = handler
      return () => {}
    },
    logger: { warn: (m) => warnings.push(m) },
  }
}
const agentIn = (cwd, id = 'session-1') => ({
  agent: { session: { id, header: { cwd } }, model: { current: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) } },
  source: 'startup',
})

test('findProjectRoot walks up to the manifest, and a bare .awr directory does not count', async (t) => {
  const { root, nested } = projectTree(t)
  assert.equal(await findProjectRoot(nested), root)
  assert.equal(await findProjectRoot(root), root)
  const bare = scratch(t)
  mkdirSync(join(bare, '.awr'))
  assert.equal(await findProjectRoot(bare), undefined)
  assert.equal(await findProjectRoot(scratch(t)), undefined)
})

test('a conversation in a project subdirectory is bound against the project root', async (t) => {
  const { root, nested } = projectTree(t)
  const calls = []
  const awr = {
    async run(projectRoot, args) {
      calls.push([projectRoot, ...args])
      if (args[1] === 'show' && args[0] === 'client') return { binding: null }
      if (args[0] === 'status') return { current: [], ready: [{ key: 'W-1' }] }
      if (args[1] === 'bind') return { binding: { session_id: 'S1' } }
      throw new Error(`unexpected ${args.join(' ')}`)
    },
  }
  const ctx = fakeCtx()
  const watcher = watchConversations(ctx, { awr })
  await ctx.handlers['agent/created'](agentIn(nested, 'conv-7'))
  const result = await watcher.get('conv-7')
  assert.equal(result.outcome, 'created')
  assert.equal(result.projectRoot, root)
  assert.equal(result.externalSession, 'dsh:conv-7')
  assert.ok(calls.every(([projectRoot]) => projectRoot === root))
  const bind = calls.find((c) => c[2] === 'bind')
  assert.ok(bind.includes('deepseek-flash'), 'the model label is passed on')
})

test('outside an AWR project nothing is run and nothing is recorded', async (t) => {
  let ran = false
  const ctx = fakeCtx()
  const watcher = watchConversations(ctx, { awr: { run: async () => { ran = true } } })
  await ctx.handlers['agent/created'](agentIn(scratch(t)))
  assert.equal(ran, false)
  assert.equal(watcher.get('session-1'), undefined)
})

test('the listener waits for the binding, but only up to the limit', async (t) => {
  const { nested } = projectTree(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const awr = { run: async (root, args) => { await gate; return args[0] === 'client' && args[1] === 'show' ? { binding: { session_id: 'S1' } } : { session: { status: 'active' } } } }

  // Within the limit: the listener returns only once the binding has settled.
  const waited = fakeCtx()
  const watcher = watchConversations(waited, { awr, waitMs: 5_000 })
  const handler = waited.handlers['agent/created'](agentIn(nested, 'waits'))
  let returned = false
  handler.then(() => { returned = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(returned, false, 'the listener must wait for awr')
  release()
  await handler
  assert.equal((await watcher.get('waits')).outcome, 'existing')

  // Past the limit: the listener lets the conversation start, and the binding still resolves later.
  // The plugin's own timer is unref'd so it never holds the process open; keep the loop alive here.
  const keepAlive = setTimeout(() => {}, 2_000)
  t.after(() => clearTimeout(keepAlive))
  const slow = new Promise(() => {})
  const hung = fakeCtx()
  const bounded = watchConversations(hung, { awr: { run: () => slow }, waitMs: 50 })
  const started = Date.now()
  await hung.handlers['agent/created'](agentIn(nested, 'hangs'))
  assert.ok(Date.now() - started < 2_000, 'a slow awr must not hold the conversation back')
  assert.ok(bounded.get('hangs'), 'the pending binding is still recorded')
})

test('a failing awr is reported as a warning and never makes the listener throw', async (t) => {
  const { nested } = projectTree(t)
  const ctx = fakeCtx()
  const watcher = watchConversations(ctx, { awr: createAwr({ env: { PATH: scratch(t) }, fallbackDirs: [] }) })
  await assert.doesNotReject(ctx.handlers['agent/created'](agentIn(nested)))
  const result = await watcher.get('session-1')
  assert.equal(result.outcome, 'failed')
  assert.match(result.message, /Install awr/)
  assert.equal(ctx.warnings.length, 1)
  // A malformed payload is also swallowed.
  await assert.doesNotReject(ctx.handlers['agent/created'](undefined))
  await assert.doesNotReject(ctx.handlers['agent/created']({ agent: {} }))
})

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

real('against the real awr: a conversation started in a subdirectory ends up bound in AWR', async (t) => {
  const state = scratch(t)
  const root = scratch(t)
  const env = { ...process.env, AWR_LOCAL_HOME: join(state, 'user'), AWR_LOCAL_WEB: '0', PATH: `${dirname(lab)}:${process.env.PATH}` }
  const cli = (...args) => JSON.parse(execFileSync(lab, ['--project', root, '--json', ...args], { env, encoding: 'utf8' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  cli('init', '--goal', 'Check the DSH listener against a real awr', '--accept')
  const nested = join(root, 'packages', 'app')
  mkdirSync(nested, { recursive: true })

  const ctx = fakeCtx()
  const watcher = watchConversations(ctx, { awr: createAwr({ env }) })
  await ctx.handlers['agent/created'](agentIn(nested, 'real-conv'))
  const result = await watcher.get('real-conv')
  assert.equal(result.outcome, 'created', JSON.stringify(result))
  const shown = cli('client', 'show', '--client', 'generic', '--external-session', 'dsh:real-conv')
  assert.equal(shown.binding.session_id, result.sessionId)
  assert.equal(shown.binding.client, 'generic')
  assert.deepEqual(cli('session', 'show', result.sessionId).claims ?? [], [], 'no claim was taken')
})
