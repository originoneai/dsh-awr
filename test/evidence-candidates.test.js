// Evidence candidates from tool results (DSH-050): which commands and results count, what is shown, and that the
// plugin registers nothing itself.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EVIDENCE_CONTEXT_NAME,
  EVIDENCE_CONTEXT_ORDER,
  MAX_KEPT,
  MAX_SHOWN,
  classifyCommand,
  createEvidenceCandidates,
  readBashResult,
  readCommitLine,
  registerEvidenceSuggestions,
  renderSuggestion,
  splitCommand,
  summarizeTestOutput,
} from '../lib/evidence-candidates.js'
import { redact } from '../lib/redact.js'

const kinds = (command) => classifyCommand(command).map((found) => found.kind + (found.runner ? `:${found.runner}` : ''))

// --- which commands count -----------------------------------------------------------------------------------------

test('test runners of the common ecosystems are recognised, with their wrappers and options', () => {
  const runs = [
    'npm test', 'npm t', 'npm run test', 'npm run test:unit -- --coverage', 'pnpm test', 'pnpm -r test', 'pnpm --filter app test', 'pnpm run test:e2e',
    'yarn test', 'yarn workspace app test', 'bun test', 'node --test', 'node --test test/ --test-reporter=spec', 'npx jest', 'npx vitest run', 'pnpm exec vitest run',
    'pnpm dlx mocha', 'jest --ci', 'mocha', 'pytest -q', 'py.test', 'python -m pytest', 'python3 -m unittest discover', 'cargo test', 'cargo +nightly test --all', 'cargo nextest run',
    'go test ./...', 'make test', 'make -C sub check', 'mvn test', './mvnw verify', './gradlew test', 'gradle check', 'swift test', 'dotnet test', 'deno test',
    'bundle exec rspec', 'rake test', 'phpunit', 'ctest', 'tox', 'CI=1 npm test', 'time npm test', 'env FOO=1 pytest', 'timeout 60 npm test', 'nice -n 5 pytest',
    'cd app && npm test', 'npm test 2>&1', 'npm test > out.txt', 'npm test && echo done',
  ]
  for (const command of runs) assert.equal(classifyCommand(command).filter((found) => found.kind === 'test_run').length, 1, command)
})

test('things that only look like test runs are not', () => {
  const not = [
    'npm install', 'npm install test', 'npm run build', 'npm run lint', 'pnpm add test', 'yarn add jest', 'ls test', 'cat test.js', 'echo npm test', "echo 'npm test && x'",
    'git status', 'git log', 'node script.js', 'node --version', 'make build', 'cargo build', 'cargo check', 'go build ./...', 'go vet ./...', 'pip install pytest', 'vitest', 'playwright install',
    'grep -r pytest .', 'pnpm install', 'mvn package', 'gradle build', 'ctest --help', '',
  ]
  // ctest --help is a runner invocation but not a run; the ones that are recognised on name alone are accepted here
  for (const command of not.filter((c) => c !== 'ctest --help')) assert.deepEqual(classifyCommand(command), [], command)
})

test('git commit counts, with its global options; other git commands and a dry run do not', () => {
  for (const command of ['git commit -m "x"', 'git commit -am y', 'git -C repo commit -m x', 'git -c user.name=a commit -m x', 'git --no-pager commit --amend --no-edit', 'git add -A && git commit -m x']) {
    assert.deepEqual(kinds(command), ['commit'], command)
  }
  for (const command of ['git commit --dry-run', 'git commit --help', 'git add .', 'git push', 'git log --oneline', 'git commit-tree HEAD^{tree}', 'git stash commit']) assert.deepEqual(kinds(command), [], command)
})

test('both a test run and a commit in one command are found, in order', () => {
  assert.deepEqual(kinds('npm test && git commit -m x'), ['test_run:npm test', 'commit'])
  assert.deepEqual(kinds('git commit -m x && node --test'), ['commit', 'test_run:node --test'])
})

