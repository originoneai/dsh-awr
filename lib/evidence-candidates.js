// Suggests evidence to register, from what the conversation's own tool calls showed (DSH-050).
//
// A conversation that runs the tests or makes a commit has produced the raw material of AWR evidence (AWR's
// `work complete` wants verified results registered against the acceptance criteria). This watches the results of the
// `bash` tool and keeps a short list of those that finished cleanly, so that the model is reminded of them in its prompt
// and the user can see them with `/awr evidence`. It is a suggestion and nothing more: this module has no awr runner
// and no way to write anything. Evidence is registered only by the model, with the `awr` tool, or by the user, because
// what a run proves (which criterion, with what limits) is a judgement made by whoever read the output.
//
// Which results count (docs/evidence-candidates.md):
//   - a command that ran a test suite (`npm test`, `node --test`, `pytest`, `cargo test`, `go test`, ...) and exited 0;
//   - a `git commit` that exited 0, with the commit's short hash when its output shows one.
// Only a finished foreground run counts. A command whose exit status does not belong to the runner is not read as a
// pass: a runner piped into something (`npm test | tail`), made harmless with `|| true`, followed by `;` or run in the
// background. A failed run is not a candidate: it is not evidence of a pass. The conversation must be bound to AWR.
import { redact } from './redact.js'

export const EVIDENCE_CONTEXT_NAME = 'awr:evidence-candidates'
/** After the AWR work context (400). */
export const EVIDENCE_CONTEXT_ORDER = 410
export const MAX_KEPT = 20
export const MAX_SHOWN = 5
const MAX_COMMAND_CHARS = 200
const MAX_SUMMARY_CHARS = 160

// --- reading a command line ---------------------------------------------------------------------------------------

/**
 * The simple commands of a command line, each with the separator that follows it (`&&`, `||`, `;`, `|`, `&`, or `''`
 * for the last). Quote-aware. A line with a subshell, a command substitution or a backtick is not taken apart (`[]`):
 * what runs inside is not something this reads.
 *
 * @param {string} line
 * @returns {Array<{ text: string, sep: string }>}
 */
export function splitCommand(line) {
  const parts = []
  let current = ''
  let quote = null
  const push = (sep) => {
    parts.push({ text: current.trim(), sep })
    current = ''
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      current += c
      if (c === '\\' && quote === '"') current += line[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\') {
      current += c + (line[++i] ?? '')
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if (c === '(' || c === ')' || c === '`') return []
    if (c === '&' && line[i + 1] === '&') {
      push('&&')
      i++
    } else if (c === '|' && line[i + 1] === '|') {
      push('||')
      i++
    } else if (c === '|') push('|')
    else if (c === ';' || c === '\n') push(';')
    else if (c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>') push('&')
    else current += c
  }
  push('')
  return parts.filter((part) => part.text)
}

/** The words of one simple command, quotes removed. */
function words(text) {
  const out = []
  let current = ''
  let quote = null
  let any = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') current += text[++i] ?? ''
      else current += c
    } else if (c === '"' || c === "'") {
      quote = c
      any = true
    } else if (c === '\\') {
      current += text[++i] ?? ''
      any = true
    } else if (/\s/.test(c)) {
      if (current || any) out.push(current)
      current = ''
      any = false
    } else {
      current += c
      any = true
    }
  }
  if (current || any) out.push(current)
  return out
}

const base = (program) => String(program ?? '').split('/').pop()
const flagLike = (word) => word.startsWith('-') || word.startsWith('+')

/** Drops what only wraps a command: `FOO=1`, `env`, `time`, `nice`, `timeout 60`, `command`. */
function unwrap(tokens) {
  let t = [...tokens]
  for (let guard = 0; guard < 8 && t.length > 0; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1)
    else if (['env', 'time', 'command', 'nohup'].includes(base(t[0]))) t = t.slice(1)
    else if (base(t[0]) === 'nice') t = t.slice(1).filter((word, i, all) => !(i === 0 && word === '-n') && !(i === 1 && all[0] === '-n'))
    else if (base(t[0]) === 'timeout') {
      let rest = t.slice(1)
      while (rest.length > 0 && flagLike(rest[0])) rest = rest.slice(1)
      t = rest.slice(1) // the duration
    } else break
  }
  return t
}

