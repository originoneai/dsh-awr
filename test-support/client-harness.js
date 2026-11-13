// A stand-in for DeepSeek Harness around client.js, for the tests.
//
// client.js is browser code for DSH's module loader, so it is run as it ships, in a `vm` context, against a small React
// that keeps the state of every component instance (by its place and key in the tree), runs effects after a render when
// their dependencies changed, and renders again after every state change. The host is a stub that does what the real
// one does: it keeps the plugin's data in files (read through `workspaceFiles`, which writes nothing to the
// conversation) and writes them again when a command asks or changes the state.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { snapshotPath } from '../lib/panel-snapshot.js'
import { progressPath } from '../lib/progress.js'

export const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))

export function createReact() {
  let current
  const Fragment = Symbol('Fragment')
  const React = {
    Fragment,
    createElement: (type, props, ...children) => ({ type, key: props?.key, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const owner = current
      const index = owner.index++
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [owner.hooks[index], (value) => {
        const next = typeof value === 'function' ? value(owner.hooks[index]) : value
        if (Object.is(next, owner.hooks[index])) return
        owner.hooks[index] = next
        owner.root.schedule()
      }]
    },
    useRef(initial) {
      const index = current.index++
      if (!(index in current.hooks)) current.hooks[index] = { current: initial ?? null }
      return current.hooks[index]
    },
    useMemo(factory, deps) {
      const index = current.index++
      const known = current.hooks[index]
      if (!known || !same(known.deps, deps)) current.hooks[index] = { value: factory(), deps }
      return current.hooks[index].value
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps)
    },
    useEffect(effect, deps) {
      const index = current.index++
      current.pending.push({ index, effect, deps })
    },
  }
  const ReactDOM = { createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }) }

  /** Mount a component; every state change renders the whole tree again, synchronously. */
  function mount(Component, props) {
    const instances = new Map()
    const root = { tree: null, rendering: false, dirty: false }
    const expand = (node, path, seen) => {
      if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, seen))
      if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        const id = `${path}<${node.type.name || 'component'}>`
        let instance = instances.get(id)
        if (!instance) instances.set(id, (instance = { hooks: [], effects: [], root }))
        seen.add(id)
        const before = current
        current = instance
        instance.index = 0
        instance.pending = []
        let rendered
        try {
          rendered = node.type({ ...node.props, children: node.children })
        } finally {
          current = before
        }
        return expand(rendered, id, seen)
      }
      if (node.props.ref && typeof node.props.ref === 'object') {
        node.props.ref.current = { getBoundingClientRect: () => ({ bottom: 10, left: 10 }), contains: () => false, clientWidth: 900 }
      }
      return { ...node, children: node.children.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, seen)) }
    }
    const pass = () => {
      const seen = new Set()
      root.tree = expand(React.createElement(Component, props), '', seen)
      for (const [id, instance] of instances) {
        if (seen.has(id)) continue
        for (const effect of instance.effects) effect?.cleanup?.()
        instances.delete(id)
      }
      for (const id of seen) {
        const instance = instances.get(id)
        for (const { index, effect, deps } of instance.pending) {
          const last = instance.effects[index]
          if (last && deps && same(last.deps, deps)) continue
          last?.cleanup?.()
          instance.effects[index] = { deps, cleanup: effect() }
        }
        instance.pending = []
      }
    }
    root.schedule = () => {
      root.dirty = true
      if (root.rendering) return
      root.rendering = true
      try {
        for (let round = 0; root.dirty; round += 1) {
          assert.ok(round < 100, 'the component keeps rendering')
          root.dirty = false
          pass()
        }
      } finally {
        root.rendering = false
      }
    }
    root.schedule()
    return root
  }
  return { React, ReactDOM, mount }
}

export const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visit))
  if (!node || typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}
export const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return node && typeof node === 'object' ? textOf(node.children) : ''
}
export const settle = async (rounds = 3) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve))
}

export const HOME = '/Users/test'
export const SESSION = 'conv-1'

/**
 * Loads client.js into a host stand-in and returns the three things it registers (the header light, the progress page,
 * the conversation row) with everything a test needs to drive and read them.
 *
 * `view`, `work`, `plugin`, `installer`, `progress` are functions that return what the host would write now.
 * `answer(line)` returns
 * the text (or `{ error }`) of a command; `/awr panel` and `/awr progress` are answered by the stand-in itself.
 * `files`: 'fresh' (written just before), 'stale' (older than any freshness window) or 'none'.
 */
