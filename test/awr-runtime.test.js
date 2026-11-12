// Runs the resolver and runner against small fake `awr` programs (real files, real spawns),
// so the bound, unbound, missing and mismatch cases are exercised without a real AWR.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AwrError, createAwr, explain, nativeBehindLauncher, nativeTarget } from '../lib/awr-runtime.js'

const BINDING_REPORT = { program: { version: '0.7.0' }, schema_version: 14, read_only: true, version: 1 }

/** A temporary directory removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-awr-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Write a fake awr that logs every call and answers by command word.
 * `answers` maps a substring of the arguments to the stdout it prints; `sleep` delays the answer.
 */
function fakeAwr(dir, name, answers, { sleep = 0, mkdir = false } = {}) {
  if (mkdir) mkdirSync(dir, { recursive: true })
  const bin = join(dir, name)
  const log = join(dir, `${name}.log`)
  const cases = Object.entries(answers)
    .map(([needle, out]) => `  *"${needle}"*) printf '%s' '${typeof out === 'string' ? out : JSON.stringify(out)}'; exit 0;;`)
    .join('\n')
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$PWD|$*" >> "${log}"\n${sleep ? `/bin/sleep ${sleep}\n` : ''}case "$*" in\n${cases}\n  *) printf '%s' '{"ok":true}';;\nesac\n`,
  )
  chmodSync(bin, 0o755)
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

