// Finds the right `awr` for a project, checks it is compatible, and runs it by argv.
// Every other capability of the plugin goes through `createAwr().run`.
//
// Rules this module enforces (from the owner's AWR instructions):
//   - A project with `.awr/runtime-binding.json` uses the `cli` it names, never the `awr` on
//     PATH. Without the file, the `awr` on PATH is used.
//   - A missing binary, a binary or schema that differs from the pinned binding, an
//     `Unsupported` result, or a result that asks for a migration or a restore stops the
//     plugin for that project with a message the user can read. Nothing here migrates,
//     restores or downgrades, and the commands that would are refused before they spawn.
//   - Commands run without a shell; arguments are passed as an array.
import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

/** Why the plugin stopped. The text of each is produced by `explain`. */
export const KINDS = Object.freeze([
  'missing', // no usable awr binary
  'binary_changed', // the bound cli no longer matches the pinned hash
  'version_mismatch', // the program version differs from the pinned binding
  'schema_mismatch', // the project database schema differs, or awr says it is newer or needs an upgrade
  'unsupported', // awr reports the operation or protocol as unsupported
  'recovery_required', // awr reports an interrupted write that needs a human decision
  'forbidden_command', // the plugin refused to run a migrate, restore or downgrade command
  'invalid_output', // awr produced something that is not the documented JSON
  'timeout',
  'failed', // awr ran and reported an ordinary error; the project is still usable
])

/** Kinds after which the plugin stops using awr for that project. */
const STOPPING = new Set([
  'missing',
  'binary_changed',
  'version_mismatch',
  'schema_mismatch',
  'unsupported',
  'recovery_required',
  'invalid_output',
])

/** Subcommands that change the runtime database format or replace it. Never run by the plugin. */
const FORBIDDEN = new Set([
  'migrate',
  'downgrade',
  'restore',
  'restore-preview',
  'restore-recover',
  'recover',
  'create-recover',
  'relocate-recover',
])

const RECOVERY_CODES = new Set(['MutationIncomplete', 'WorkActionIncomplete', 'CheckpointIncomplete'])
const UNSUPPORTED_CODES = new Set(['Unsupported', 'ProtocolUnsupported', 'CapabilityUnavailable'])
const SCHEMA_MESSAGE = /newer than supported|upgrade explicitly|different application|requires the current schema/i

export class AwrError extends Error {
  /**
   * @param {string} kind one of KINDS
   * @param {string} message what happened, in one sentence
   * @param {{ code?: string, cli?: string, project?: string, awrMessage?: string, awrDetails?: object }} [details]
   */
  constructor(kind, message, details = {}) {
    super(message)
    this.name = 'AwrError'
    this.kind = kind
    this.details = details
    this.stops = STOPPING.has(kind)
  }
}