test('a runner whose exit status is not its own is not read as a pass', () => {
  for (const command of ['npm test | tail', 'npm test 2>&1 | tee log.txt', 'npm test || true', 'npm test; echo done', 'npm test &', 'echo a && npm test | tail -3', 'npm test || echo failed', '(npm test)', '$(npm test)', 'echo `npm test`', "bash -c 'npm test'"]) {
    assert.deepEqual(classifyCommand(command), [], command)
  }
  // but everything before a `&&` chain's last command is settled by an overall exit of 0
  assert.deepEqual(kinds('npm test && echo ok'), ['test_run:npm test'])
  assert.deepEqual(kinds('npm test && npm run build | tail'), [], 'the pipe belongs to the last command, and the runner before it then does not settle the exit')
  assert.deepEqual(kinds('echo x; npm test'), ['test_run:npm test'], 'the last command of a `;` list gives the exit status')
})

test('splitting is quote-aware and leaves subshells alone', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e & f'), [{ text: 'a', sep: '&&' }, { text: 'b', sep: '||' }, { text: 'c', sep: ';' }, { text: 'd', sep: '|' }, { text: 'e', sep: '&' }, { text: 'f', sep: '' }])
  assert.deepEqual(splitCommand('echo "a && b" \'c | d\''), [{ text: 'echo "a && b" \'c | d\'', sep: '' }])
  assert.deepEqual(splitCommand('npm test 2>&1'), [{ text: 'npm test 2>&1', sep: '' }])
  assert.deepEqual(splitCommand('echo $(date)'), [])
  assert.deepEqual(splitCommand('a\nb'), [{ text: 'a', sep: ';' }, { text: 'b', sep: '' }])
  assert.deepEqual(classifyCommand(undefined), [])
})

// --- what a result says -------------------------------------------------------------------------------------------

const text = (body) => ({ content: [{ type: 'text', text: body }] })

test('a finished foreground run is read for its exit code, from the value or from the marker', () => {
  assert.deepEqual(readBashResult({ ...text('ok'), value: { exitCode: 0, signal: null, timedOut: false, aborted: false } }), { finished: true, exitCode: 0, text: 'ok' })
  assert.equal(readBashResult({ ...text('x'), value: { exitCode: 3, signal: null } }).exitCode, 3)
  assert.equal(readBashResult(text('out\n[exit code: 2]')).exitCode, 2)
  assert.equal(readBashResult(text('all good\n')).exitCode, 0, 'DSH prints no marker for 0')
  assert.equal(readBashResult(text('(no output)')).exitCode, 0)
})

test('a run that did not finish, was cut short or never started is not a result', () => {
  for (const result of [
    { ...text('x'), value: { exitCode: 0, timedOut: true } }, { ...text('x'), value: { exitCode: null, signal: 'SIGKILL' } }, { ...text('x'), value: { exitCode: 0, aborted: true } },
    { ...text('started'), value: { kind: 'background', jobId: 'j1' } }, { ...text('x'), value: { kind: 'promoted', jobId: 'j1' } }, { ...text('Error: spawn failed'), isError: true },
    text('partial\n[timed out after 5000ms]'), text('partial\n[killed by signal: SIGTERM]'), text('partial\n[stopped: user]'), text('so far\n[still running after 10000ms; moved to background job j2]'),
    undefined, null,
  ]) assert.deepEqual(readBashResult(result), { finished: false }, JSON.stringify(result))
})

test('a summary line is taken from the output of known runners only', () => {
  assert.equal(summarizeTestOutput('# tests 199\nℹ tests 199\nℹ pass 199\nℹ fail 0\n'), 'pass 199, fail 0')
  assert.equal(summarizeTestOutput('Test Suites: 2 passed, 2 total\nTests:       14 passed, 14 total\nTime: 1s'), 'Tests:       14 passed, 14 total')
  assert.equal(summarizeTestOutput('..\n===== 5 passed, 1 skipped in 0.12s ====='), '5 passed, 1 skipped in 0.12s')
  assert.equal(summarizeTestOutput('running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored'), 'test result: ok. 3 passed; 0 failed; 0 ignored')
  assert.equal(summarizeTestOutput('ok  \tpkg/a\t0.1s\nok  \tpkg/b\t0.2s\n'), '2 package(s) ok')
  assert.equal(summarizeTestOutput('ok  \tpkg/a\t0.1s\nFAIL\tpkg/b\n'), undefined)
  assert.equal(summarizeTestOutput('..\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK\n'), 'Ran 2 tests in 0.001s, OK')
  assert.equal(summarizeTestOutput('Ran 2 tests in 0.001s\n\nFAILED (failures=1)'), 'Ran 2 tests in 0.001s, FAILED (failures=1)')
  assert.equal(summarizeTestOutput('something unrecognised'), undefined)
})