function project(t, binding) {
  const root = scratch(t)
  mkdirSync(join(root, '.awr'))
  if (binding) writeFileSync(join(root, '.awr', 'runtime-binding.json'), JSON.stringify(binding))
  return root
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const healthy = { 'runtime binding': BINDING_REPORT, status: { ok: true, project_revision: 7 } }

test('bound: uses the cli from .awr/runtime-binding.json, never the awr on PATH', async (t) => {
  const bound = fakeAwr(scratch(t), 'awr', healthy)
  const onPath = fakeAwr(scratch(t), 'awr', healthy)
  const root = project(t, { cli: bound.bin, cli_sha256: sha(bound.bin), program_version: '0.7.0', schema_version: 14 })
  const awr = createAwr({ env: { PATH: join(onPath.bin, '..') } })
  const result = await awr.run(root, ['status'])
  assert.deepEqual(result, { ok: true, project_revision: 7 })
  assert.equal((await awr.resolve(root)).source, 'binding')
  assert.equal(onPath.calls().length, 0, 'the awr on PATH must not be called')
  const last = bound.calls().at(-1)
  assert.ok(last.endsWith(`|--project ${root} --json status`), last)
  assert.ok(last.startsWith(`${root}|`) || last.startsWith(`/private${root}|`), 'runs with the project as cwd')
})

test('unbound: uses the awr on PATH', async (t) => {
  const dir = scratch(t)
  const onPath = fakeAwr(dir, 'awr', healthy)
  const root = project(t)
  const awr = createAwr({ env: { PATH: dir } })
  assert.deepEqual(await awr.run(root, ['status']), { ok: true, project_revision: 7 })
  assert.equal((await awr.resolve(root)).source, 'path')
  assert.ok(onPath.calls().length >= 2, 'one preflight call and one status call')
})

test('missing: no binding file and no awr on PATH stops with a readable message', async (t) => {
  const awr = createAwr({ env: { PATH: scratch(t) }, fallbackDirs: [] })
  const root = project(t)
  await assert.rejects(awr.run(root, ['status']), (error) => {
    assert.equal(error.kind, 'missing')
    assert.match(explain(error), /Install awr/)
    return true
  })
})

test('unbound: an awr in a fallback directory is found when PATH has none, as in a desktop app', async (t) => {
  const dir = scratch(t)
  fakeAwr(dir, 'awr', healthy)
  const root = project(t)
  const awr = createAwr({ env: { PATH: '/usr/bin:/bin' }, fallbackDirs: [join(dir, 'missing'), dir] })
  assert.equal((await awr.resolve(root)).cli, join(dir, 'awr'))
  // PATH still wins over the fallbacks.
  const first = scratch(t)
  const winner = fakeAwr(first, 'awr', healthy)
  const both = createAwr({ env: { PATH: first }, fallbackDirs: [dir] })
  assert.equal((await both.resolve(project(t))).cli, winner.bin)
})

test('an npm launcher is replaced by the native binary beside it, so no node is needed', async (t) => {
  const target = nativeTarget()
  if (!target) return t.skip('no native target for this platform')
  const prefix = scratch(t)
  const scope = join(prefix, 'lib', 'node_modules', '@originoneai')
  mkdirSync(join(scope, 'awr', 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'bin'))
  const launcher = join(scope, 'awr', 'bin', 'awr.cjs')
  writeFileSync(launcher, '#!/usr/bin/env node\nconsole.error("the launcher must not run")\n')
  chmodSync(launcher, 0o755)
  symlinkSync(launcher, join(prefix, 'bin', 'awr'))
  // No native package yet: the launcher is kept.
  assert.equal(await nativeBehindLauncher(join(prefix, 'bin', 'awr')), join(prefix, 'bin', 'awr'))
  const native = fakeAwr(join(scope, `awr-${target}`, 'bin').replace(/^/, ''), 'awr', healthy, { mkdir: true })
  const nativeReal = realpathSync(native.bin) // the launcher is resolved through symlinks, as macOS temp dirs are
  assert.equal(await nativeBehindLauncher(join(prefix, 'bin', 'awr')), nativeReal)
  // Through the runner: PATH holds only the launcher, and the native binary is what runs.
  const awr = createAwr({ env: { PATH: join(prefix, 'bin') }, fallbackDirs: [] })
  const root = project(t)
  assert.equal((await awr.resolve(root)).cli, nativeReal)
  assert.deepEqual(await awr.run(root, ['status']), { ok: true, project_revision: 7 })
  // A plain executable is returned unchanged.
  assert.equal(await nativeBehindLauncher(native.bin), native.bin)
})

test('missing: the pinned cli does not exist', async (t) => {
  const root = project(t, { cli: join(scratch(t), 'gone', 'awr') })
  await assert.rejects(createAwr({ env: {}, fallbackDirs: [] }).run(root, ['status']), { kind: 'missing' })
})

test('mismatch: a changed binary is not run', async (t) => {
  const bound = fakeAwr(scratch(t), 'awr', healthy)
  const root = project(t, { cli: bound.bin, cli_sha256: 'sha256:' + '0'.repeat(64) })
  await assert.rejects(createAwr({ env: {}, fallbackDirs: [] }).run(root, ['status']), { kind: 'binary_changed' })
  assert.equal(bound.calls().length, 0)
})

test('mismatch: program version differs from the pinned binding', async (t) => {
  const bound = fakeAwr(scratch(t), 'awr', healthy)
  const root = project(t, { cli: bound.bin, program_version: '0.4.0', schema_version: 14 })
  await assert.rejects(createAwr({ env: {}, fallbackDirs: [] }).run(root, ['status']), { kind: 'version_mismatch' })
})

test('mismatch: schema differs from the pinned binding', async (t) => {
  const bound = fakeAwr(scratch(t), 'awr', healthy)
  const root = project(t, { cli: bound.bin, program_version: '0.7.0', schema_version: 13 })
  await assert.rejects(createAwr({ env: {}, fallbackDirs: [] }).run(root, ['status']), (error) => {
    assert.equal(error.kind, 'schema_mismatch')
    assert.match(explain(error), /does not migrate, restore or downgrade/)
    return true
  })
})

test('mismatch: awr says the database schema is newer, and the plugin then stays stopped', async (t) => {
  const dir = scratch(t)
  const fake = fakeAwr(dir, 'awr', {
    'runtime binding': BINDING_REPORT,
    status: { code: 'Storage', message: 'storage error: schema 15 is newer than supported 14' },
  })
  const root = project(t)
  const awr = createAwr({ env: { PATH: dir } })
  await assert.rejects(awr.run(root, ['status']), { kind: 'schema_mismatch' })
  const calls = fake.calls().length
  await assert.rejects(awr.run(root, ['status']), { kind: 'schema_mismatch' })
  await assert.rejects(awr.run(root, ['work', 'list']), { kind: 'schema_mismatch' })
  assert.equal(fake.calls().length, calls, 'a stopped project must not spawn awr again')
  assert.equal(awr.stoppedError(root).kind, 'schema_mismatch')
})

test('unsupported: a JSON Unsupported code and the plain-text form both stop the plugin', async (t) => {
  for (const out of [{ code: 'Unsupported', message: 'operation is not implemented: client install' }, 'Unsupported: operation is not implemented: client install\nNext: awr capabilities']) {
    const dir = scratch(t)
    fakeAwr(dir, 'awr', { 'runtime binding': BINDING_REPORT, 'client install': out })
    const awr = createAwr({ env: { PATH: dir } })
    await assert.rejects(awr.run(project(t), ['client', 'install']), { kind: 'unsupported' })
  }
})

test('recovery: an interrupted write is surfaced, and recovery commands are never run', async (t) => {
  const dir = scratch(t)
  const fake = fakeAwr(dir, 'awr', { 'runtime binding': BINDING_REPORT, status: { code: 'MutationIncomplete', message: 'interrupted write, inspect the receipt' } })
  const awr = createAwr({ env: { PATH: dir } })
  const root = project(t)
  await assert.rejects(awr.run(root, ['status']), (error) => {
    assert.equal(error.kind, 'recovery_required')
    assert.match(explain(error), /will not run recovery commands/)
    return true
  })
  const before = fake.calls().length
  for (const args of [['runtime', 'restore'], ['runtime', 'restore-recover'], ['proposal', 'recover', 'P'], ['work', 'create-recover'], ['migrate']]) {
    await assert.rejects(awr.run(root, args), { kind: 'forbidden_command' }, args.join(' '))
  }
  assert.equal(fake.calls().length, before, 'forbidden commands must be refused before they spawn')
})

test('forbidden words in values are allowed; only command positions are checked', async (t) => {
  const dir = scratch(t)
  fakeAwr(dir, 'awr', healthy)
  const awr = createAwr({ env: { PATH: dir } })
  await assert.doesNotReject(awr.run(project(t), ['work', 'create', '--title', 'Restore the backup', '--reason', 'recover']))
})

test('an ordinary awr error is reported but does not stop the plugin', async (t) => {
  const dir = scratch(t)
  const fake = fakeAwr(dir, 'awr', { 'runtime binding': BINDING_REPORT, 'work show': { code: 'NotFound', message: 'not found: work X' } })
  const awr = createAwr({ env: { PATH: dir } })
  const root = project(t)
  await assert.rejects(awr.run(root, ['work', 'show', 'X']), { kind: 'failed', stops: false })
  const calls = fake.calls().length
  assert.deepEqual(await awr.run(root, ['status']), { ok: true })
  assert.ok(fake.calls().length > calls)
})

/** A fake awr that behaves like the real one on failure: nothing on stdout, the error document on stderr, exit 1. */
function failingAwr(dir, stderrText, { exit = 1 } = {}) {
  writeFileSync(
    join(dir, 'awr'),
    `#!/bin/sh\ncase "$*" in\n  *"runtime binding"*) printf '%s' '${JSON.stringify(BINDING_REPORT)}'; exit 0;;\n  *) printf '%s\\n' '${stderrText}' >&2; exit ${exit};;\nesac\n`,
  )
  chmodSync(join(dir, 'awr'), 0o755)
}

test('the real awr prints an error on stderr with a non-zero exit; its code, message and details are kept', async (t) => {
  const dir = scratch(t)
  const document = { code: 'BudgetExceeded', message: 'context budget exceeded: required 783, budget 100', details: { budget: 100, required: 783, next_action: 'awr context compile --budget 783' } }
  failingAwr(dir, JSON.stringify(document))
  const awr = createAwr({ env: { PATH: dir } })
  const root = project(t)
  await assert.rejects(awr.run(root, ['context', 'compile']), (error) => {
    assert.equal(error.kind, 'failed')
    assert.equal(error.stops, false)
    assert.equal(error.details.code, 'BudgetExceeded')
    assert.equal(error.details.awrMessage, document.message)
    assert.deepEqual(error.details.awrDetails, document.details)
    return true
  })
  assert.deepEqual(await awr.run(root, ['runtime', 'binding']), BINDING_REPORT, 'the plugin goes on after an ordinary error')
})

test('an error document after a warning line on stderr is still read, and the nested error form too', async (t) => {
  const dir = scratch(t)
  failingAwr(dir, `warning: slow disk\n${JSON.stringify({ ok: false, error: { code: 'NotFound', message: 'not found: work X' } })}`)
  await assert.rejects(createAwr({ env: { PATH: dir } }).run(project(t), ['work', 'show', 'X']), { kind: 'failed' })
})

test('stderr text that is not an error document stays "not JSON", and Unsupported on stderr stops the plugin', async (t) => {
  const plain = scratch(t)
  failingAwr(plain, 'thread panicked')
  await assert.rejects(createAwr({ env: { PATH: plain } }).run(project(t), ['status']), { kind: 'invalid_output' })
  const unsupported = scratch(t)
  failingAwr(unsupported, 'Unsupported: this build cannot do that')
  await assert.rejects(createAwr({ env: { PATH: unsupported } }).run(project(t), ['status']), { kind: 'unsupported', stops: true })
})

test('an uninitialized project can still run init', async (t) => {
  const dir = scratch(t)
  fakeAwr(dir, 'awr', { 'runtime binding': { code: 'SourceUnavailable', message: 'source unavailable: .awr' }, init: { status: 'preview' } })
  const awr = createAwr({ env: { PATH: dir } })
  const result = await awr.run(project(t), ['init'])
  assert.deepEqual(result, { status: 'preview' })
})

test('output that is not JSON stops the plugin', async (t) => {
  const dir = scratch(t)
  fakeAwr(dir, 'awr', { 'runtime binding': BINDING_REPORT, status: 'this is not json' })
  await assert.rejects(createAwr({ env: { PATH: dir } }).run(project(t), ['status']), { kind: 'invalid_output' })
})

test('a command that runs too long times out without stopping the plugin', async (t) => {
  const dir = scratch(t)
  // The fake answers the binding preflight at once and sleeps only for `status`.
  const bin = join(dir, 'awr')
  writeFileSync(bin, `#!/bin/sh\ncase "$*" in\n  *"runtime binding"*) printf '%s' '${JSON.stringify(BINDING_REPORT)}';;\n  *) exec /bin/sleep 5;;\nesac\n`)
  chmodSync(bin, 0o755)
  const awr = createAwr({ env: { PATH: dir } })
  const root = project(t)
  const error = await awr.run(root, ['status'], { timeoutMs: 150 }).then(() => undefined, (e) => e)
  assert.ok(error instanceof AwrError, String(error))
  assert.equal(error.kind, 'timeout')
  assert.equal(error.stops, false)
  assert.equal(awr.stoppedError(root), undefined)
})

test('explain gives every stopping kind a message that names what to do', () => {
  for (const kind of ['missing', 'binary_changed', 'version_mismatch', 'schema_mismatch', 'unsupported', 'recovery_required', 'forbidden_command']) {
    const text = explain(new AwrError(kind, 'detail', { project: '/p' }))
    assert.ok(text.length > 40 && text.includes('/p'), `${kind}: ${text}`)
  }
})
