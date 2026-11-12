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

test('icon is an SVG within the 256 KiB limit', () => {
  assert.ok(statSync(join(root, 'icon.svg')).size <= 256 * 1024)
  assert.match(read('icon.svg'), /^<svg[\s>]/)
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
  assert.deepEqual(listeners, ['agent/created', 'agent/pre-step', 'agent/disposed', 'agent/created', 'session/event', 'tools/result', 'agent/disposed', 'agent/turn-stopping'], 'the listeners: binding, the two of the prompt context, the takeover reviewer\'s restriction, the session events for compactions, and the three of the checkpoint request')
})

test('apply tolerates a context without a logger', async () => {
  const { apply } = await import('../index.js')
  assert.doesNotThrow(() => apply({ on() {} }))
  assert.doesNotThrow(() => apply({ on() {}, inject() {} }))
})
