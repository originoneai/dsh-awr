// Checks the package the way DSH reads it, without starting DSH:
// manifest, exported display resources, and that `apply` runs against a stub context.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('manifest declares a bundle patch that exists and inserts this plugin', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, patch)))
  const yaml = read('cordis.patch.yml')
  assert.match(yaml, /^- insert:/m)
  assert.ok(yaml.includes(`name: '${manifest.name}'`), 'the patch must insert the package by name')
})

test('entry point and display resources are exported and listed in files', () => {
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const entry of ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`)
  }
})

test('every locale has a title and description in sentence case', () => {
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${locale}.json`))
    assert.ok(meta.title?.trim() && meta.description?.trim(), `${locale}: title and description`)
  }
  const { title } = JSON.parse(read('locale/en.json')).meta
  const words = title.split(' ').slice(1)
  assert.ok(words.every((w) => w === w.toLowerCase() || /^[A-Z]{2,}$/.test(w)), `sentence case: ${title}`)
})

test('the plugin is named AWR 项目及上下文管控 in Chinese and AWR project and context control in English', () => {
  assert.equal(JSON.parse(read('locale/zh.json')).meta.title, 'AWR 项目及上下文管控')
  assert.equal(JSON.parse(read('locale/en.json')).meta.title, 'AWR project and context control')
})

test('the icon is the logo, white in the dark theme: an SVG within the 256 KiB limit that embeds the PNG and switches on the colour scheme', () => {
  const file = join(root, 'icon.svg')
  assert.ok(statSync(file).size <= 256 * 1024, 'DeepSeek Harness refuses a larger icon')
  const svg = read('icon.svg')
  assert.match(svg, /^<svg[\s>]/)
  const embedded = /<image id="logo"[^>]* href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(svg)
  assert.ok(embedded, 'the logo is embedded as a PNG data URI (an image in an img may load nothing else)')
  const png = Buffer.from(embedded[1], 'base64')
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG')
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'square')
  assert.equal(png[25], 6, 'RGBA: a transparent background')
  // An image follows the colour scheme DeepSeek Harness sets on its page: in the dark theme every colour of the logo becomes white.
  assert.match(svg, /@media \(prefers-color-scheme: dark\) \{ #logo \{ filter: url\(#white\); \} \}/)
  assert.match(svg, /<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"\/>/, 'all three channels are 1 and the alpha is kept')
  assert.ok(!existsSync(join(root, 'icon.png')), 'one icon in the package')
})

test('apply runs against a stub context and registers the conversation listener and asks for commands', async () => {
  const module = await import('../index.js')
  assert.equal(module.name, 'dsh-awr')
  assert.equal(typeof module.apply, 'function')
  const messages = []
  const listeners = []
  const ctx = new Proxy({ logger: { info: (m) => messages.push(m) }, on: (event) => listeners.push(event), inject: () => {} }, {
    get(target, key) {
      if (key in target) return target[key]
      throw new Error(`skeleton must not touch ctx.${String(key)}`)
    },
  })
  module.apply(ctx)
  assert.deepEqual(messages, ['dsh-awr loaded'])
  assert.deepEqual(listeners, ['agent/created', 'agent/pre-step', 'agent/disposed', 'agent/created', 'tools/result', 'agent/disposed', 'session/event', 'tools/result', 'agent/disposed', 'agent/turn-stopping'], 'the listeners: binding, the two of the prompt context, the takeover reviewer\'s restriction, the two of the evidence candidates, the session events for compactions, and the three of the checkpoint request')
})

test('apply wires /awr evidence to what tools/result showed, and DSH_AWR_EVIDENCE_SUGGESTIONS=0 turns it off', async () => {
  const { apply } = await import('../index.js')
  const load = () => {
    const handlers = {}
    const mounts = []
    const ctx = { on: (event, handler) => { (handlers[event] ??= []).push(handler) }, inject: (names, fn) => mounts.push({ names, fn }), logger: { info() {} } }
    apply(ctx)
    const defs = []
    mounts.find((mount) => mount.names.includes('commands')).fn({ commands: { register: (definition) => defs.push(definition) }, effect: (fn) => fn() })
    return { handlers, command: defs.find((definition) => definition.name === 'awr') }
  }
  const agent = { session: { id: 'skeleton-conv' } }
  const { handlers, command } = load()
  assert.equal(handlers['tools/result'].length, 2, 'the evidence candidates and the checkpoint prompter')
  assert.match((await command.handler({ agent, rawInput: 'evidence' })).text, /^No evidence candidates/)
  for (const handler of handlers['tools/result']) handler({ name: 'bash', agent, arguments: { command: 'node --test' } }, { content: [{ type: 'text', text: 'ℹ pass 3\nℹ fail 0' }] })
  const shown = await command.handler({ agent, rawInput: 'evidence' })
  assert.equal(shown.kind, 'success')
  assert.match(shown.text, /test run \(node --test\) pass 3, fail 0: node --test/)
  process.env.DSH_AWR_EVIDENCE_SUGGESTIONS = '0'
  try {
    const off = load()
    assert.match((await off.command.handler({ agent, rawInput: 'evidence' })).text, /turned off/)
    assert.equal(off.handlers['tools/result'].length, 1, 'only the checkpoint prompter listens when the suggestions are off')
  } finally {
    delete process.env.DSH_AWR_EVIDENCE_SUGGESTIONS
  }
})

test('apply tolerates a context without a logger', async () => {
  const { apply } = await import('../index.js')
  assert.doesNotThrow(() => apply({ on() {} }))
  assert.doesNotThrow(() => apply({ on() {}, inject() {} }))
})
