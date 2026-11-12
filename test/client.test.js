// The panel's session actions (DSH-052): claim, checkpoint and end, as buttons that run the `/awr` command of
// the same name. `client.js` is browser code for DSH's module loader, so it is run here as it ships, in a
// `vm` context, against a small stand-in for React that keeps hook state and renders again after every state
// change. The host is a stub: it records each command line and answers from a table.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { snapshotPath } from '../lib/panel-snapshot.js'
import { panelSentence } from '../lib/panel-text.js'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

function createReact() {
  let instance
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = instance.index++
      const owner = instance
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
      return [owner.slots[index], (value) => {
        owner.slots[index] = typeof value === 'function' ? value(owner.slots[index]) : value
        owner.render()
      }]
    },
    useRef(initial) {
      const index = instance.index++
      if (!(index in instance.slots)) instance.slots[index] = { current: initial ?? null }
      return instance.slots[index]
    },
    useMemo(factory) {
      const index = instance.index++
      if (!(index in instance.slots)) instance.slots[index] = factory()
      return instance.slots[index]
    },
    useCallback(callback, deps) {
      const index = instance.index++
      const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
      if (!(index in instance.slots) || !same(instance.slots[index].deps, deps)) instance.slots[index] = { callback, deps }
      return instance.slots[index].callback
    },
    // Effects run after the render they belong to, again only when their dependencies changed, after the cleanup of the
    // last run: what the panel's timer and its outside-click listeners rely on.
    useEffect(effect, deps) {
      instance.pending.push({ index: instance.effectIndex++, effect, deps })
    },
  }
  const ReactDOM = { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) }
  /** Mount a function component; every state change renders it again, synchronously. */
  function mount(Component, props) {
    const mounted = { slots: [], index: 0, effectIndex: 0, pending: [], effects: [], tree: null }
    const expand = (node) => {
      if (Array.isArray(node)) return node.map(expand)
      if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return node
      if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
      if (node.props.ref && typeof node.props.ref === 'object') {
        node.props.ref.current = { getBoundingClientRect: () => ({ bottom: 10, left: 10 }), contains: () => false }
      }
      return { ...node, children: node.children.map(expand) }
    }
    mounted.render = () => {
      instance = mounted
      mounted.index = 0
      mounted.effectIndex = 0
      mounted.pending = []
      try {
        mounted.tree = expand(React.createElement(Component, props))
      } finally {
        instance = undefined
      }
      for (const { index, effect, deps } of mounted.pending) {
        const last = mounted.effects[index]
        if (last && deps && last.deps && deps.length === last.deps.length && deps.every((item, i) => Object.is(item, last.deps[i]))) continue
        last?.cleanup?.()
        mounted.effects[index] = { deps, cleanup: effect() }
      }
    }
    mounted.render()
    return mounted
  }
  return { React, ReactDOM, mount }
}

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visit))
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return node && typeof node === 'object' ? textOf(node.children) : ''
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

const STATE = { state: 'initialized', projectRoot: '/work/demo', steps: [] }
const workView = (patch = {}) => ({
  project: { revision: 7 },
  session: { id: 'S-1', status: 'active' },
  bound_work: { key: 'W-1', title: 'Parser', status: 'in_progress', next_action: 'write tests', blocker: null },
  claims: [],
  in_progress: [],
  ready: [],
  blocked: [],
  ...patch,
})

const HOME = '/Users/test'

/**
 * Open the panel of a conversation. The host is a stand-in that does what the real one does: it keeps the panel's data
 * in a file (read through `workspaceFiles`, which writes nothing to the conversation) and writes it again when a
 * command that changes the state ran, or when `/awr panel` asks. `answer(line, calls)` returns the text (or `{ error }`)
 * of any other command line; it may return a promise.
 *
 * `snapshot`: 'fresh' (written just before), 'stale' (a minute old) or 'none' (not written yet).
 * `publishes`: whether the stand-in writes the file after a command that changes the state, as the real host does.
 */