const JS_RUNNERS = new Set(['jest', 'vitest', 'mocha', 'ava', 'tap', 'playwright', 'cypress'])
const TEST_TARGET = /^test(:[\w:.-]+)?$/
const NOT_A_RUN = new Set(['add', 'install', 'i', 'remove', 'rm', 'uninstall', 'info', 'why', 'view', 'link', 'init', 'update', 'upgrade', 'publish'])

/**
 * What a command, once its wrappers are gone, runs: `{ kind: 'test_run', runner }`, `{ kind: 'commit' }`, or nothing.
 *
 * @param {string[]} tokens
 */
export function recognize(tokens) {
  const t = unwrap(tokens)
  if (t.length === 0) return undefined
  const program = base(t[0])
  const args = t.slice(1)
  const plain = args.filter((arg) => !flagLike(arg))
  const test = (runner) => ({ kind: 'test_run', runner })

  if (program === 'git') {
    let i = 0
    while (i < args.length && flagLike(args[i])) {
      i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(args[i]) ? 2 : 1
    }
    const rest = args.slice(i)
    if (rest[0] === 'commit' && !rest.some((arg) => arg === '--dry-run' || arg === '-h' || arg === '--help')) return { kind: 'commit' }
    return undefined
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    const first = plain[0]
    if (first === 'test' || first === 't' || first === 'tst') return test(`${program} test`)
    if ((first === 'run' || first === 'run-script') && TEST_TARGET.test(plain[1] ?? '')) return test(`${program} run ${plain[1]}`)
    if (program !== 'npm' && program !== 'bun' && TEST_TARGET.test(first ?? '') && !NOT_A_RUN.has(first)) return test(`${program} ${first}`)
    // `pnpm --filter x test`, `yarn workspace x test`: the script name is the next word that looks like one
    if ((program === 'pnpm' || program === 'yarn') && !NOT_A_RUN.has(first ?? '') && plain.slice(1, 3).some((arg) => TEST_TARGET.test(arg))) return test(`${program} ${plain.find((arg) => TEST_TARGET.test(arg))}`)
    if (['exec', 'dlx', 'x'].includes(first) || program === 'bun') return recognize(plain.slice(first === 'x' || ['exec', 'dlx'].includes(first) ? 1 : 0))
    return undefined
  }
  if (program === 'npx' || program === 'bunx') return recognize(plain)
  if (program === 'node' || program === 'deno') {
    if (program === 'node' && args.includes('--test')) return test('node --test')
    if (program === 'deno' && plain[0] === 'test') return test('deno test')
    return undefined
  }
  if (JS_RUNNERS.has(program)) {
    if (program === 'playwright' || program === 'cypress') return plain[0] === 'test' || plain[0] === 'run' ? test(program) : undefined
    if (program === 'vitest' && plain[0] !== 'run' && !args.includes('--run')) return undefined // watch mode
    return test(program)
  }
  if (['pytest', 'py.test', 'phpunit', 'rspec', 'ctest', 'tox', 'nox'].includes(program)) return test(program)
  if (/^python(\d(\.\d+)?)?$/.test(program)) {
    const m = args.indexOf('-m')
    return m >= 0 && ['pytest', 'unittest', 'nose2'].includes(args[m + 1]) ? test(`python -m ${args[m + 1]}`) : undefined
  }
  if (program === 'cargo') {
    if (plain[0] === 'test' || plain[0] === 't') return test('cargo test')
    if (plain[0] === 'nextest' && plain[1] === 'run') return test('cargo nextest run')
    return undefined
  }
  if (program === 'go') return plain[0] === 'test' ? test('go test') : undefined
  if (program === 'swift' || program === 'dotnet') return plain[0] === 'test' ? test(`${program} test`) : undefined
  if (program === 'zig') return plain[0] === 'test' || (plain[0] === 'build' && plain[1] === 'test') ? test('zig test') : undefined
  if (program === 'make' || program === 'gmake') return plain.some((arg) => ['test', 'tests', 'check'].includes(arg)) ? test('make test') : undefined
  if (program === 'rake') return plain.some((arg) => ['test', 'spec'].includes(arg)) ? test('rake test') : undefined
  if (program === 'bundle' && plain[0] === 'exec') return recognize(plain.slice(1))
  if (['mvn', 'mvnw'].includes(program)) return plain.some((arg) => ['test', 'verify', 'integration-test'].includes(arg)) ? test('mvn test') : undefined
  if (['gradle', 'gradlew'].includes(program)) return plain.some((arg) => ['test', 'check'].includes(arg)) ? test('gradle test') : undefined
  return undefined
}

