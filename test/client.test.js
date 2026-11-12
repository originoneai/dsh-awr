// The panel's session actions (DSH-052): claim, checkpoint and end, as buttons that run the `/awr` command of
// the same name. `client.js` is browser code for DSH's module loader, so it is run here as it ships, in a
// `vm` context, against a small stand-in for React that keeps hook state and renders again after every state
// change. The host is a stub: it records each command line and answers from a table.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { panelText } from '../lib/panel-text.js'

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

/**
 * Open the panel of a conversation. `answer(line, calls)` returns the text (or `{ error }`) for a command line; it
 * may return a promise. `/awr panel` is answered from `state()` and `work()`, as the host answers it.
 */
async function openPanel({ state = () => STATE, work = () => workView(), answer = () => 'done', open = true, language = 'en-US' } = {}) {
  const { React, ReactDOM, mount } = createReact()
  const calls = []
  const timers = []
  const listeners = new Map()
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
    console,
  })
  vm.runInContext(source, context)
  const plugin = factory((name) => ({ react: React, 'react-dom': ReactDOM })[name])
  const ctx = {
    remote: {
      commands: {
        async execute(sessionId, line) {
          calls.push(line)
          if (line.startsWith('/awr panel')) {
            // As the host answers: one sentence, the data in a comment, the work state only for a project AWR manages.
            const view = state()
            const managed = view.state === 'initialized' || view.state === 'completed'
            return { ok: true, value: { result: { kind: 'success', text: panelText(view, managed ? work() : undefined, 'en') } } }
          }
          const reply = await answer(line, calls)
          if (reply?.error) return { ok: true, value: { result: { kind: 'error', text: reply.error } } }
          return { ok: true, value: { result: { kind: 'success', text: reply } } }
        },
      },
    },
    locale: { register() {} },
    effect: (callback) => callback(),
    slots: { inject: (_name, callback) => callback(), register: (_options, component) => { Action = component } },
  }
  plugin.apply(ctx)
  const root = mount(Action, { sessionId: 'conv-1' })
  const find = (predicate) => {
    let found
    walk(root.tree, (node) => { if (!found && predicate(node)) found = node })
    return found
  }
  const panel = {
    calls,
    /** The timers that are waiting, by delay. */
    timers: () => timers.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Fire the timer that is waiting, as the clock would. */
    async fire() {
      const timer = timers.find((item) => item.live)
      assert.ok(timer, 'no timer is waiting')
      timer.live = false
      timer.fn()
      await settle()
    },
    /** What the panel asked the host for with `/awr panel`. */
    queries: () => calls.filter((line) => line.startsWith('/awr panel')),
    async press(key) {
      for (const listener of listeners.get('keydown') ?? []) listener({ type: 'keydown', key })
      await settle()
    },
    byId: (id) => find((node) => node.props.id === id),
    byTestId: (id) => find((node) => node.props['data-testid'] === id),
    async click(id) {
      const target = panel.byId(id)
      assert.ok(target, `no element #${id}`)
      assert.ok(!target.props.disabled, `#${id} is disabled`)
      target.props.onClick({})
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
  assert.equal(panel.calls.at(-1), '/awr panel en', 'the panel reads the state again after the command')
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

test('a closed panel asks the host nothing, even while a takeover runs', async () => {
  const panel = await openPanel({ state: running, open: false })
  assert.equal(panel.calls.length, 0, 'nothing is asked until someone opens the panel')
  assert.deepEqual(panel.timers(), [], 'and no timer is waiting')
})

test('an open panel asks once, then at 5 s and slower, never faster than every 30 s in the end', async () => {
  const panel = await openPanel({ state: running })
  assert.equal(panel.queries().length, 1, 'one query when it is opened')
  const waited = []
  for (let round = 0; round < 6; round += 1) {
    waited.push(panel.timers()[0])
    await panel.fire()
  }
  assert.deepEqual(waited, [5000, 8500, 14450, 24565, 30000, 30000])
  assert.equal(panel.queries().length, 7, 'one query for each time the timer fired')
})

test('no timer waits once the takeover is not running, and closing the panel stops the one that does', async () => {
  const done = await openPanel({ state: () => ({ ...STATE, state: 'completed', steps: [] }) })
  assert.deepEqual(done.timers(), [])
  const open = await openPanel({ state: running })
  assert.deepEqual(open.timers(), [5000])
  await open.press('Escape')
  assert.deepEqual(open.timers(), [], 'a panel that is closed asks nothing')
})

test('Refresh asks once more; the host is asked in Chinese for a Chinese interface', async () => {
  const panel = await openPanel({ language: 'zh-CN' })
  assert.deepEqual(panel.queries(), ['/awr panel zh'])
  await panel.click('awr-refresh')
  assert.equal(panel.queries().length, 2)
  const english = await openPanel({ language: 'fr-FR' })
  assert.deepEqual(english.queries(), ['/awr panel en'])
})

test('every query the panel makes is a sentence a person can read in the conversation', async () => {
  const panel = await openPanel({ state: running })
  // The text the stand-in host returned for the panel's query is what the conversation would show.
  const text = panelText(running(), undefined, 'en')
  assert.ok(!/^[\s{[]/.test(text), 'it does not start with JSON')
  assert.ok(!panel.queries().some((line) => /--json/.test(line)), 'no query asks for JSON')
  assert.ok(!panel.calls.some((line) => /--json/.test(line)))
})
