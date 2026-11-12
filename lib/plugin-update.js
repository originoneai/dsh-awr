// What is installed, and whether GitHub has something newer (DSH-059).
//
// A plugin installed from GitHub keeps the version of its package.json however many commits it has, and
// DeepSeek Harness's plugin page updates registry packages only, so the panel offers the update itself. This file is the
// host's half: it reads which commit of which repository the profile has installed and asks GitHub for the newest commit
// of the branch the plugin follows. The panel's half installs that commit with the plugin manager (client.js).
//
// The installed commit is read from the profile, not guessed: the dependency the profile saved
// (`github:owner/repo`, `github:owner/repo#ref`, or an https URL of it) names the repository and the branch, and the
// profile's pnpm lockfile names the commit pnpm resolved it to. A plugin that runs from a checkout (`link:`) has none,
// and offers no update.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from './panel-snapshot.js'

export const PACKAGE = '@originoneai/dsh-awr'
const SHA = /^[0-9a-f]{40}$/
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/

/**
 * Where the branch or tag the plugin follows is remembered. An update installs the repository pinned to a commit, and a
 * dependency pinned to a commit no longer names the branch it came from; without this the next check would ask the
 * repository's default branch and offer to move the plugin there.
 */
export const FOLLOW_FILE = join(homedir(), '.local', 'state', 'dsh-awr', 'follow.json')
const followKey = ({ owner, repo }) => `${owner}/${repo}`.toLowerCase()
async function readFollowed(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** The directory of this package, and the profile whose node_modules holds it (none for a checkout). */
export function locate(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const marker = `${sep}node_modules${sep}`
  const at = root.indexOf(marker)
  return { root, profileDir: at === -1 ? undefined : root.slice(0, at) }
}

/**
 * The version of the code this process loaded. It is read once, when the module is loaded: an update replaces the files on
 * disk, but a host that is still running has the old code until DeepSeek Harness is restarted, and the difference says so.
 */
const LOADED_VERSION = (() => {
  try {
    const version = JSON.parse(readFileSync(join(locate().root, 'package.json'), 'utf8')).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
})()

/**
 * The repository and branch a dependency spec names, or undefined when it is not a GitHub one. Accepts
 * `github:owner/repo[#ref]`, `owner/repo[#ref]`, `https://github.com/owner/repo[.git][#ref]`, `git+https://…` and
 * `git@github.com:owner/repo[.git]`; user information in a URL is dropped, never kept.
 */
export function parseGithub(spec) {
  if (typeof spec !== 'string') return undefined
  let text = spec.trim()
  let ref
  const hash = text.indexOf('#')
  if (hash !== -1) {
    ref = text.slice(hash + 1) || undefined
    text = text.slice(0, hash)
  }
  text = text.replace(/^git\+/, '')
  let path
  const short = /^(?:github:)?([^/:@\s]+\/[^/:@\s]+)$/.exec(text)
  const scp = /^git@github\.com:(.+)$/.exec(text)
  if (short) path = short[1]
  else if (scp) path = scp[1]
  else {
    let url
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') return undefined
    path = url.pathname.replace(/^\/+/, '')
  }
  path = path.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!OWNER_REPO.test(path)) return undefined
  const [owner, repo] = path.split('/')
  return { owner, repo, ...(ref ? { ref } : {}) }
}

/** The spec the plugin manager installs for a commit: the repository pinned to it. */
export const specFor = ({ owner, repo }, sha) => `github:${owner}/${repo}#${sha}`

/** The commit the profile's pnpm lockfile resolved this package to, or undefined. */
export function lockedCommit(lockfile, repo) {
  const needle = `${repo.owner}/${repo.repo}`.toLowerCase()
  for (const line of String(lockfile ?? '').split('\n')) {
    if (!line.toLowerCase().includes(needle)) continue
    const found = /(?:^|[^0-9a-f])([0-9a-f]{40})(?![0-9a-f])/.exec(line)
    if (found) return found[1]
  }
  return undefined
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * What is installed: `kind` is `github` (installed from a GitHub repository), `checkout` (run from a directory outside
 * a profile's node_modules, a development checkout) or `other` (anything else: a registry package, a tarball, a path).
 * For `github`, `repo` is `{ owner, repo, ref? }` and `installed` is the commit, when the lockfile says.
 */
export async function readInstalled({ root, profileDir } = locate()) {
  const own = await readJson(join(root, 'package.json'))
  const version = typeof own?.version === 'string' ? own.version : undefined
  if (!profileDir) return { kind: 'checkout', version }
  const manifest = await readJson(join(profileDir, 'package.json'))
  const spec = manifest?.dependencies?.[PACKAGE] ?? manifest?.devDependencies?.[PACKAGE]
  const repo = parseGithub(spec)
  if (!repo) return { kind: 'other', version }
  let installed = SHA.test(repo.ref ?? '') ? repo.ref : undefined
  if (!installed) {
    try {
      installed = lockedCommit(await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8'), repo)
    } catch {
      installed = undefined
    }
  }
  return { kind: 'github', version, repo, ...(installed ? { installed } : {}) }
}

const run = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(String(stdout))))
})