async function openPanel({ state = () => STATE, work = () => workView(), answer = () => 'done', open = true, language = 'en-US', snapshot = 'fresh', publishes = true, loopback = true, home = HOME, fileService = true } = {}) {
  const { React, ReactDOM, mount } = createReact()
  const calls = []
  const reads = []
  const rows = []
  const timers = []
  const listeners = new Map()
  const files = new Map()
  const clock = { now: 1_700_000_000_000 }
  class FakeDate extends Date {
    static now() { return clock.now }
  }
  let Action
  let factory
  const context = vm.createContext({
    window: { innerWidth: 1200, __ModuleLoader__: { load: (module) => { factory = module.factory } } },
    document: {
      body: {},
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener)),
    },
    navigator: { language },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1 },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false },
    Date: FakeDate,
    console,
  })
  vm.runInContext(source, context)
  const plugin = factory((name) => ({ react: React, 'react-dom': ReactDOM })[name])
  const path = snapshotPath('conv-1', home)
  /** What the host does: write the panel's data into its file. */
  const publish = () => {
    clock.now += 10
    const view = state()
    const managed = view.state === 'initialized' || view.state === 'completed'
    files.set(path, JSON.stringify({ version: 1, updatedAt: clock.now, view, work: managed ? work() : null }))
  }
  const CHANGES = /^\/awr (claim|checkpoint|end|takeover)( |$)/
  const ctx = {
    remote: {
      hostFacts: { home, isLoopback: loopback },
      commands: {
        async execute(sessionId, line) {
          calls.push(line)
          if (line.startsWith('/awr panel')) {
            publish()
            const view = state()
            const text = panelSentence(view, view.state === 'initialized' || view.state === 'completed' ? work() : undefined, line.endsWith(' zh') ? 'zh' : 'en')
            rows.push(text)
            return { ok: true, value: { result: { kind: 'success', text } } }
          }
          const reply = await answer(line, calls)
          if (publishes && CHANGES.test(line) && !/ status/.test(line)) publish()
          if (reply?.error) return { ok: true, value: { result: { kind: 'error', text: reply.error } } }
          rows.push(reply)
          return { ok: true, value: { result: { kind: 'success', text: reply } } }
        },
      },
      ...(fileService ? {
        workspaceFiles: {
          async read(sessionId, readPath, range) {
            reads.push({ sessionId, path: readPath, range })
            if (!files.has(readPath)) return { ok: false, error: { code: 'gateway/not-found' } }
            const text = files.get(readPath)
            return { ok: true, value: { absolutePath: readPath, text, lines: 1, eof: true } }
          },
        },
      } : {}),
    },
    locale: { register() {} },
    effect: (callback) => callback(),
    slots: { inject: (_name, callback) => callback(), register: (_options, component) => { Action = component } },
  }
  plugin.apply(ctx)
  if (snapshot !== 'none') {
    publish()
    if (snapshot === 'stale') clock.now += 60_000
  }
  const root = mount(Action, { sessionId: 'conv-1' })
  await settle()
  const find = (predicate) => {
    let found
    walk(root.tree, (node) => { if (!found && predicate(node)) found = node })
    return found
  }
  const panel = {
    calls,
    reads,
    /** The text of every command answer: what the conversation shows for the panel. */
    rows,
    clock,
    files,
    path,
    /** The host writes the data again, as it does while a takeover runs. */
    publish,
    /** The timers that are waiting, by delay. */
    timers: () => timers.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Fire the timer that is waiting, as the clock would. */
    async fire() {
      const timer = timers.find((item) => item.live)
      assert.ok(timer, 'no timer is waiting')
      timer.live = false
      timer.fn()
      await settle()
      await settle()
    },
    /** What the panel asked the host to write with `/awr panel`. */
    queries: () => calls.filter((line) => line.startsWith('/awr panel')),
    async press(key) {
      for (const listener of listeners.get('keydown') ?? []) listener({ type: 'keydown', key })
      await settle()
    },
    byId: (id) => find((node) => node.props.id === id),
    byTestId: (id) => find((node) => node.props['data-testid'] === id),
    /** The status the panel shows for a takeover step. */
    step: (name) => find((node) => node.props['data-step'] === name)?.props['data-status'],
    async click(id) {
      const target = panel.byId(id)
      assert.ok(target, `no element #${id}`)
      assert.ok(!target.props.disabled, `#${id} is disabled`)
      clock.now += 100 // time passes between what the host last wrote and a click
      target.props.onClick({})
      await settle()
      await settle()
    },
    type(id, value) {
      const target = panel.byId(id)
      assert.ok(target, `no element #${id}`)
      target.props.onChange({ target: { value } })
    },
    text: () => textOf(root.tree),
  }
  if (open) {
    await panel.click('awr-header-action')
    await settle()
  }
  return panel
}

