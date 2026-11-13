// The bundled-awr installer (DSH-067) against a fixture release: a real tarball holding a small script as `bin/awr`,
// fetched through a fake fetch, unpacked with the system's real tar, smoke-tested by really starting it — so the
// download, checksum, unpack, smoke test, activation, rollback and binding are all exercised without GitHub.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assetName, assetUrl, createAwrInstaller, LATEST_MANIFEST_URL, manifestUrl } from '../lib/awr-install.js'
import { createAwr } from '../lib/awr-runtime.js'

const VERSION = '0.7.0'
const NEXT = '0.8.0'
const TARGET = 'darwin-arm64'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-awr-install-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** A small shell script standing in for the awr binary: answers --version and runtime binding like the real one. */
const AWR_SCRIPT = (version) => `#!/bin/sh
case "$*" in
  *--version*) echo "awr ${version} (test)"; exit 0;;
  *"runtime binding"*) printf '%s' '{"program":{"version":"${version}"},"schema_version":14,"read_only":true,"version":1}'; exit 0;;
  *) printf '%s' '{"ok":true}'; exit 0;;
esac
`

/** A release fixture: the tarball (real tar) and the manifest that declares it, keyed by URL for the fake fetch. */
function release(t, { version = VERSION, target = TARGET, script = AWR_SCRIPT(version), withAsset = true } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-awr-release-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  mkdirSync(join(stage, 'package', 'bin'), { recursive: true })
  writeFileSync(join(stage, 'package', 'bin', 'awr'), script)
  chmodSync(join(stage, 'package', 'bin', 'awr'), 0o755)
  writeFileSync(join(stage, 'package', 'package.json'), JSON.stringify({ name: 'awr-test', version }))
  const name = assetName(target, version)
  execFileSync('tar', ['-czf', join(stage, name), '-C', stage, 'package'])
  const tgz = readFileSync(join(stage, name))
  const manifest = { version, source_sha: 'f'.repeat(40), channel: 'latest', platforms: [target], artifacts: withAsset ? { [name]: sha256(tgz) } : { 'unrelated.txt': sha256('x') } }
  const urls = new Map()
  urls.set(manifestUrl(`v${version}`), Buffer.from(JSON.stringify(manifest)))
  urls.set(LATEST_MANIFEST_URL, urls.get(manifestUrl(`v${version}`)))
  urls.set(assetUrl(version, name), tgz)
  return { urls, name, manifest, tgz }
}

/** fetch that answers from the fixture's URL map and records what was asked. */
function fakeFetch(urls) {
  const calls = []
  return Object.assign(
    async (url) => {
      calls.push(String(url))
      const data = urls.get(String(url))
      if (!data) return { ok: false, status: 404 }
      return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
    },
    { calls },
  )
}

const installer = (t, dir, fetchImpl, options = {}) => createAwrInstaller({ dir, platform: 'darwin', arch: 'arm64', fetchImpl, ...options })

test('check asks the latest manifest and says whether the bundled copy is behind', async (t) => {
  const { urls, name } = release(t)
  const fetchImpl = fakeFetch(urls)
  const found = installer(t, scratch(t), fetchImpl)
  const first = await found.check()
  assert.equal(first.latest, VERSION)
  assert.equal(first.asset, name)
  assert.equal(first.available, true, 'nothing is installed yet')
  assert.deepEqual(fetchImpl.calls, [LATEST_MANIFEST_URL])
  const described = await found.describe()
  assert.equal(described.state, 'none')
  assert.equal(described.check.latest, VERSION)
})

test('a platform with no build is called unsupported and cannot install', async (t) => {
  const { urls } = release(t)
  const found = createAwrInstaller({ dir: scratch(t), platform: 'win32', arch: 'arm64', fetchImpl: fakeFetch(urls) })
  assert.equal(found.target(), undefined)
  assert.equal((await found.describe()).state, 'unsupported')
  await assert.rejects(found.install(), /no awr build for win32-arm64/)
})

test('install downloads, verifies, unpacks and smoke-tests, then points current.json at the new copy', async (t) => {
  const dir = scratch(t)
  const { urls, name } = release(t)
  const fetchImpl = fakeFetch(urls)
  const found = installer(t, dir, fetchImpl)
  const installed = await found.install()
  assert.equal(installed.version, VERSION)
  assert.equal(installed.cli, join(dir, `awr-${VERSION}-${TARGET}`, 'bin', 'awr'))
  assert.ok(existsSync(installed.cli), 'the binary was unpacked into place')
  assert.deepEqual(fetchImpl.calls, [LATEST_MANIFEST_URL, assetUrl(VERSION, name)])
  const current = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
  assert.equal(current.version, VERSION)
  assert.equal(current.cli, installed.cli)
  // The smoke test really ran the binary: --version was answered with the fixture version.
  const out = execFileSync(installed.cli, ['--version'], { encoding: 'utf8' })
  assert.match(out, new RegExp(`^awr ${VERSION} `))
  // After the install, the check is no longer "available".
  assert.equal((await found.check()).available, false)
  // Staging and the downloaded tarball are gone: only the state file and the version directory remain.
  const left = await (await import('node:fs/promises')).readdir(dir)
  assert.deepEqual([...left].sort(), [`awr-${VERSION}-${TARGET}`, 'current.json'])
})

