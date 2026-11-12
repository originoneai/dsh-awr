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
    useCallback: (callback) => callback,
    useEffect() {},
  }
  const ReactDOM = { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) }
  /** Mount a function component; every state change renders it again, synchronously. */
  function mount(Component, props) {
    const mounted = { slots: [], index: 0, tree: null }
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
      try {
        mounted.tree = expand(React.createElement(Component, props))
      } finally {
        instance = undefined
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
 * may return a promise. `/awr takeover status --json` and `/awr state --json` come from `state()` and `work()`.
 */
async function openPanel({ state = () => STATE, work = () => workView(), answer = () => 'done' } = {}) {
  const { React, ReactDOM, mount } = createReact()
  const calls = []
  let Action
  let factory
  const context = vm.createContext({
    window: { innerWidth: 1200, __ModuleLoader__: { load: (module) => { factory = module.factory } } },
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    console,
  })
  vm.runInContext(source, context)
  const plugin = factory((name) => ({ react: React, 'react-dom': ReactDOM })[name])
  const ctx = {
    remote: {
      commands: {
        async execute(sessionId, line) {
          calls.push(line)
          if (line === '/awr takeover status --json') return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(state()) } } }
          if (line === '/awr state --json') return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(work()) } } }
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
  await panel.click('awr-header-action')
  await settle()
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
  assert.equal(panel.calls.at(-1), '/awr state --json', 'the panel reads the state again after the command')
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
