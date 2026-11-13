// The awr the plugin installs itself when a machine has none or only an old one (DSH-067).
//
// The plugin runs the machine's `awr` whenever one is usable (lib/awr-runtime.js); this module is the fallback for
// the machines the takeover panel and the progress page stopped on. It downloads the platform package of an
// originoneai/awr release into the plugin's own state directory, checks it against the sha256 the release manifest
// declares, unpacks it, starts it once as a smoke test, and only then makes it the bundled runtime. Nothing goes on
// PATH and no awr that is already installed is touched: a project is bound to the bundled copy through its
// `.awr/runtime-binding.json`, the same file DSH-011 defined.
//
//   <home>/.local/state/dsh-awr/runtime/awr-<version>-<target>/bin/awr   one per installed version
//   <home>/.local/state/dsh-awr/runtime/current.json                     { version, target, cli, installedAt, previous? }
//
// The previous version's directory is kept: current.json moves only after the new copy passes its smoke test, so a
// download that fails or a binary that does not start leaves the machine exactly as it was, and a project bound to
// the old copy keeps working.
import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nativeTarget } from './awr-runtime.js'
import { writeFileAtomic } from './panel-snapshot.js'

export const REPOSITORY = 'originoneai/awr'
export const RUNTIME_DIR = join(homedir(), '.local', 'state', 'dsh-awr', 'runtime')
/** The manifest of the newest release, and of one tag (`v0.7.0`). Each declares its artifacts' sha256. */
export const LATEST_MANIFEST_URL = `https://github.com/${REPOSITORY}/releases/latest/download/release-manifest.json`
export const manifestUrl = (tag) => `https://github.com/${REPOSITORY}/releases/download/${tag}/release-manifest.json`
export const assetUrl = (version, name) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`
export const assetName = (target, version) => `originoneai-awr-${target}-${version}.tgz`

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const CURRENT = 'current.json'
/** Downloads get this long before they are called unreachable; the smoke test gets a tenth of it. */
const DEFAULT_TIMEOUT_MS = 300_000

async function readCurrent(dir) {
  try {
    const value = JSON.parse(await readFile(join(dir, CURRENT), 'utf8'))
    return typeof value?.cli === 'string' && typeof value?.version === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const run = (execFile, file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(String(stdout))))
})

/**
 * Installs, keeps and binds the bundled awr.
 *
 * @param {{ dir?: string, platform?: string, arch?: string, fetchImpl?: typeof fetch, execFileImpl?: typeof nodeExecFile, tar?: string, now?: () => number, timeoutMs?: number }} [options]
 * `fetchImpl`, `execFileImpl`, `tar`, `platform` and `arch` are injectable so the tests need neither network nor a
 * real release.
 */
export function createAwrInstaller({ dir = RUNTIME_DIR, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch?.bind(globalThis), execFileImpl = nodeExecFile, tar = 'tar', now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = nativeTarget(platform, arch)
  const binary = platform === 'win32' ? 'awr.exe' : 'awr'
  let lastCheck
  let installing

  async function download(url) {
    if (typeof fetchImpl !== 'function') throw new Error('This runtime has no fetch, so releases cannot be downloaded.')
    let response
    try {
      response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new Error(`GitHub could not be reached: ${error?.message ?? error}`)
    }
    if (!response?.ok) throw new Error(`GitHub answered ${response?.status ?? 'an error'} for ${url}.`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** The release manifest of `version` (the newest for none), with this platform's asset picked out. */
  async function manifest(version) {
    const data = await download(version ? manifestUrl(`v${version}`) : LATEST_MANIFEST_URL)
    let document
    try {
      document = JSON.parse(data.toString('utf8'))
    } catch {
      throw new Error('The release manifest is not JSON.')
    }
    if (!VERSION.test(String(document?.version ?? '')) || typeof document?.artifacts !== 'object' || document.artifacts === null) {
      throw new Error('The release manifest does not look like one (no version, no artifacts).')
    }
    const name = target ? assetName(target, document.version) : undefined
    const expected = name ? document.artifacts[name] : undefined
    return { version: document.version, name, expected, url: name ? assetUrl(document.version, name) : undefined }
  }

  /** Where an installed version lives and the binary inside it. */
  const homeOf = (version) => join(dir, `awr-${version}-${target}`)
  const cliOf = (version) => join(homeOf(version), 'bin', binary)

  async function smoke(cli, version) {
    let out
    try {
      out = await run(execFileImpl, cli, ['--version'], { timeout: Math.max(10_000, Math.floor(timeoutMs / 10)), windowsHide: true })
    } catch (error) {
      throw new Error(`The downloaded awr did not start (${error?.code ?? error?.message ?? error}). Nothing was installed.`)
    }
    if (!out.includes(version)) throw new Error(`The downloaded awr answered "--version" with ${JSON.stringify(out.slice(0, 120))}, not ${version}. Nothing was installed.`)
  }

  return {
    /** The platform package this machine would take, or undefined when no release builds for it. */
    target: () => target,

    /** The bundled awr's cli path when it is installed and still there; the runtime's last fallback. */
    async cli() {
      const current = await readCurrent(dir)
      if (!current) return undefined
      try {
        await access(current.cli)
        return current.cli
      } catch {
        return undefined
      }
    },

    /** What the panel shows: `state` is `unsupported` (no build for this platform), `none` or `installed`. */
    async describe() {
      const current = await readCurrent(dir)
      return {
        state: !target ? 'unsupported' : current ? 'installed' : 'none',
        ...(target ? { target } : {}),
        ...(current ? { version: current.version, cli: current.cli, installedAt: current.installedAt } : {}),
        ...(lastCheck ? { check: lastCheck } : {}),
      }
    },

    /** Asks GitHub for the newest release and whether it is newer than the bundled copy. */
    async check() {
      const found = await manifest()
      const current = await readCurrent(dir)
      lastCheck = {
        checkedAt: now(),
        latest: found.version,
        asset: found.name ?? null,
        available: target !== undefined && found.expected !== undefined && current?.version !== found.version,
        ...(target && found.expected === undefined ? { message: `Release ${found.version} has no build for ${target}.` } : {}),
      }
      return lastCheck
    },

    /**
     * Downloads `version` (the newest release for none), verifies it against the manifest's sha256, unpacks and
     * smoke-tests it, and only then makes it the bundled runtime. A failure anywhere leaves the previous copy
     * active: current.json is written last, and the old directory is never removed before the new one works.
     */
    async install({ version } = {}) {
      if (installing) return installing
      installing = (async () => {
        if (!target) throw new Error(`There is no awr build for ${platform}-${arch}.`)
        if (version !== undefined && !VERSION.test(version)) throw new Error(`"${version}" is not a release version.`)
        const found = await manifest(version)
        if (!found.expected) throw new Error(`Release ${found.version} has no build for ${target}.`)
        const tgz = await download(found.url)
        const actual = sha256(tgz)
        if (actual !== found.expected) {
          throw new Error(`The downloaded package does not match the checksum the release declares (${found.name}). It was deleted; nothing was installed.`)
        }
        await mkdir(dir, { recursive: true })
        const staging = await mkdtemp(join(dir, '.install-'))
        try {
          await writeFile(join(staging, found.name), tgz)
          await run(execFileImpl, tar, ['-xzf', join(staging, found.name), '-C', staging], { timeout: 60_000, windowsHide: true }).catch((error) => {
            throw new Error(`The package could not be unpacked with the system's tar (${error?.message ?? error}). Nothing was installed.`)
          })
          const cli = join(staging, 'package', 'bin', binary)
          await chmod(cli, 0o755).catch(() => {})
          await smoke(cli, found.version)
          // Everything checked: move the copy into place and point current.json at it. The previous version's
          // directory stays, and the pointer remembers it, so a bad update is one write away from the old copy.
          await rm(homeOf(found.version), { recursive: true, force: true })
          await rename(join(staging, 'package'), homeOf(found.version))
          const previous = await readCurrent(dir)
          await writeFileAtomic(dir, CURRENT, {
            version: found.version,
            target,
            cli: cliOf(found.version),
            installedAt: now(),
            ...(previous && previous.version !== found.version ? { previous: { version: previous.version, cli: previous.cli } } : {}),
          })
          // Version directories that are neither the current nor the previous copy are removed.
          const keep = new Set([homeOf(found.version), ...(previous?.cli ? [dirname(dirname(previous.cli))] : [])])
          for (const entry of await readdir(dir).catch(() => [])) {
            const home = join(dir, entry)
            if (entry.startsWith('awr-') && !keep.has(home)) await rm(home, { recursive: true, force: true }).catch(() => {})
          }
          return { version: found.version, cli: cliOf(found.version), previous: previous?.version !== found.version ? previous?.version : undefined }
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {})
        }
      })().finally(() => { installing = undefined })
      return installing
    },

    /**
     * Pins a project to the bundled awr through `.awr/runtime-binding.json` (the file of DSH-011: the resolver
     * prefers it over PATH, checks the binary against `cli_sha256` and the program against `program_version`).
     */
    async bindProject(root) {
      const current = await readCurrent(dir)
      if (!current) throw new Error('No bundled awr is installed yet.')
      await access(current.cli).catch(() => {
        throw new Error(`The bundled awr (${current.cli}) is gone; install it again.`)
      })
      const hash = sha256(await readFile(current.cli))
      const binding = { version: 1, host: 'dsh-awr', cli: current.cli, cli_sha256: `sha256:${hash}`, program_version: current.version }
      const file = await writeFileAtomic(join(root, '.awr'), 'runtime-binding.json', binding)
      return { file, cli: current.cli, version: current.version }
    },
  }
}