test('the commit line gives the short hash and the branch', () => {
  assert.deepEqual(readCommitLine('[main 1a2b3c4] Fix the thing\n 1 file changed'), { branch: 'main', sha: '1a2b3c4' })
  assert.deepEqual(readCommitLine('[main (root-commit) abcdef0] init'), { branch: 'main', sha: 'abcdef0' })
  assert.deepEqual(readCommitLine('[detached HEAD 1234567] x'), { branch: 'detached HEAD', sha: '1234567' })
  assert.equal(readCommitLine('nothing to commit'), undefined)
})

// --- the candidates of a conversation -----------------------------------------------------------------------------

const bound = () => ({ get: async () => ({ sessionId: 'S1', outcome: 'created' }) })
const flush = () => new Promise((resolve) => setImmediate(resolve))
const bash = (command, body = 'ok', id = 'conv-1') => ({ exec: { name: 'bash', agent: { session: { id } }, arguments: { command } }, result: text(body) })
const awrCall = (args, isError = false, id = 'conv-1') => ({ exec: { name: 'awr', agent: { session: { id } }, arguments: { args } }, result: { ...text('{}'), ...(isError ? { isError: true } : {}) } })
const feed = (candidates, ...calls) => calls.forEach(({ exec, result }) => candidates.observe(exec, result))