test('a session that holds no claim offers to claim its bound work, and the click runs /awr claim', async () => {
  let claimed = false
  const panel = await openPanel({
    work: () => workView(claimed ? { claims: [{ work: 'W-1', expires_at: null }] } : {}),
    answer: (line) => { if (line === '/awr claim') claimed = true; return 'Claimed W-1 for AWR session S-1 (project revision 8).' },
  })
  assert.match(textOf(panel.byId('awr-claim')), /^Claim W-1$/)
  await panel.click('awr-claim')
  assert.deepEqual(panel.calls.filter((line) => line.startsWith('/awr claim')), ['/awr claim'])
  assert.equal(panel.byId('awr-claim'), undefined, 'once it holds the claim, the button is gone')
  assert.match(textOf(panel.byTestId('awr-action-result')), /Claimed W-1/)
  assert.deepEqual(panel.calls, ['/awr claim'], 'the host wrote the new state with the command, so the panel read it and asked nothing more')
})

test('no claim button when the session already holds a claim or the work is finished', async () => {
  const held = await openPanel({ work: () => workView({ claims: [{ work: 'W-1', expires_at: null }] }) })
  assert.equal(held.byId('awr-claim'), undefined)
  assert.ok(held.byId('awr-checkpoint-open') && held.byId('awr-end-open'))
  const done = await openPanel({ work: () => workView({ bound_work: { key: 'W-1', title: 'Parser', status: 'completed', next_action: null, blocker: null } }) })
  assert.equal(done.byId('awr-claim'), undefined)
  const unbound = await openPanel({ work: () => workView({ bound_work: null }) })
  assert.equal(unbound.byId('awr-claim'), undefined)
})

test('the actions appear only while the AWR session is active', async () => {
  for (const session of [{ id: 'S-1', status: 'ended' }, { id: 'S-1', status: 'interrupted' }, null]) {
    const panel = await openPanel({ work: () => workView({ session }) })
    assert.equal(panel.byTestId('awr-actions'), undefined, JSON.stringify(session))
  }
  const takeover = await openPanel({ state: () => ({ state: 'not_initialized', steps: [] }) })
  assert.equal(takeover.byTestId('awr-actions'), undefined)
  assert.ok(takeover.byId('awr-takeover-start'), 'the takeover button is still there')
})

test('a checkpoint is sent as one line, with the whitespace collapsed', async () => {
  const panel = await openPanel()
  await panel.click('awr-checkpoint-open')
  assert.ok(panel.byTestId('awr-checkpoint-form'))
  panel.type('awr-checkpoint-digest', '  Wrote the parser\n  and its tests ')
  panel.type('awr-checkpoint-next', 'Handle\tnested lists')
  await panel.click('awr-checkpoint-save')
  assert.deepEqual(panel.calls.filter((line) => line.startsWith('/awr checkpoint')), ['/awr checkpoint Wrote the parser and its tests :: Handle nested lists'])
  assert.equal(panel.byTestId('awr-checkpoint-form'), undefined, 'the form closes after it was saved')
  assert.equal(panel.byId('awr-checkpoint-digest'), undefined)
})

test('a checkpoint needs both fields and cannot hold the :: separator; nothing is sent otherwise', async () => {
  const panel = await openPanel()
  await panel.click('awr-checkpoint-open')
  for (const [digest, next] of [['', ''], ['done', ''], ['', 'next'], ['a :: b', 'next'], ['done', 'x::y'], ['  ', '  ']]) {
    panel.type('awr-checkpoint-digest', digest)
    panel.type('awr-checkpoint-next', next)
    await panel.click('awr-checkpoint-save')
    assert.match(textOf(panel.byTestId('awr-action-result')), /Fill in both fields/, JSON.stringify([digest, next]))
  }
  assert.equal(panel.calls.filter((line) => line.startsWith('/awr checkpoint')).length, 0)
  await panel.click('awr-checkpoint-cancel')
  assert.equal(panel.byTestId('awr-checkpoint-form'), undefined)
})

test('ending a session asks first, sends the chosen outcome, and the actions go away with the session', async () => {
  let ended = false
  const panel = await openPanel({
    work: () => workView(ended ? { session: { id: 'S-1', status: 'interrupted' } } : {}),
    answer: (line) => { if (line.startsWith('/awr end')) ended = true; return 'Ended AWR session S-1 as interrupted. Work is not completed by ending a session.' },
  })
  await panel.click('awr-end-open')
  assert.match(textOf(panel.byTestId('awr-end-form')), /does not complete its work/)
  assert.equal(panel.calls.filter((line) => line.startsWith('/awr end')).length, 0, 'opening the form ends nothing')
  panel.byId('awr-end-outcome').props.onChange({ target: { value: 'interrupted' } })
  await panel.click('awr-end-confirm')
  assert.deepEqual(panel.calls.filter((line) => line.startsWith('/awr end')), ['/awr end interrupted'])
  assert.equal(panel.byTestId('awr-actions'), undefined)
  assert.match(textOf(panel.byTestId('awr-action-result')), /Ended AWR session S-1/)
})

