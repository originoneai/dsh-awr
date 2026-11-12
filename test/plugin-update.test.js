// What is installed, and whether GitHub has something newer (DSH-059): the host's half of the update.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createAwrCommand } from '../lib/commands.js'
import { createPluginUpdater, latestCommit, locate, lockedCommit, parseGithub, readInstalled, specFor } from '../lib/plugin-update.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('the repository and branch of a GitHub dependency, in every form pnpm saves it', () => {
  const cases = {
    'github:originoneai/dsh-awr': { owner: 'originoneai', repo: 'dsh-awr' },
    'github:originoneai/dsh-awr#main': { owner: 'originoneai', repo: 'dsh-awr', ref: 'main' },
    'originoneai/dsh-awr': { owner: 'originoneai', repo: 'dsh-awr' },
    'https://github.com/originoneai/dsh-awr': { owner: 'originoneai', repo: 'dsh-awr' },
    'https://github.com/originoneai/dsh-awr.git#feature/x': { owner: 'originoneai', repo: 'dsh-awr', ref: 'feature/x' },
    'git+https://github.com/originoneai/dsh-awr.git': { owner: 'originoneai', repo: 'dsh-awr' },
    'git@github.com:originoneai/dsh-awr.git': { owner: 'originoneai', repo: 'dsh-awr' },
    'git+ssh://git@github.com/originoneai/dsh-awr.git#abc': { owner: 'originoneai', repo: 'dsh-awr', ref: 'abc' },
    'https://token@github.com/originoneai/dsh-awr': { owner: 'originoneai', repo: 'dsh-awr' },
  }
  for (const [spec, expected] of Object.entries(cases)) assert.deepEqual(parseGithub(spec), expected, spec)
  for (const spec of ['link:/Users/me/dsh-awr', 'file:../dsh-awr', '^0.1.0', 'https://gitlab.com/a/b', 'https://github.com/onlyowner', undefined, 42, '']) {
    assert.equal(parseGithub(spec), undefined, String(spec))
  }
  assert.ok(!JSON.stringify(parseGithub('https://secret@github.com/a/b')).includes('secret'), 'user information is never kept')
  assert.equal(specFor({ owner: 'o', repo: 'r' }, A), `github:o/r#${A}`)
})

test('the commit the lockfile resolved the package to', () => {
  const repo = { owner: 'originoneai', repo: 'dsh-awr' }
  const lock = [
    "importers:",
    "  .:",
    "    dependencies:",
    "      '@originoneai/dsh-awr':",
    "        specifier: github:originoneai/dsh-awr",
    `        version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}`,
    "packages:",
    `  '@other/thing@https://codeload.github.com/other/thing/tar.gz/${B}':`,
  ].join('\n')
  assert.equal(lockedCommit(lock, repo), A)
  assert.equal(lockedCommit(`  version: github.com/OriginOneAI/dsh-awr/${A}`, repo), A, 'case does not matter')
  const otherFirst = [`  '@other/thing@https://codeload.github.com/other/thing/tar.gz/${B}':`, `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}`].join('\n')
  assert.equal(lockedCommit(otherFirst, repo), A, 'the commit of another package, even when it comes first, is not ours')
  assert.equal(lockedCommit('nothing here', repo), undefined)
  assert.equal(lockedCommit(undefined, repo), undefined)
  assert.equal(lockedCommit('  version: originoneai/dsh-awr@1.2.3', repo), undefined, 'a version is not a commit')
})

/** A profile directory the way DeepSeek Harness lays it out: package.json, pnpm-lock.yaml, node_modules/@originoneai/dsh-awr. */
async function profile(dependency, lock) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-awr-profile-'))
  const root = join(dir, 'node_modules', '.pnpm', 'x@1', 'node_modules', '@originoneai', 'dsh-awr')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@originoneai/dsh-awr', version: '0.1.0' }))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: dependency === undefined ? {} : { '@originoneai/dsh-awr': dependency } }))
  if (lock !== undefined) await writeFile(join(dir, 'pnpm-lock.yaml'), lock)
  return { dir, root }
}