/**
 * The test runs and commits in a command line whose exit status is theirs: the command is read left to right, and a
 * simple command counts only when everything after it is joined with `&&`, so that an overall exit of 0 means it
 * succeeded (a runner followed by `;`, piped, made harmless with `||`, or run in the background does not count).
 *
 * @param {string} command
 * @returns {Array<{ kind: 'test_run' | 'commit', runner?: string }>}
 */
export function classifyCommand(command) {
  if (typeof command !== 'string') return []
  const parts = splitCommand(command)
  const found = []
  parts.forEach((part, index) => {
    const settled = parts.slice(index, -1).every((later) => later.sep === '&&') && parts[index].sep !== '&'
    if (!settled) return
    const what = recognize(words(part.text))
    if (what) found.push(what)
  })
  return found
}

// --- reading a result ---------------------------------------------------------------------------------------------

/**
 * Whether a `bash` result is a finished foreground run, and with what exit code. DSH reports a non-zero exit as a
 * `[exit code: N]` line after the output and gives no marker for 0; a run that timed out, was stopped or killed, moved
 * to a background job, or failed to start is not finished here.
 *
 * @returns {{ finished: false } | { finished: true, exitCode: number, text: string }}
 */
export function readBashResult(result) {
  if (!result || result.isError === true) return { finished: false }
  const value = result.value
  if (value?.kind === 'background' || value?.kind === 'promoted') return { finished: false }
  const text = (Array.isArray(result.content) ? result.content : []).filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
  if (value && typeof value === 'object' && 'exitCode' in value) {
    if (value.timedOut || value.aborted || value.signal) return { finished: false }
    if (Number.isInteger(value.exitCode)) return { finished: true, exitCode: value.exitCode, text }
  }
  if (/^\[(timed out|killed by signal|stopped)[^\]]*\]\s*$/m.test(text) || /^\[still running after/m.test(text)) return { finished: false }
  const marker = text.match(/^\[exit code: (-?\d+)\]\s*$/m)
  return { finished: true, exitCode: marker ? Number(marker[1]) : 0, text }
}

/** One line of what a test run printed about itself, when it is a known format. Best effort and never a verdict. */
export function summarizeTestOutput(text) {
  const pick = (re) => text.match(re)
  const node = [pick(/^ℹ pass (\d+)/m), pick(/^ℹ fail (\d+)/m)]
  if (node[0] && node[1]) return `pass ${node[0][1]}, fail ${node[1][1]}`
  const unittest = [pick(/^Ran \d+ tests? in [\d.]+s/m), pick(/^(OK|FAILED)\b.*$/m)]
  if (unittest[0] && unittest[1]) return `${unittest[0][0]}, ${unittest[1][0]}`.slice(0, MAX_SUMMARY_CHARS)
  const line = pick(/^\s*Tests:\s+.+$/m) ?? pick(/^\s*Tests\s{2,}.+$/m) ?? pick(/^=+ .*\b(?:passed|failed)\b.* =+$/m) ?? pick(/^\d+ passed.*$/m)
  if (line) return line[0].replace(/^[\s=]+|[\s=]+$/g, '').slice(0, MAX_SUMMARY_CHARS)
  const cargo = text.match(/^test result: .+$/gm)
  if (cargo) return cargo.at(-1).slice(0, MAX_SUMMARY_CHARS)
  const goOk = text.match(/^ok\s+\S+/gm)
  if (goOk && !/^FAIL/m.test(text)) return `${goOk.length} package(s) ok`
  return undefined
}