/** The text shown to the user when the plugin stops using awr. */
export function explain(error) {
  const where = error.details?.project ? ` for ${error.details.project}` : ''
  const never = 'The plugin does not migrate, restore or downgrade; do that yourself with the awr you intend to use.'
  switch (error.kind) {
    case 'missing':
      return `AWR is not available${where}: ${error.message} Install awr, or fix the cli path in .awr/runtime-binding.json.`
    case 'binary_changed':
      return `AWR was stopped${where}: ${error.message} ${never}`
    case 'version_mismatch':
    case 'schema_mismatch':
      return `AWR was stopped${where} because the runtime does not match the project: ${error.message} ${never}`
    case 'unsupported':
      return `AWR was stopped${where}: this awr reports the operation as unsupported (${error.message}). Check the awr version.`
    case 'recovery_required':
      return `AWR needs a recovery decision${where}: ${error.message} The plugin will not run recovery commands.`
    case 'forbidden_command':
      return `Refused to run an AWR command that changes or replaces runtime state${where}: ${error.message}`
    default:
      return `AWR${where}: ${error.message}`
  }
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function isExecutable(path) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The platform package that holds the native binary, as the npm launcher names it. */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  return { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu', 'win32-x64': 'win32-x64' }[`${platform}-${arch}`]
}

/**
 * The npm package installs `awr` as a Node launcher script. Running it needs a `node` on the
 * path, and a host app can put its own `node` wrapper first (DeepSeek Harness does), which then
 * fails. The launcher only locates a native binary in a sibling package, so when `cli` is that
 * launcher, use the native binary directly. Anything else is returned unchanged.
 */
export async function nativeBehindLauncher(cli) {
  let real
  try {
    real = await realpath(cli)
  } catch {
    return cli
  }
  const target = nativeTarget()
  if (!real.endsWith('.cjs') || !target) return cli
  // .../node_modules/@originoneai/awr/bin/awr.cjs -> .../node_modules/@originoneai/awr-<target>/bin/awr
  const scope = dirname(dirname(dirname(real)))
  const native = join(scope, `awr-${target}`, 'bin', process.platform === 'win32' ? 'awr.exe' : 'awr')
  return (await isExecutable(native)) ? native : cli
}

/**
 * Where a desktop app looks for `awr` after `PATH`. An app started from the Dock or Finder does
 * not inherit the shell's `PATH`, so Homebrew and per-user install directories are checked too.
 */
export function defaultFallbackDirs(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE
  return ['/opt/homebrew/bin', '/usr/local/bin', ...(home ? [join(home, '.local', 'bin'), join(home, '.cargo', 'bin')] : [])]
}

async function findOnPath(name, env, fallbackDirs) {
  const dirs = [...String(env.PATH ?? '').split(delimiter), ...fallbackDirs]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/** The JSON document in `text`, or in its last line (awr may print a warning before the document). */
function parseDocument(text) {
  for (const candidate of [text, text.split('\n').filter(Boolean).at(-1) ?? '']) {
    if (!candidate.startsWith('{')) continue
    try {
      return { json: JSON.parse(candidate) }
    } catch {
      // not a document; try the next candidate
    }
  }
  return undefined
}

/**
 * Reads what awr printed. awr prints one JSON document: a result on stdout, and an error, with a
 * non-zero exit, on stderr (`{ "code", "message", "details" }`, or `{ "ok": false, "error": { ... } }`).
 * Both streams are read, stdout first. A few older builds print `Unsupported: ...` as plain text.
 */
function interpret(stdout, stderr, status) {
  const out = String(stdout ?? '').trim()
  const err = String(stderr ?? '').trim()
  const parsed = (out ? parseDocument(out) : undefined) ?? (err ? parseDocument(err) : undefined)
  if (!parsed) {
    const plain = out || err
    if (/^Unsupported:/i.test(plain)) return { error: { code: 'Unsupported', message: plain.split('\n')[0] } }
    return { invalid: plain.slice(0, 200) || `no output (exit ${status})` }
  }
  const { json } = parsed
  const error = json?.error?.code ? json.error : json?.code && json?.message && json.ok !== true ? json : undefined
  return error ? { error: { code: error.code, message: String(error.message ?? ''), awrDetails: error.details } } : { json }
}

function fromAwrError(error, context) {
  const { code, message, awrDetails } = error
  // `awrDetails` is what awr itself reported next to the error (for BudgetExceeded: the budget it needs
  // and the command it suggests), passed on untouched.
  const details = { ...context, code, awrMessage: message, ...(awrDetails && typeof awrDetails === 'object' ? { awrDetails } : {}) }
  if (UNSUPPORTED_CODES.has(code) || /^Unsupported:/i.test(message)) {
    return new AwrError('unsupported', `${code}: ${message}`, details)
  }
  if (RECOVERY_CODES.has(code)) return new AwrError('recovery_required', `${code}: ${message}`, details)
  if (code === 'Storage' && SCHEMA_MESSAGE.test(message)) {
    return new AwrError('schema_mismatch', message, details)
  }
  return new AwrError('failed', `${code}: ${message}`, details)
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, execFile?: typeof nodeExecFile, timeoutMs?: number, fallbackDirs?: string[] }} [options]
 */
export function createAwr({ env = process.env, execFile = nodeExecFile, timeoutMs = 60_000, fallbackDirs = defaultFallbackDirs(env) } = {}) {
  /** @type {Map<string, Promise<{ cli: string, source: 'binding' | 'path', binding?: object }>>} */
  const resolved = new Map()
  /** @type {Map<string, AwrError>} */
  const stopped = new Map()

  function spawn(cli, args, cwd, limit) {
    return new Promise((done) => {
      execFile(cli, args, { cwd, env, timeout: limit, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        done({ error, stdout, stderr })
      })
    })
  }

  async function exec(cli, project, args, limit) {
    const argv = ['--project', project, '--json', ...args]
    const { error, stdout, stderr } = await spawn(cli, argv, project, limit)
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      throw new AwrError('timeout', `awr did not finish within ${limit} ms.`, { cli, project })
    }
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
      throw new AwrError('missing', `${cli} cannot be started (${error.code}).`, { cli, project })
    }
    const result = interpret(stdout, stderr, error?.code ?? 0)
    if (result.invalid !== undefined) {
      throw new AwrError('invalid_output', `awr printed output that is not JSON: ${result.invalid}`, { cli, project })
    }
    if (result.error) throw fromAwrError(result.error, { cli, project })
    return result.json
  }

  async function locate(project) {
    const bindingPath = join(project, '.awr', 'runtime-binding.json')
    let raw
    try {
      raw = await readFile(bindingPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw new AwrError('invalid_output', `Cannot read ${bindingPath}: ${error.code}.`, { project })
    }
    if (raw === undefined) {
      const cli = await findOnPath('awr', env, fallbackDirs)
      if (!cli) throw new AwrError('missing', 'No awr was found on PATH and the project has no .awr/runtime-binding.json.', { project })
      return { cli: await nativeBehindLauncher(cli), source: 'path' }
    }
    let binding
    try {
      binding = JSON.parse(raw)
    } catch {
      throw new AwrError('invalid_output', `${bindingPath} is not valid JSON.`, { project })
    }
    if (typeof binding.cli !== 'string' || !isAbsolute(binding.cli)) {
      throw new AwrError('invalid_output', `${bindingPath} has no absolute "cli" path.`, { project })
    }
    if (!(await isExecutable(binding.cli))) {
      throw new AwrError('missing', `The pinned cli ${binding.cli} does not exist or is not executable.`, { project, cli: binding.cli })
    }
    if (binding.cli_sha256 && (await sha256Of(binding.cli)) !== String(binding.cli_sha256).replace(/^sha256:/, '')) {
      throw new AwrError('binary_changed', `${binding.cli} no longer matches the hash pinned in .awr/runtime-binding.json.`, { project, cli: binding.cli })
    }
    return { cli: binding.cli, source: 'binding', binding }
  }

  async function preflight(project) {
    const found = await locate(project)
    let report
    try {
      report = await exec(found.cli, project, ['runtime', 'binding'], timeoutMs)
    } catch (error) {
      // A project that is not initialized yet has no binding report; the binary is still usable
      // (the takeover runs `init` there). Anything that stops the plugin still propagates.
      if (!(error instanceof AwrError) || error.stops || found.binding) throw error
      return { ...found, report: undefined, uninitialized: true }
    }
    const pinned = found.binding
    const version = report?.program?.version
    if (pinned?.program_version && version && version !== pinned.program_version) {
      throw new AwrError('version_mismatch', `The project is pinned to awr ${pinned.program_version} but ${found.cli} is ${version}.`, { project, cli: found.cli })
    }
    if (pinned?.schema_version !== undefined && report?.schema_version !== undefined && report.schema_version !== pinned.schema_version) {
      throw new AwrError('schema_mismatch', `The project is pinned to schema ${pinned.schema_version} but awr reports schema ${report.schema_version}.`, { project, cli: found.cli })
    }
    return { ...found, report }
  }

  function stop(project, error) {
    if (error instanceof AwrError && error.stops) stopped.set(project, error)
    return error
  }

  return {
    /** Resolve and check the runtime for a project. Returns `{ cli, source, report }`. */
    async resolve(projectRoot) {
      const project = resolve(projectRoot)
      if (stopped.has(project)) throw stopped.get(project)
      if (!resolved.has(project)) resolved.set(project, preflight(project))
      try {
        return await resolved.get(project)
      } catch (error) {
        resolved.delete(project)
        throw stop(project, error)
      }
    },

    /**
     * Run `awr --project <root> --json <args...>` and return the parsed JSON.
     * @param {string} projectRoot
     * @param {string[]} args the command and its arguments, for example `['status']`
     * @param {{ timeoutMs?: number }} [options]
     */
    async run(projectRoot, args, options = {}) {
      const project = resolve(projectRoot)
      // Only the command words are checked, so a title or reason that contains "restore" is fine.
      const refused = args.slice(0, 2).find((word) => FORBIDDEN.has(String(word)))
      if (refused !== undefined) {
        throw new AwrError('forbidden_command', `"${refused}" is not run by the plugin.`, { project })
      }
      const found = await this.resolve(project)
      try {
        return await exec(found.cli, project, args, options.timeoutMs ?? timeoutMs)
      } catch (error) {
        throw stop(project, error)
      }
    },

    /** The error that stopped this project, if any. */
    stoppedError(projectRoot) {
      return stopped.get(resolve(projectRoot))
    },
  }
}