test('a clean test run and a commit become candidates, and the prompt block says nothing was registered', async () => {
  const c = createEvidenceCandidates({ bindings: bound() }, { now: () => Date.parse('2026-11-12T10:00:00Z') })
  feed(c, bash('node --test', 'ℹ tests 199\nℹ pass 199\nℹ fail 0\n'), bash('git commit -m "Fix it"', '[main 2333d57] Fix it\n 1 file changed'))
  await flush()
  assert.deepEqual(c.list('conv-1').map((x) => [x.kind, x.runner, x.summary, x.sha, x.branch]), [['test_run', 'node --test', 'pass 199, fail 0', undefined, undefined], ['commit', undefined, undefined, '2333d57', 'main']])
  const block = c.text('conv-1')
  assert.match(block, /^# AWR evidence candidates \(not registered\)/)
  assert.match(block, /registered nothing: a candidate is a lead, not evidence/)
  assert.match(block, /- test run \(node --test\), exit 0: pass 199, fail 0 — `node --test`/)
  assert.match(block, /- commit, exit 0: 2333d57 on main — `git commit -m "Fix it"`/)
  assert.match(block, /work prepare-completion.*evidence add.*work complete/s)
  assert.match(block, /git rev-parse HEAD/)
  assert.match(block, /not evidence/)
})

test('a failed, unfinished or masked run is not a candidate, and neither is a command that is not a run', async () => {
  const c = createEvidenceCandidates({ bindings: bound() })
  const traces = []
  const traced = createEvidenceCandidates({ bindings: bound() }, { trace: (e) => traces.push(e) })
  for (const target of [c, traced]) {
    feed(target, bash('npm test', 'not ok 1\n[exit code: 1]'), bash('npm test | tail', 'ok'), bash('npm test', 'x\n[timed out after 1000ms]'), bash('ls', 'a'), bash('git commit -m x', 'error\n[exit code: 1]'))
    target.observe({ name: 'bash', agent: { session: { id: 'conv-1' } }, arguments: { command: 'npm test' } }, { ...text('started'), value: { kind: 'background', jobId: 'j' } })
  }
  await flush()
  assert.deepEqual(c.list('conv-1'), [])
  assert.equal(c.text('conv-1'), '')
  assert.deepEqual(traces.filter((e) => e.event === 'evidence-candidate-skipped').map((e) => e.reason), ['exit 1', 'not finished', 'exit 1', 'not finished'], 'in the order seen; the piped run was never classified')
})

test('only a conversation bound to AWR gets the block, and other tools or other conversations add nothing to it', async () => {
  const unbound = createEvidenceCandidates({ bindings: { get: async () => undefined } })
  feed(unbound, bash('npm test'))
  await flush()
  assert.equal(unbound.text('conv-1'), '')
  const failed = createEvidenceCandidates({ bindings: { get: async () => ({ sessionId: 'S1', outcome: 'failed' }) } })
  feed(failed, bash('npm test'))
  await flush()
  assert.equal(failed.text('conv-1'), '')
  const c = createEvidenceCandidates({ bindings: bound() })
  feed(c, bash('npm test', 'ok', 'conv-1'))
  c.observe({ name: 'read', agent: { session: { id: 'conv-1' } }, arguments: { command: 'npm test' } }, text('x'))
  c.observe({ name: 'bash', arguments: { command: 'npm test' } }, text('x'))
  c.observe(undefined, undefined)
  await flush()
  assert.equal(c.list('conv-1').length, 1)
  assert.equal(c.text('conv-2'), '')
  assert.equal(c.text(undefined), '')
})

test('registering evidence or completing work through the awr tool settles what was suggested, a failed attempt or other awr command does not', async () => {
  const c = createEvidenceCandidates({ bindings: bound() })
  feed(c, bash('npm test'), awrCall(['evidence', 'add', '--input', 'e.json'], true), awrCall(['status']), awrCall(['work', 'show', 'W-1']))
  await flush()
  assert.equal(c.list('conv-1').length, 1, 'still pending')
  feed(c, awrCall(['evidence', 'add', '--input', 'e.json']))
  assert.deepEqual(c.list('conv-1'), [])
  assert.equal(c.text('conv-1'), '')
  feed(c, bash('git commit -m x', '[main aaaaaaa] x'), bash('pytest'))
  assert.equal(c.list('conv-1').length, 2, 'later ones are suggested again, and only they')
  feed(c, awrCall(['work', 'complete', 'W-1', '--session', 'S1']))
  assert.deepEqual(c.list('conv-1'), [])
})

test('the user can dismiss the list, and sees it with the command text', async () => {
  const c = createEvidenceCandidates({ bindings: bound() })
  assert.match(c.describe('conv-1'), /^No evidence candidates/)
  assert.equal(c.dismiss('conv-1'), 0)
  feed(c, bash('pytest -q', '5 passed in 0.1s'), bash('git commit -m x', '[main bbbbbbb] x'))
  await flush()
  const shown = c.describe('conv-1')
  assert.match(shown, /^2 evidence candidate\(s\), all with exit 0\. Nothing was registered/)
  assert.match(shown, /1\. \d\d:\d\d:\d\d test run \(pytest\) 5 passed in 0\.1s: pytest -q/)
  assert.match(shown, /2\. \d\d:\d\d:\d\d commit bbbbbbb on main: git commit -m x/)
  assert.match(shown, /\/awr evidence dismiss/)
  assert.equal(c.dismiss('conv-1'), 2)
  assert.deepEqual(c.list('conv-1'), [])
  c.forget('conv-1')
  assert.equal(c.dismiss('conv-1'), 0)
})

test('the list is bounded, the prompt shows the newest few, and a long command is shortened', async () => {
  const c = createEvidenceCandidates({ bindings: bound() })
  for (let i = 0; i < MAX_KEPT + 5; i++) feed(c, bash(`pytest tests/t${i}.py`))
  feed(c, bash(`pytest ${'x'.repeat(400)}`))
  await flush()
  assert.equal(c.list('conv-1').length, MAX_KEPT)
  const shown = c.text('conv-1').split('\n').filter((line) => line.startsWith('- '))
  assert.equal(shown.length, MAX_SHOWN)
  assert.match(shown.at(-1), /…`$/)
  assert.ok(shown.at(-1).length < 300)
  assert.equal(renderSuggestion([]), '')
})

test('what looks like a credential is not copied into the block or the command text', async () => {
  const c = createEvidenceCandidates({ bindings: bound() })
  feed(c, bash('API_TOKEN=abc123def456 npm test --password hunter2 --api-key=k-999 -- --url https://user:pw@host/x'))
  await flush()
  const both = `${c.text('conv-1')}\n${c.describe('conv-1')}`
  for (const secret of ['abc123def456', 'hunter2', 'k-999', 'user:pw@']) assert.ok(!both.includes(secret), `${secret} leaked`)
  assert.match(both, /API_TOKEN=\*\*\*/)
  assert.equal(redact('curl -H "Authorization: Bearer abcdefgh12345678" x'), 'curl -H "Authorization: Bearer ***" x')
  assert.equal(redact('echo ghp_abcdefghijklmnop1234 sk-abcdefghijklmnop12'), 'echo *** ***')
  assert.equal(redact('curl -H "Authorization: Basic dXNlcjpwYXNz" x'), 'curl -H "Authorization: Basic ***" x')
  assert.equal(redact('npm test'), 'npm test')
  assert.equal(redact(undefined), '')
})

test('the module cannot write to AWR: it has no runner and calls none', () => {
  const source = readFileSync(new URL('../lib/evidence-candidates.js', import.meta.url), 'utf8')
  assert.ok(!/awr-runtime|\bawr\.run\b|createAwr|execFile|spawn\(/.test(source.replace(/\/\/.*$/gm, '')), 'no import of the runner and no process is started')
  assert.equal(createEvidenceCandidates.length, 1, 'its only dependency is the binding lookup')
})

// --- the registration ---------------------------------------------------------------------------------------------

function fakeCtx({ withPrompt = true } = {}) {
  const handlers = {}
  const contexts = []
  const ctx = {
    handlers,
    contexts,
    on: (event, handler) => {
      handlers[event] = handler
      return () => {}
    },
    logger: { warn: () => {} },
  }
  if (withPrompt) ctx.systemPrompt = { context: (definition) => contexts.push(definition) }
  return ctx
}

test('registered on tools/result and the system prompt: the block follows the AWR context and may be trimmed', async () => {
  const ctx = fakeCtx()
  const c = registerEvidenceSuggestions(ctx, { bindings: bound() })
  assert.deepEqual(Object.keys(ctx.handlers).sort(), ['agent/disposed', 'tools/result'])
  assert.equal(ctx.contexts.length, 1)
  const [definition] = ctx.contexts
  assert.deepEqual([definition.name, definition.order, definition.required, definition.interpolate], [EVIDENCE_CONTEXT_NAME, EVIDENCE_CONTEXT_ORDER, false, false])
  assert.ok(EVIDENCE_CONTEXT_ORDER > 400, 'after the AWR work context')
  const call = bash('cargo test', 'test result: ok. 4 passed; 0 failed')
  ctx.handlers['tools/result'](call.exec, call.result)
  await flush()
  assert.match(definition.text({ agent: { session: { id: 'conv-1' } } }), /test run \(cargo test\), exit 0: test result: ok\. 4 passed/)
  assert.equal(definition.text({ agent: { session: { id: 'other' } } }), '')
  assert.equal(definition.text(undefined), '')
  ctx.handlers['agent/disposed']({ agent: { session: { id: 'conv-1' } } })
  assert.equal(definition.text({ agent: { session: { id: 'conv-1' } } }), '')
  assert.equal(c.list('conv-1').length, 0)
})

test('without a system prompt service nothing is registered but listening is harmless, and disabled does nothing at all', () => {
  const ctx = fakeCtx({ withPrompt: false })
  assert.doesNotThrow(() => registerEvidenceSuggestions(ctx, { bindings: bound() }))
  const off = fakeCtx()
  assert.equal(registerEvidenceSuggestions(off, { bindings: bound(), enabled: false }), undefined)
  assert.deepEqual([Object.keys(off.handlers), off.contexts.length], [[], 0])
  // a service that arrives later is picked up through inject, and its effect is disposed with it
  const injected = fakeCtx({ withPrompt: false })
  let mounted
  injected.inject = (names, fn) => {
    mounted = { names, fn }
  }
  registerEvidenceSuggestions(injected, { bindings: bound() })
  assert.deepEqual(mounted.names, ['systemPrompt'])
  const registered = []
  mounted.fn({ systemPrompt: { context: (d) => registered.push(d.name) }, effect: (fn) => fn() })
  assert.deepEqual(registered, [EVIDENCE_CONTEXT_NAME])
})

test('a throwing binding lookup or a malformed call never reaches the conversation', async () => {
  const warnings = []
  const c = createEvidenceCandidates({ bindings: { get: () => { throw new Error('boom') } } }, { warn: (m) => warnings.push(m) })
  assert.doesNotThrow(() => feed(c, bash('npm test')))
  await flush()
  assert.equal(c.text('conv-1'), '')
  const weird = createEvidenceCandidates({ bindings: bound() }, { warn: (m) => warnings.push(m) })
  assert.doesNotThrow(() => weird.observe({ name: 'bash', agent: { session: { id: 'x' } }, arguments: null }, { content: 'not an array' }))
  assert.doesNotThrow(() => weird.observe({ name: 'awr', agent: { session: { id: 'x' } }, arguments: { args: 'nope' } }, {}))
})