test('the outcome is one of three words, whatever the select holds', async () => {
  const panel = await openPanel()
  await panel.click('awr-end-open')
  const options = panel.byId('awr-end-outcome').children.map((option) => option.props.value)
  assert.deepEqual(options, ['ended', 'interrupted', 'incomplete'])
  panel.byId('awr-end-outcome').props.onChange({ target: { value: 'ended; rm -rf /' } })
  await panel.click('awr-end-confirm')
  assert.deepEqual(panel.calls.filter((line) => line.startsWith('/awr end')), ['/awr end ended'])
})

test('a refusal from the host is shown as it came, nothing is retried and the panel is not refreshed', async () => {
  const panel = await openPanel({ answer: () => ({ error: 'The project changed while the command was being prepared. Nothing was written.' }) })
  const before = panel.calls.length
  await panel.click('awr-claim')
  assert.equal(panel.calls.length, before + 1, 'one command, no retry, no refresh')
  const result = panel.byTestId('awr-action-result')
  assert.match(textOf(result), /The project changed/)
  assert.match(JSON.stringify(result.props.style), /state-error/, 'shown as an error')
  assert.ok(panel.byId('awr-claim'), 'the button stays, so the user can try again after looking')
})

test('while a command runs the buttons are disabled, so a double click sends one command', async () => {
  let release
  const panel = await openPanel({ answer: () => new Promise((resolve) => { release = () => resolve('Claimed W-1.') }) })
  const target = panel.byId('awr-claim')
  target.props.onClick({})
  await settle()
  for (const id of ['awr-claim', 'awr-checkpoint-open', 'awr-end-open']) assert.equal(panel.byId(id).props.disabled, true, id)
  assert.match(panel.text(), /Working…/)
  release()
  await settle()
  assert.equal(panel.calls.filter((line) => line === '/awr claim').length, 1)
  assert.equal(panel.byId('awr-checkpoint-open').props.disabled, false)
})

const running = () => ({ state: 'running', projectRoot: '/work/demo', steps: [{ name: 'preflight', status: 'done' }, { name: 'preview', status: 'done' }, { name: 'review', status: 'running' }] })

test('a panel opened on a file written a moment ago asks the host nothing, and nothing reaches the conversation', async () => {
  const panel = await openPanel()
  assert.deepEqual(panel.calls, [], 'no command, so no row')
  assert.deepEqual(panel.rows, [])
  assert.ok(panel.reads.length >= 1, 'the file was read')
  assert.ok(panel.byTestId('awr-work'), 'and the panel shows what it holds')
  assert.equal(JSON.stringify(panel.reads.at(-1).range), '{}', 'one read of the whole file')
  assert.equal(panel.reads.at(-1).path, '/Users/test/.local/state/dsh-awr/panel/conv-1.json')
  assert.equal(panel.reads.at(-1).sessionId, 'conv-1')
})

test('a file that is missing or older than 30 s makes the host write it: one command whose row is one sentence', async () => {
  for (const snapshot of ['none', 'stale']) {
    const panel = await openPanel({ snapshot })
    assert.deepEqual(panel.calls, ['/awr panel en'], snapshot)
    assert.deepEqual(panel.rows, ['AWR project · 0 in progress, 0 ready, 0 blocked'], snapshot)
    assert.ok(panel.byTestId('awr-work'), 'and then the panel shows the data')
  }
})

test('a closed panel asks the host nothing, even while a takeover runs; the dot shows what the file says', async () => {
  const panel = await openPanel({ state: running, open: false })
  assert.deepEqual(panel.calls, [], 'no command')
  assert.deepEqual(panel.timers(), [], 'and no timer is waiting')
  assert.equal(panel.byTestId('awr-dot').props['data-state'], 'running')
  const none = await openPanel({ snapshot: 'none', open: false })
  assert.deepEqual(none.calls, [], 'a missing file asks nothing either while the panel is closed')
  assert.equal(none.byTestId('awr-dot').props['data-state'], 'loading')
})