export function loadClient({ view = () => ({ projectRoot: '/work/demo', state: 'not_initialized', steps: [], stop: null, receipt: null }), work = () => undefined, plugin = () => ({ kind: 'checkout', version: '0.1.0' }), installer = () => undefined, progress = () => undefined, answer = () => 'done', files: initial = 'fresh', language = 'en', loopback = true, home = HOME, fileService = true, manager = true, install = async () => ({ ok: true, value: { changed: true, application: 'applied', stage: 'install' } }), publishes = true } = {}) {
  const { React, ReactDOM, mount } = createReact()
  const calls = []
  const reads = []
  const installs = []
  const timers = []
  const listeners = new Map()
  const files = new Map()
  const clock = { now: 1_700_000_000_000 }
  class FakeDate extends Date {
    static now() { return clock.now }
  }
  let factory
  const context = vm.createContext({
    window: { innerWidth: 1200, __ModuleLoader__: { load: (module) => { factory = module.factory } } },
    document: {
      body: {},
      hidden: false,
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener)),
    },
    navigator: { language: language === 'zh' ? 'zh-CN' : 'en-US' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1 },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false },
    Date: FakeDate,
    console,
  })
  vm.runInContext(source, context)
  const plugin_ = factory((name) => ({ react: React, 'react-dom': ReactDOM })[name])
  const panelFile = snapshotPath(SESSION, home)
  const progressFile = progressPath(SESSION, home)
  const host = {
    /** What the host does: write the data of the light and its card. */
    publish() {
      clock.now += 10
      files.set(panelFile, JSON.stringify({ version: 1, updatedAt: clock.now, view: view(), work: work() ?? null, plugin: plugin() ?? null, installer: installer() ?? null }))
    },
    /** What the host does for the page. */
    publishProgress() {
      clock.now += 10
      const value = progress()
      if (value) files.set(progressFile, JSON.stringify({ ...value, updatedAt: clock.now }))
    },
  }
  const dictionaries = {}
  const slots = {}
  const effects = []
  const CHANGES = /^\/awr (claim|checkpoint|end|takeover|update|runtime)( |$)/
  const remote = {
    hostFacts: { home, isLoopback: loopback },
    commands: {
      async execute(sessionId, line) {
        assert.equal(sessionId, SESSION)
        calls.push(line)
        clock.now += 50
        if (line.startsWith('/awr panel')) {
          host.publish()
          return { ok: true, value: { result: { kind: 'success', text: 'ok' } } }
        }
        if (line.startsWith('/awr progress')) {
          host.publishProgress()
          return { ok: true, value: { result: { kind: 'success', text: 'ok' } } }
        }
        const reply = await answer(line, calls)
        if (publishes && CHANGES.test(line)) host.publish()
        if (reply?.error) return { ok: true, value: { result: { kind: 'error', text: reply.error } } }
        return { ok: true, value: { result: { kind: 'success', text: reply } } }
      },
    },
    ...(fileService ? {
      workspaceFiles: {
        async read(sessionId, path, range) {
          reads.push({ sessionId, path, range })
          if (!files.has(path)) return { ok: false, error: { code: 'gateway/not-found' } }
          return { ok: true, value: { absolutePath: path, text: files.get(path), lines: 1, eof: true } }
        },
      },
    } : {}),
    ...(manager ? { pluginManager: { installBundle: async (spec, options) => { installs.push({ spec, options }); return install(spec, options) } } } : {}),
  }
  const ctx = {
    remote,
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
      bind: (namespace) => (key, params) => {
        const text = dictionaries[namespace]?.[language]?.[key]
        return text === undefined ? key : text.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
      },
    },
    effect: (callback) => { effects.push(callback()) },
    inject: (names, callback) => { if (names.every((name) => name !== 'remote.pluginManager' || manager)) callback(ctx) },
    slots: { inject: (_name, callback) => callback(), register: (options, component) => { slots[options.name] = { options, component } } },
  }
  plugin_.apply(ctx)
  if (initial !== 'none') {
    host.publish()
    host.publishProgress()
    if (initial === 'stale') clock.now += 3_600_000
  }

  /** Mounts one of the registered components and returns what a test drives it with. */
  const surface = (slot, props) => {
    const root = mount(slots[slot].component, props)
    const find = (predicate) => {
      let found
      walk(root.tree, (node) => { if (!found && predicate(node)) found = node })
      return found
    }
    const all = (predicate) => {
      const found = []
      walk(root.tree, (node) => { if (predicate(node)) found.push(node) })
      return found
    }
    const ui = {
      root,
      text: () => textOf(root.tree),
      byId: (id) => find((node) => node.props.id === id),
      byTestId: (id) => find((node) => node.props['data-testid'] === id),
      find,
      all,
      async click(target) {
        const node = typeof target === 'string' ? ui.byId(target) : target
        assert.ok(node, `no element ${typeof target === 'string' ? `#${target}` : 'to click'}`)
        assert.ok(!node.props.disabled, 'the element is disabled')
        clock.now += 100 // time passes between what the host last wrote and a click
        node.props.onClick({})
        await settle()
      },
      /** Presses a key on an element that handles keys itself, as a browser would deliver it; true when the page took the key. */
      async keyDown(target, key) {
        const node = typeof target === 'string' ? ui.byId(target) : target
        assert.ok(node?.props.onKeyDown, 'the element does not handle keys')
        const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        node.props.onKeyDown(event)
        await settle()
        return event.defaultPrevented
      },
    }
    return ui
  }
  return {
    calls,
    reads,
    installs,
    files,
    clock,
    host,
    slots,
    dictionaries,
    panelFile,
    progressFile,
    /** The timers that are waiting, by delay. */
    timers: () => timers.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Fire the first waiting timer with this delay (or the first waiting one), as the clock would. */
    async fire(ms) {
      const timer = timers.find((item) => item.live && (ms === undefined || item.ms === ms))
      assert.ok(timer, `no timer${ms === undefined ? '' : ` of ${ms} ms`} is waiting`)
      timer.live = false
      clock.now += timer.ms
      await timer.fn()
      await settle()
    },
    async press(key) {
      for (const listener of listeners.get('keydown') ?? []) listener({ type: 'keydown', key })
      await settle()
    },
    async chip() {
      const ui = surface('conversation.session.header.actions', { sessionId: SESSION })
      await settle()
      return ui
    },
    async page() {
      const ui = surface('conversation.view', slots['conversation.view'].options.inject(SESSION))
      await settle(6)
      return ui
    },
    row(node) {
      return surface('conversation.chat.commandview', { node })
    },
    dispose() {
      for (const cleanup of effects) cleanup?.()
    },
  }
}