const summaryOf = (text) => {
  const summary = summarizeTestOutput(text)
  return summary ? { summary } : undefined
}

/** The short hash and branch in the line `git commit` prints, `[main 1a2b3c4] subject`. */
export function readCommitLine(text) {
  const m = text.match(/^\[(.+?)(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m)
  return m ? { branch: m[1], sha: m[2] } : undefined
}

// --- the candidates of a conversation ------------------------------------------------------------------------------

/** The prompt block, or an empty string when there is nothing to suggest. */
export function renderSuggestion(candidates) {
  if (candidates.length === 0) return ''
  const lines = candidates.map((c) => {
    if (c.kind === 'commit') return `- commit, exit 0${c.sha ? `: ${c.sha}${c.branch ? ` on ${c.branch}` : ''}` : ''} — \`${c.command}\``
    return `- test run (${c.runner}), exit 0${c.summary ? `: ${c.summary}` : ''} — \`${c.command}\``
  })
  return [
    '# AWR evidence candidates (not registered)',
    'These finished cleanly in this conversation. The plugin registered nothing: a candidate is a lead, not evidence.',
    ...lines,
    'If one of them verifies an acceptance criterion of the work you are on, write the completion report from what it showed (what ran, what you saw, what it did not cover; the full commit from `git rev-parse HEAD` as source_sha), then register it as the awr-workflow skill describes (`work prepare-completion`, `evidence add`, `work complete`). A run you did not read, or one that did not cover a criterion, is not evidence. This note goes away once evidence is registered; do not mention it to the user unless it matters.',
  ].join('\n')
}

/**
 * @param {{ bindings: { get(conversationId: string): Promise<object> | undefined } }} dependencies
 * @param {{ now?: () => number, trace?: Function, warn?: Function }} [options]
 */
export function createEvidenceCandidates({ bindings }, { now = Date.now, trace, warn } = {}) {
  /** @type {Map<string, { seq: number, handled: number, kept: object[], bound: boolean }>} */
  const states = new Map()
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { seq: 0, handled: 0, kept: [], bound: false })
    return states.get(id)
  }
  const pending = (state) => state.kept.filter((candidate) => candidate.seq > state.handled)

  /** `bindings.get` is asynchronous and the prompt text is not: the answer is kept for the next step. */
  function refreshBound(id, state) {
    Promise.resolve(bindings.get(id))
      .then((binding) => {
        state.bound = Boolean(binding?.sessionId) && binding.outcome !== 'failed'
      })
      .catch(() => {
        state.bound = false
      })
  }

  return {
    /** `tools/result`. Never throws. */
    observe(exec, result) {
      try {
        const id = exec?.agent?.session?.id
        if (typeof id !== 'string') return
        const state = stateOf(id)
        refreshBound(id, state)
        if (exec.name === 'awr') {
          const args = exec.arguments?.args
          // Evidence registered, or the work completed: what was suggested has been dealt with.
          if (Array.isArray(args) && ((args[0] === 'evidence' && args[1] === 'add') || (args[0] === 'work' && args[1] === 'complete')) && result?.isError !== true) {
            state.handled = state.seq
            trace?.({ event: 'evidence-candidates-handled', conversationId: id, command: args.slice(0, 2).join(' ') })
          }
          return
        }
        if (exec.name !== 'bash') return
        const command = exec.arguments?.command
        const kinds = classifyCommand(command)
        if (kinds.length === 0) return
        const read = readBashResult(result)
        if (!read.finished || read.exitCode !== 0) {
          // What the host passed, for diagnosing a result of another shape than the documented one.
          const value = result?.value
          trace?.({ event: 'evidence-candidate-skipped', conversationId: id, reason: read.finished ? `exit ${read.exitCode}` : 'not finished', result: result && typeof result === 'object' ? Object.keys(result) : typeof result, value: value && typeof value === 'object' ? { kind: value.kind, exitCode: value.exitCode, keys: Object.keys(value).slice(0, 12) } : typeof value, isError: result?.isError })
          return
        }
        const shown = redact(command).replace(/\s+/g, ' ').trim()
        for (const kind of kinds) {
          const candidate = {
            seq: ++state.seq,
            kind: kind.kind,
            ...(kind.runner ? { runner: kind.runner } : {}),
            command: shown.length > MAX_COMMAND_CHARS ? `${shown.slice(0, MAX_COMMAND_CHARS - 1)}…` : shown,
            exitCode: 0,
            at: now(),
            ...((kind.kind === 'commit' ? readCommitLine(read.text) : summaryOf(read.text)) ?? {}),
          }
          state.kept.push(candidate)
          trace?.({ event: 'evidence-candidate', conversationId: id, kind: candidate.kind, runner: candidate.runner, sha: candidate.sha, summary: candidate.summary })
        }
        if (state.kept.length > MAX_KEPT) state.kept.splice(0, state.kept.length - MAX_KEPT)
      } catch (error) {
        warn?.(`An evidence candidate was skipped: ${error?.message ?? error}`)
      }
    },

    /** The candidates not yet dealt with, oldest first. */
    list(id) {
      const state = states.get(id)
      return state ? pending(state).map(({ seq, ...rest }) => rest) : []
    },

    /** The prompt block for a conversation: empty unless it is bound to AWR and has candidates. */
    text(id) {
      const state = typeof id === 'string' ? states.get(id) : undefined
      if (!state?.bound) return ''
      return renderSuggestion(pending(state).slice(-MAX_SHOWN))
    },

    /** Forget the candidates so far (the user decided none of them matters). Returns how many. */
    dismiss(id) {
      const state = states.get(id)
      if (!state) return 0
      const count = pending(state).length
      state.handled = state.seq
      return count
    },

    /** The candidates, for the user (`/awr evidence`). */
    describe(id) {
      const state = states.get(id)
      const list = state ? pending(state) : []
      if (list.length === 0) return 'No evidence candidates: nothing that looks like a finished test run or commit has been seen in this conversation since evidence was last registered.'
      const lines = list.slice(-MAX_KEPT).map((c, i) => {
        const when = new Date(c.at).toISOString().slice(11, 19)
        return c.kind === 'commit'
          ? `${i + 1}. ${when} commit${c.sha ? ` ${c.sha}${c.branch ? ` on ${c.branch}` : ''}` : ''}: ${c.command}`
          : `${i + 1}. ${when} test run (${c.runner})${c.summary ? ` ${c.summary}` : ''}: ${c.command}`
      })
      return [
        `${list.length} evidence candidate(s), all with exit 0. Nothing was registered: the model or you register evidence (work prepare-completion, evidence add).`,
        ...lines,
        '/awr evidence dismiss clears this list.',
      ].join('\n')
    },

    forget: (id) => states.delete(id),
  }
}