test('while a takeover runs the panel reads the file every 2.5 s and asks the host nothing', async () => {
  let current = running()
  const panel = await openPanel({ state: () => current })
  assert.deepEqual(panel.timers(), [2500])
  assert.equal(panel.step('review'), 'running')
  const reads = panel.reads.length
  current = { ...running(), steps: [...running().steps.slice(0, 2), { name: 'review', status: 'done' }, { name: 'accept', status: 'running' }] }
  panel.publish()
  await panel.fire()
  assert.equal(panel.reads.length, reads + 1, 'one read for one tick')
  assert.equal(panel.step('review'), 'done')
  assert.equal(panel.step('accept'), 'running')
  assert.deepEqual(panel.timers(), [2500], 'and the next tick is waiting')
  for (let round = 0; round < 3; round += 1) {
    panel.publish()
    await panel.fire()
  }
  assert.deepEqual(panel.calls, [], 'not one command, so not one row')
})

test('the polling ends when the takeover is no longer running, and when the panel is closed', async () => {
  let current = running()
  const panel = await openPanel({ state: () => current })
  current = { ...running(), state: 'stopped', stop: { step: 'review', reason: 'review_failed', message: 'The review failed.' } }
  panel.publish()
  await panel.fire()
  assert.deepEqual(panel.timers(), [], 'stopped: nothing is waiting')
  assert.match(panel.text(), /The review failed\./)
  const open = await openPanel({ state: running })
  assert.deepEqual(open.timers(), [2500])
  await open.press('Escape')
  assert.deepEqual(open.timers(), [], 'a panel that is closed reads nothing')
  const done = await openPanel({ state: () => ({ ...STATE, state: 'completed', steps: [] }) })
  assert.deepEqual(done.timers(), [])
})

test('a takeover whose file stops changing makes the panel ask the host once, and the reading goes on', async () => {
  const panel = await openPanel({ state: running })
  for (let round = 0; round < 5; round += 1) await panel.fire()
  assert.deepEqual(panel.queries(), [], 'five unchanged reads are not enough')
  await panel.fire()
  assert.deepEqual(panel.queries(), ['/awr panel en'], 'the sixth asks once')
  assert.deepEqual(panel.rows, ['Taking the project over · reviewing the draft (step 3 of 6)'])
  assert.deepEqual(panel.timers(), [2500], 'the host wrote the file again, and the panel goes on reading it')
  await panel.fire()
  assert.equal(panel.queries().length, 1, 'a file that changed again is not asked about again')
})

test('Refresh asks the host once more; the sentence is in Chinese for a Chinese interface', async () => {
  const zh = await openPanel({ language: 'zh-CN', snapshot: 'none', state: running })
  assert.deepEqual(zh.queries(), ['/awr panel zh'])
  assert.deepEqual(zh.rows, ['正在接管项目 · 审阅草稿（第 3/6 步）'])
  await zh.click('awr-refresh')
  assert.equal(zh.queries().length, 2)
  const english = await openPanel({ language: 'fr-FR', snapshot: 'none' })
  assert.deepEqual(english.queries(), ['/awr panel en'])
})