/**
 * The newest commit of `ref` (the repository's default branch for none) on GitHub, by `git ls-remote`: no credentials
 * and no prompt, so a repository that needs them is reported as unreachable rather than waited for.
 */
export async function latestCommit(repo, { runner = run, timeoutMs = 10_000 } = {}) {
  const ref = repo.ref && !SHA.test(repo.ref) ? repo.ref : 'HEAD'
  const url = `https://github.com/${repo.owner}/${repo.repo}.git`
  let out
  try {
    out = await runner('git', ['-c', 'credential.helper=', 'ls-remote', url, ref === 'HEAD' ? 'HEAD' : ref], {
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('git was not found, so GitHub cannot be asked.')
    if (error?.killed || error?.signal === 'SIGTERM') throw new Error(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} s.`)
    const why = String(error?.stderr || error?.message || '').split('\n').find((line) => line.trim()) ?? 'unknown error'
    throw new Error(`GitHub could not be asked: ${why.replace(/https?:\/\/[^@\s]*@/g, 'https://')}`)
  }
  const lines = out.split('\n').map((line) => line.split('\t')).filter(([sha]) => SHA.test(sha ?? ''))
  // An annotated tag lists the tag object and, after it, the commit it points at (`^{}`): the commit is what is installed.
  const peeled = lines.find(([, name]) => name?.endsWith('^{}'))
  const chosen = peeled ?? lines.find(([, name]) => ref === 'HEAD' || name === ref || name === `refs/heads/${ref}` || name === `refs/tags/${ref}`) ?? lines[0]
  if (!chosen) throw new Error(`GitHub has no ${ref === 'HEAD' ? 'default branch' : `branch or tag "${ref}"`} in ${repo.owner}/${repo.repo}.`)
  return { ref, commit: chosen[0] }
}

/**
 * What the panel shows about the plugin itself, and the check for a newer commit.
 *
 * `describe()` is data for the panel's snapshot (no raw spec, so no credentials): `{ kind, version, running?, repo?,
 * installed?, check? }`, where `version` is what is on disk now and `running` is what this process loaded. `check()` asks
 * GitHub and remembers the answer until the plugin is loaded again; `describe()` says whether it still is an update.
 */
export function createPluginUpdater({ where, runner, now = Date.now, timeoutMs, running = LOADED_VERSION, followFile = FOLLOW_FILE } = {}) {
  let last
  // Read each time: three small files, and an update that was just installed must not be described as it was before.
  const info = () => readInstalled(where ?? locate())
  /** The branch or tag the plugin follows: the one its dependency names, or the one remembered once an update pinned it. */
  const following = async (repo) => {
    if (repo.ref && !SHA.test(repo.ref)) return repo.ref
    const remembered = (await readFollowed(followFile))[followKey(repo)]
    return typeof remembered === 'string' && remembered ? remembered : undefined
  }
  return {
    info,
    async describe() {
      const found = await info()
      const ref = found.repo ? await following(found.repo) : undefined
      // The answer of the last check, with whether it still is one: the commit that was offered may be the one installed now.
      const check = last ? { ...last, available: found.installed ? found.installed !== last.latest : last.available } : undefined
      return {
        kind: found.kind,
        ...(found.version ? { version: found.version } : {}),
        ...(running ? { running } : {}),
        ...(found.repo ? { repo: `${found.repo.owner}/${found.repo.repo}`, ...(ref ? { ref } : {}) } : {}),
        ...(found.installed ? { installed: found.installed } : {}),
        ...(check ? { check } : {}),
      }
    },
    /** @returns {Promise<{ kind: string, check?: object }>} the answer, or a thrown Error that says why GitHub could not be asked */
    async check() {
      const found = await info()
      if (found.kind !== 'github') return { kind: found.kind }
      const ref = await following(found.repo)
      const { ref: asked, commit } = await latestCommit({ owner: found.repo.owner, repo: found.repo.repo, ...(ref ? { ref } : {}) }, { runner, timeoutMs })
      // A dependency that names a branch is where it is remembered, for the day an update pins it to a commit.
      if (ref && found.repo.ref === ref) {
        const known = await readFollowed(followFile)
        if (known[followKey(found.repo)] !== ref) await writeFileAtomic(dirname(followFile), basename(followFile), { ...known, [followKey(found.repo)]: ref }).catch(() => {})
      }
      last = {
        checkedAt: now(),
        ref: asked,
        latest: commit,
        // An installed commit the lockfile did not name is not a reason to say nothing: the newest one is offered.
        available: found.installed !== commit,
        spec: specFor(found.repo, commit),
      }
      return { kind: 'github', check: last, installed: found.installed, repo: found.repo }
    },
  }
}