/**
 * Listen to `tools/result` and add the suggestion to the system prompt (`ctx.systemPrompt.context`).
 *
 * @param {{ on: Function, inject?: Function, effect?: Function, systemPrompt?: any, logger?: any }} ctx
 * @param {{ bindings: object, enabled?: boolean, trace?: Function }} dependencies
 */
export function registerEvidenceSuggestions(ctx, { bindings, enabled = true, trace }) {
  if (!enabled) return undefined
  const warn = (message) => ctx.logger?.warn?.(message)
  const candidates = createEvidenceCandidates({ bindings }, { trace, warn })
  ctx.on('tools/result', (exec, result) => candidates.observe(exec, result))
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.session?.id ?? payload?.session?.id
    if (typeof id === 'string') candidates.forget(id)
  })
  const definition = {
    name: EVIDENCE_CONTEXT_NAME,
    order: EVIDENCE_CONTEXT_ORDER,
    // Quoted commands may contain `{{...}}`, which DSH would otherwise try to resolve as a variable.
    interpolate: false,
    // Advice, not something every step must carry: it may be left out when DSH trims optional context.
    required: false,
    text: (call) => candidates.text(call?.agent?.session?.id),
  }
  const mount = (scope) => {
    const register = () => scope.systemPrompt.context(definition)
    return typeof scope.effect === 'function' ? scope.effect(register) : register()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], mount)
  else if (ctx.systemPrompt?.context) mount(ctx)
  return candidates
}