test('a checksum mismatch deletes the download and installs nothing', async (t) => {
  const dir = scratch(t)
  const { urls, name } = release(t)
  const broken = new Map(urls)
  const corrupted = Buffer.from(urls.get(assetUrl(VERSION, name)))
  corrupted[100] ^= 0xff
  broken.set(assetUrl(VERSION, name), corrupted)
  const found = installer(t, dir, fakeFetch(broken))
  await assert.rejects(found.install(), /does not match the checksum/)
  assert.equal(existsSync(join(dir, 'current.json')), false, 'no runtime was activated')
  assert.equal(existsSync(join(dir, `awr-${VERSION}-${TARGET}`)), false, 'no version directory was left')
  const left = (await import('node:fs/promises')).readdir(dir)
  assert.deepEqual((await left).filter((entry) => entry.startsWith('.install-')), [], 'the staging directory is removed')
})

test('a binary that does not start keeps the previous copy active (rollback)', async (t) => {
  const dir = scratch(t)
  const good = release(t)
  // The next release's binary refuses to start. The good release wins for "latest", so the first
  // install takes the working 0.7.0 and only the named update hits the broken 0.8.0.
  const bad = release(t, { version: NEXT, script: '#!/bin/sh\nexit 1\n' })
  const found = installer(t, dir, fakeFetch(new Map([...bad.urls, ...good.urls])))
  await found.install()
  const before = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
  await assert.rejects(found.install({ version: NEXT }), /did not start/)
  const after = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
  assert.deepEqual(after, before, 'current.json was not touched by the failed update')
  assert.equal(existsSync(join(dir, `awr-${NEXT}-${TARGET}`)), false, 'the failed copy was removed')
  assert.equal((await found.cli()), before.cli, 'the previous bundled awr is still offered')
})

test('an update keeps the previous copy for rollback and prunes anything older', async (t) => {
  const dir = scratch(t)
  const first = release(t)
  const second = release(t, { version: NEXT })
  const third = release(t, { version: '0.9.0' })
  const urls = new Map([...first.urls, ...second.urls, ...third.urls])
  // "latest" moves as the test goes on: install 0.7.0, then 0.8.0, then 0.9.0.
  const found = installer(t, dir, fakeFetch(urls))
  await found.install({ version: VERSION })
  const updated = await found.install({ version: NEXT })
  assert.equal(updated.previous, VERSION)
  assert.ok(existsSync(join(dir, `awr-${VERSION}-${TARGET}`, 'bin', 'awr')), 'the previous copy stays for projects bound to it')
  const current = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
  assert.deepEqual(current.previous, { version: VERSION, cli: join(dir, `awr-${VERSION}-${TARGET}`, 'bin', 'awr') })
  await found.install({ version: '0.9.0' })
  assert.equal(existsSync(join(dir, `awr-${VERSION}-${TARGET}`)), false, 'the copy before the previous one is pruned')
  assert.ok(existsSync(join(dir, `awr-${NEXT}-${TARGET}`, 'bin', 'awr')), 'the new previous copy stays')
})

test('cli() is undefined once the installed binary is gone', async (t) => {
  const dir = scratch(t)
  const found = installer(t, dir, fakeFetch(release(t).urls))
  await found.install()
  const cli = await found.cli()
  assert.ok(cli)
  rmSync(cli)
  assert.equal(await found.cli(), undefined)
})

test('a release without a build for this platform is refused before any download', async (t) => {
  const dir = scratch(t)
  const { urls } = release(t, { withAsset: false })
  const fetchImpl = fakeFetch(urls)
  const found = installer(t, dir, fetchImpl)
  await assert.rejects(found.install(), new RegExp(`Release ${VERSION} has no build for ${TARGET}`))
  assert.equal(fetchImpl.calls.length, 1, 'only the manifest was fetched')
})

test('installing a named version asks for that release\'s manifest, and concurrent installs share one run', async (t) => {
  const dir = scratch(t)
  const { urls } = release(t)
  const fetchImpl = fakeFetch(urls)
  const found = installer(t, dir, fetchImpl)
  const [one, two] = await Promise.all([found.install({ version: VERSION }), found.install({ version: VERSION })])
  assert.deepEqual(one, two)
  assert.deepEqual(fetchImpl.calls, [manifestUrl(`v${VERSION}`), assetUrl(VERSION, assetName(TARGET, VERSION))])
})

test('bindProject pins the project to the bundled awr, and the resolver takes the binding over everything', async (t) => {
  const dir = scratch(t)
  const found = installer(t, dir, fakeFetch(release(t).urls))
  await found.install()
  const root = scratch(t)
  const bound = await found.bindProject(root)
  assert.equal(bound.version, VERSION)
  const binding = JSON.parse(readFileSync(bound.file, 'utf8'))
  assert.equal(binding.cli, bound.cli)
  assert.equal(binding.cli_sha256, `sha256:${sha256(readFileSync(bound.cli))}`)
  assert.equal(binding.program_version, VERSION)
  // The runtime resolves the project through the binding even with an empty PATH, and the preflight
  // (runtime binding) passes against the installed binary.
  const awr = createAwr({ env: { PATH: '' }, fallbackDirs: [] })
  const resolved = await awr.resolve(root)
  assert.equal(resolved.source, 'binding')
  assert.equal(resolved.cli, bound.cli)
  assert.deepEqual(await awr.run(root, ['status']), { ok: true })
})

test('bindProject refuses when nothing is installed, and when the installed binary is gone', async (t) => {
  const dir = scratch(t)
  const found = installer(t, dir, fakeFetch(release(t).urls))
  await assert.rejects(found.bindProject(scratch(t)), /No bundled awr is installed/)
  await found.install()
  rmSync((await found.cli()))
  await assert.rejects(found.bindProject(scratch(t)), /is gone/)
})