test('nothing the panel does puts data in the conversation: every row is a plain sentence, no query asks for JSON', async () => {
  const panel = await openPanel({ state: running, snapshot: 'none', answer: (line) => (line.startsWith('/awr claim') ? 'Claimed W-1 for AWR session S-1 (project revision 8).' : 'done') })
  await panel.click('awr-refresh')
  await panel.fire()
  assert.ok(panel.rows.length >= 2)
  for (const row of panel.rows) {
    assert.ok(!/[{}\[\]]|<!--|-->|"/.test(row), `no JSON or markup in: ${row}`)
    assert.ok(!row.includes('\n'), `one line: ${row}`)
  }
  assert.ok(!panel.calls.some((line) => /--json|status/.test(line)), `no command asks for JSON: ${panel.calls.join(' | ')}`)
})

test('after an action the panel reads what the host wrote with it; when the host wrote nothing it asks once', async () => {
  const wrote = await openPanel({ answer: () => 'Claimed W-1 for AWR session S-1 (project revision 8).' })
  await wrote.click('awr-claim')
  assert.deepEqual(wrote.calls, ['/awr claim'])
  const silent = await openPanel({ publishes: false, answer: () => 'Claimed W-1 for AWR session S-1 (project revision 8).' })
  await silent.click('awr-claim')
  assert.deepEqual(silent.calls, ['/awr claim', '/awr panel en'], 'the file was older than the command, so the host is asked to write it')
})

test('the takeover button starts it and then reads the file the host wrote with it', async () => {
  let current = { state: 'not_initialized', projectRoot: '/work/demo', steps: [], stop: null }
  const panel = await openPanel({ state: () => current, answer: (line) => { if (line === '/awr takeover') current = { ...running() }; return 'Started the takeover of /work/demo. It runs in the background.' } })
  assert.ok(panel.byId('awr-takeover-start'))
  await panel.click('awr-takeover-start')
  assert.deepEqual(panel.calls, ['/awr takeover'], 'one row, the one the user asked for')
  assert.equal(panel.step('review'), 'running')
  assert.deepEqual(panel.timers(), [2500], 'and the panel follows it by reading')
})

test('the path of the file is the same one the host writes, with the separator of a Windows home', async () => {
  const windows = await openPanel({ home: 'C:\\Users\\mac', state: running })
  assert.equal(windows.reads.at(-1).path, win32.join('C:\\Users\\mac', '.local', 'state', 'dsh-awr', 'panel', 'conv-1.json'))
  const posix = await openPanel({ home: '/home/u' })
  assert.equal(posix.reads.at(-1).path, snapshotPath('conv-1', '/home/u'))
})

test('without the file service the panel says so instead of showing nothing', async () => {
  const panel = await openPanel({ fileService: false, snapshot: 'none' })
  assert.match(panel.text(), /no file service for the panel/)
})

test('the panel says which awr it uses and how the takeover runs, and why when there is none', async () => {
  const withAwr = await openPanel({ state: () => ({ ...STATE, awr: { cli: '/dev/awr', source: 'env', version: '0.8.0-dev', takeover: 'awr' } }) })
  const info = textOf(withAwr.byTestId('awr-info'))
  assert.match(info, /awr 0\.8\.0-dev · \/dev\/awr/)
  assert.match(info, /runs through awr takeover/)
  const legacy = await openPanel({ state: () => ({ ...STATE, awr: { cli: '/opt/homebrew/bin/awr', source: 'path', version: '0.7.0', takeover: 'plugin' } }) })
  assert.match(textOf(legacy.byTestId('awr-info')), /runs in the plugin \(this awr has no awr takeover\)/)
  const none = await openPanel({ state: () => ({ ...STATE, awr: { error: 'No awr was found on PATH.' } }) })
  assert.match(textOf(none.byTestId('awr-info')), /awr: No awr was found on PATH\./)
  const unknown = await openPanel()
  assert.equal(unknown.byTestId('awr-info'), undefined, 'nothing is shown when the host sent no awr')
})

test('a long work key does not break the claim button: it is shortened and the full key is the tooltip', async () => {
  const key = 'md-01da5526bf2dd4bcdcdb8025c57c2c24fcc89747307b1e6e452e330fc92b8694'
  const panel = await openPanel({ work: () => workView({ bound_work: { key, title: 'Search endpoint', status: 'planned', next_action: null, blocker: null } }) })
  assert.equal(textOf(panel.byId('awr-claim')), 'Claim md-01da5526b…2b8694')
  assert.equal(panel.byId('awr-claim').props.title, key)
  await panel.click('awr-claim')
  assert.deepEqual(panel.calls, ['/awr claim'], 'the command names no key: the host works the bound work out from the session')
  const short = await openPanel({ work: () => workView() })
  assert.equal(textOf(short.byId('awr-claim')), 'Claim W-1', 'a short key is shown whole')
})

test('the receipt says in words where the organization stands', async () => {
  const receipt = (state) => ({ state: 'completed', projectRoot: '/work/demo', steps: [], receipt: { organization: { state, goalTotal: 2, gapTotal: 9 }, mapped: { sources: [] }, created: { writes: [] }, awaitingConfirmation: [] } })
  const needs = await openPanel({ state: () => receipt('needs_organization') })
  assert.match(textOf(needs.byTestId('awr-receipt')), /Result: the goals still need to be organized; 2 goal\(s\), 9 open gap\(s\)/)
  const ready = await openPanel({ state: () => receipt('ready') })
  assert.match(textOf(ready.byTestId('awr-receipt')), /Result: ready; 2 goal/)
  const other = await openPanel({ state: () => receipt('something_new') })
  assert.match(textOf(other.byTestId('awr-receipt')), /Result: something_new; 2 goal/, 'a state this panel does not know is shown as it came')
})