test('locate finds the profile above node_modules; a directory outside one is a checkout', () => {
  assert.deepEqual(locate('/home/u/.dsh/profiles/desktop/node_modules/.pnpm/x/node_modules/@originoneai/dsh-awr'), { root: '/home/u/.dsh/profiles/desktop/node_modules/.pnpm/x/node_modules/@originoneai/dsh-awr', profileDir: '/home/u/.dsh/profiles/desktop' })
  assert.equal(locate('/home/u/src/dsh-awr').profileDir, undefined)
})

test('an installation from GitHub: the repository, the branch, the version and the commit the lockfile names', async () => {
  const { dir, root } = await profile('github:originoneai/dsh-awr#main', `        version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}\n`)
  try {
    assert.deepEqual(await readInstalled({ root, profileDir: dir }), { kind: 'github', version: '0.1.0', repo: { owner: 'originoneai', repo: 'dsh-awr', ref: 'main' }, installed: A })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dependency pinned to a commit names it itself; without a lockfile the commit is simply unknown', async () => {
  const pinned = await profile(`github:originoneai/dsh-awr#${B}`)
  const bare = await profile('github:originoneai/dsh-awr')
  try {
    assert.equal((await readInstalled({ root: pinned.root, profileDir: pinned.dir })).installed, B)
    const found = await readInstalled({ root: bare.root, profileDir: bare.dir })
    assert.equal(found.kind, 'github')
    assert.ok(!('installed' in found))
  } finally {
    await rm(pinned.dir, { recursive: true, force: true })
    await rm(bare.dir, { recursive: true, force: true })
  }
})

test('a link, a registry package, a missing dependency and a checkout are not updated from GitHub', async () => {
  for (const dependency of ['link:/Users/me/dsh-awr', '^0.1.0', undefined]) {
    const { dir, root } = await profile(dependency)
    try {
      assert.equal((await readInstalled({ root, profileDir: dir })).kind, 'other', String(dependency))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const { dir, root } = await profile('link:/x')
  try {
    assert.deepEqual(await readInstalled({ root, profileDir: undefined }), { kind: 'checkout', version: '0.1.0' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const lsRemote = (lines) => async (file, args, options) => {
  lsRemote.last = { file, args, options }
  return lines.join('\n')
}

test('the newest commit of the branch, asked of GitHub without credentials or prompts', async () => {
  const runner = lsRemote([`${A}\trefs/heads/main`])
  const found = await latestCommit({ owner: 'o', repo: 'r', ref: 'main' }, { runner })
  assert.deepEqual(found, { ref: 'main', commit: A })
  const { file, args, options } = lsRemote.last
  assert.equal(file, 'git')
  assert.deepEqual(args, ['-c', 'credential.helper=', 'ls-remote', 'https://github.com/o/r.git', 'main'])
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
  assert.ok(options.timeout > 0)
  const head = await latestCommit({ owner: 'o', repo: 'r' }, { runner: lsRemote([`${B}\tHEAD`]) })
  assert.deepEqual(head, { ref: 'HEAD', commit: B })
  assert.deepEqual(lsRemote.last.args.slice(-1), ['HEAD'])
  // A repository pinned to a commit follows the default branch.
  assert.equal((await latestCommit({ owner: 'o', repo: 'r', ref: A }, { runner: lsRemote([`${B}\tHEAD`]) })).ref, 'HEAD')
  // An annotated tag names the commit it points at, not the tag object.
  const tag = await latestCommit({ owner: 'o', repo: 'r', ref: 'v1' }, { runner: lsRemote([`${A}\trefs/tags/v1`, `${B}\trefs/tags/v1^{}`]) })
  assert.equal(tag.commit, B)
})

test('why GitHub could not be asked is said in words, never with a credential in it', async () => {
  const ask = (error) => latestCommit({ owner: 'o', repo: 'r' }, { runner: async () => { throw error } })
  await assert.rejects(ask(Object.assign(new Error('x'), { code: 'ENOENT' })), /git was not found/)
  await assert.rejects(ask(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), /did not answer within 10 s/)
  await assert.rejects(ask(Object.assign(new Error('x'), { stderr: 'fatal: unable to access https://user:tok@github.com/o/r.git: Could not resolve host\n' })), (error) => /Could not resolve host/.test(error.message) && !error.message.includes('tok'))
  await assert.rejects(latestCommit({ owner: 'o', repo: 'r', ref: 'nope' }, { runner: lsRemote([]) }), /has no branch or tag "nope"/)
  await assert.rejects(latestCommit({ owner: 'o', repo: 'r' }, { runner: lsRemote([]) }), /has no default branch/)
})

test('the updater describes what is installed and remembers the check; a check of a checkout says it is one', async () => {
  const { dir, root } = await profile('github:originoneai/dsh-awr#main', `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}\n`)
  try {
    let time = 1000
    const updater = createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json'), runner: lsRemote([`${B}\trefs/heads/main`]), now: () => time, running: '0.1.0' })
    assert.deepEqual(await updater.describe(), { kind: 'github', version: '0.1.0', running: '0.1.0', repo: 'originoneai/dsh-awr', ref: 'main', installed: A })
    const answer = await updater.check()
    assert.equal(answer.kind, 'github')
    assert.deepEqual(answer.check, { checkedAt: 1000, ref: 'main', latest: B, available: true, spec: `github:originoneai/dsh-awr#${B}` })
    assert.deepEqual((await updater.describe()).check, answer.check, 'the answer stays in what the panel reads')
    const same = createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json'), runner: lsRemote([`${A}\trefs/heads/main`]) })
    assert.equal((await same.check()).check.available, false, 'the same commit is not an update')
    const checkout = createPluginUpdater({ where: { root, profileDir: undefined }, followFile: join(dir, 'follow.json') })
    assert.deepEqual(await checkout.check(), { kind: 'checkout' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update that was installed since the check is no longer on offer, and a host still running the old code says so', async () => {
  const { dir, root } = await profile('github:originoneai/dsh-awr#main', `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}\n`)
  try {
    const updater = createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json'), runner: lsRemote([`${B}\trefs/heads/main`]), now: () => 5, running: '0.1.0' })
    await updater.check()
    assert.equal((await updater.describe()).check.available, true, 'B is newer than the installed A')
    // The plugin manager installs B: the lockfile names it and the package on disk has a new version.
    await writeFile(join(dir, 'pnpm-lock.yaml'), `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${B}\n`)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@originoneai/dsh-awr', version: '0.1.1' }))
    const after = await updater.describe()
    assert.equal(after.check.available, false, 'what was offered is what is installed: the answer of the old check is not still an update')
    assert.equal(after.installed, B)
    assert.equal(after.version, '0.1.1', 'the version on disk is read again, not remembered')
    assert.equal(after.running, '0.1.0', 'the code this process loaded is the old one, and the panel can tell')
    assert.deepEqual({ ...after.check, available: undefined }, { checkedAt: 5, ref: 'main', latest: B, available: undefined, spec: `github:originoneai/dsh-awr#${B}` })
    // An installed commit the lockfile does not name leaves the answer as the check gave it.
    await rm(join(dir, 'pnpm-lock.yaml'))
    assert.equal((await updater.describe()).check.available, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update pins the dependency to a commit; the branch the plugin followed is remembered, and the next check asks that branch', async () => {
  const asked = []
  const runner = async (file, args) => { asked.push(args.at(-1)); return `${B}\trefs/heads/${args.at(-1)}\n${A}\trefs/heads/main\n` }
  const { dir, root } = await profile('github:originoneai/dsh-awr#verify/update-flow', `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}\n`)
  try {
    const followFile = join(dir, 'state', 'follow.json')
    const updater = createPluginUpdater({ where: { root, profileDir: dir }, runner, followFile })
    assert.equal((await updater.check()).check.latest, B)
    assert.deepEqual(asked, ['verify/update-flow'], 'the branch the dependency names')
    assert.deepEqual(JSON.parse(await readFile(followFile, 'utf8')), { 'originoneai/dsh-awr': 'verify/update-flow' }, 'and nothing but the repository and the branch is kept')
    // The plugin manager installed the pinned spec: the dependency names a commit, not a branch.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@originoneai/dsh-awr': `github:originoneai/dsh-awr#${B}` } }))
    await writeFile(join(dir, 'pnpm-lock.yaml'), `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${B}\n`)
    const next = createPluginUpdater({ where: { root, profileDir: dir }, runner, followFile })
    assert.equal((await next.describe()).ref, 'verify/update-flow', 'the card still follows the branch')
    const answer = await next.check()
    assert.deepEqual(asked, ['verify/update-flow', 'verify/update-flow'], 'a commit in the dependency does not send the next check to the default branch')
    assert.equal(answer.check.ref, 'verify/update-flow')
    assert.equal(answer.check.available, false, 'the pinned commit is the newest of the branch')
    // Somebody installs from another branch: that one is followed from now on.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@originoneai/dsh-awr': 'github:originoneai/dsh-awr#release' } }))
    await next.check()
    assert.equal(asked.at(-1), 'release')
    assert.deepEqual(JSON.parse(await readFile(followFile, 'utf8')), { 'originoneai/dsh-awr': 'release' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dependency pinned to a commit that never named a branch follows the default branch; describing writes nothing', async () => {
  const asked = []
  const runner = async (file, args) => { asked.push(args.at(-1)); return `${B}\tHEAD\n` }
  const { dir, root } = await profile(`github:originoneai/dsh-awr#${A}`)
  try {
    const followFile = join(dir, 'state', 'follow.json')
    const updater = createPluginUpdater({ where: { root, profileDir: dir }, runner, followFile })
    assert.equal('ref' in (await updater.describe()), false)
    await assert.rejects(readFile(followFile, 'utf8'), 'describing does not write the file')
    await updater.check()
    assert.deepEqual(asked, ['HEAD'])
    await assert.rejects(readFile(followFile, 'utf8'), 'a check of a commit-pinned dependency has no branch to remember')
    // A file that is not what was written is ignored, not trusted.
    await mkdir(dirname(followFile), { recursive: true })
    for (const garbage of ['not json', '[]', 'null', '"text"', '{"originoneai/dsh-awr": 7}', '{"originoneai/dsh-awr": ""}']) {
      await writeFile(followFile, garbage)
      asked.length = 0
      await updater.check()
      assert.deepEqual(asked, ['HEAD'], garbage)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the description never carries a raw dependency spec, so a credential in one cannot reach the panel', async () => {
  const { dir, root } = await profile('https://user:secret-token@github.com/originoneai/dsh-awr')
  try {
    const updater = createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json') })
    assert.ok(!JSON.stringify(await updater.describe()).includes('secret-token'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/awr update check says in one sentence whether there is something newer, in the interface language', async () => {
  const { dir, root } = await profile('github:originoneai/dsh-awr#main', `  version: https://codeload.github.com/originoneai/dsh-awr/tar.gz/${A}\n`)
  try {
    const make = (lines) => createAwrCommand({ awr: {}, bindings: { get: () => undefined }, updater: createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json'), runner: lsRemote(lines) }) })
    const agent = { session: { id: 'c1' } }
    const newer = await make([`${B}\trefs/heads/main`])({ agent, rawInput: 'update check --ui zh' })
    assert.equal(newer.kind, 'success')
    assert.equal(newer.text.split('\n')[0], 'GitHub 上有新版本的插件，点「更新」即可安装。')
    assert.match(newer.text.split('\n')[1], /originoneai\/dsh-awr · installed aaaaaaa, newest bbbbbbb \(main\)/)
    const english = await make([`${B}\trefs/heads/main`])({ agent, rawInput: 'update' })
    assert.equal(english.text.split('\n')[0], 'A newer version of the plugin is available on GitHub. Press Update to install it.')
    const current = await make([`${A}\trefs/heads/main`])({ agent, rawInput: 'update check --ui zh' })
    assert.equal(current.text.split('\n')[0], '插件已是最新版本。')
    const failed = await createAwrCommand({ awr: {}, bindings: { get: () => undefined }, updater: createPluginUpdater({ where: { root, profileDir: dir }, followFile: join(dir, 'follow.json'), runner: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } }) })({ agent, rawInput: 'update check --ui zh' })
    assert.equal(failed.kind, 'error')
    assert.equal(failed.text.split('\n')[0], '无法检查更新。')
    const none = await createAwrCommand({ awr: {}, bindings: { get: () => undefined } })({ agent, rawInput: 'update' })
    assert.equal(none.kind, 'error')
    const bad = await make([])({ agent, rawInput: 'update now' })
    assert.equal(bad.kind, 'error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
