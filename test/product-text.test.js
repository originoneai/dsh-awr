// What the commands say first (DSH-060): a line a person understands, in the language of the interface; the technical
// details come after it, where the conversation folds them away.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AwrError } from '../lib/awr-runtime.js'
import { createAwrCommand, splitUi } from '../lib/commands.js'
import { createProgress, progressFileName } from '../lib/progress.js'

const agent = { session: { id: 'conv-1' } }
const bound = { projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } }
const bindings = { get: async () => bound }
function scripted(handlers) {
  const calls = []
  return { calls, async run(_root, args) { calls.push(args); const handler = handlers[args[0]] ?? handlers[args.slice(0, 2).join(' ')]; if (!handler) throw new Error(`unexpected: ${args.join(' ')}`); return handler(args) } }
}
const status = { project_id: 'P1', project_revision: 11, current: [{ key: 'A' }, { key: 'B' }], ready: [{ key: 'C' }], blocked: [] }
const first = (result) => result.text.split('\n')[0]

test('the --ui flag is taken off the command line, wherever it stands', () => {
  assert.deepEqual(splitUi('claim --ui zh'), { rawInput: 'claim', ui: { language: 'zh', fromPanel: true } })
  assert.deepEqual(splitUi('claim W-1 --ui en'), { rawInput: 'claim W-1', ui: { language: 'en', fromPanel: true } })
  assert.deepEqual(splitUi('--ui zh status'), { rawInput: 'status', ui: { language: 'zh', fromPanel: true } })
  assert.deepEqual(splitUi('checkpoint did :: next --ui zh'), { rawInput: 'checkpoint did :: next', ui: { language: 'zh', fromPanel: true } })
  assert.deepEqual(splitUi('status'), { rawInput: 'status', ui: { language: 'en', fromPanel: false } })
  assert.deepEqual(splitUi('claim --ui'), { rawInput: 'claim', ui: { language: 'en', fromPanel: true } })
  assert.equal(splitUi('checkpoint a --uikit :: b').rawInput, 'checkpoint a --uikit :: b', 'only the whole word is the flag')
})

test('status starts with how the project stands, then the details', async () => {
  const awr = scripted({ status: () => status })
  const command = createAwrCommand({ awr, bindings })
  const en = await command({ agent, rawInput: 'status' })
  assert.equal(first(en), '2 in progress, 1 ready, 0 blocked')
  assert.match(en.text, /revision 11/, 'the details follow')
  assert.equal(first(await command({ agent, rawInput: 'status --ui zh' })), '2 项进行中，1 项可开始，0 项受阻')
})

test('the counts in the first line are those AWR reports for the whole queue, not the length of the sample it listed', async () => {
  const sampled = { ...status, current: Array.from({ length: 5 }, (_, i) => ({ key: `A${i}` })), ready: Array.from({ length: 5 }, (_, i) => ({ key: `R${i}` })), blocked: Array.from({ length: 5 }, (_, i) => ({ key: `B${i}` })), current_total: 24, ready_count: 23, blocked_count: 39 }
  const command = createAwrCommand({ awr: scripted({ status: () => sampled }), bindings })
  assert.equal(first(await command({ agent, rawInput: 'status' })), '24 in progress, 23 ready, 39 blocked')
  assert.equal(first(await command({ agent, rawInput: 'status --ui zh' })), '24 项进行中，23 项可开始，39 项受阻')
})

test('a claim names the work by its title; the key and the revision are in the details', async () => {
  const awr = scripted({ status: () => status, 'work claim': () => ({ project_revision: 12 }), 'work show': () => ({ work: { title: 'Search endpoint' } }) })
  const command = createAwrCommand({ awr, bindings })
  const zh = await command({ agent, rawInput: 'claim --ui zh' })
  assert.equal(first(zh), '已认领「Search endpoint」，这个会话开始负责这项工作。')
  assert.match(zh.text.split('\n')[1], /Claimed W-1 for AWR session S1 \(project revision 12\)/)
  assert.equal(first(await command({ agent, rawInput: 'claim' })), 'Claimed “Search endpoint” for this conversation.')
  const untitled = createAwrCommand({ awr: scripted({ status: () => status, 'work claim': () => ({}), 'work show': () => { throw new Error('gone') } }), bindings })
  assert.equal(first(await untitled({ agent, rawInput: 'claim --ui zh' })), '已认领这项工作，这个会话开始负责它。', 'a title that cannot be read does not fail the claim')
})

test('a progress note says in words that it was saved, and that some information is still missing when AWR said so', async () => {
  const ok = scripted({ status: () => status, 'context compile': () => ({ work_context: { context_hash: 'a'.repeat(64) } }), 'session checkpoint': () => ({ checkpoint: { id: 'C1' } }) })
  const plain = await createAwrCommand({ awr: ok, bindings })({ agent, rawInput: 'checkpoint did it :: next --ui zh' })
  assert.equal(first(plain), '已保存这个会话的进度记录。')
  assert.match(plain.text, /Checkpoint saved for AWR session S1 \(C1\)/)
  const gap = () => { throw new AwrError('failed', 'ContextIncomplete', { code: 'ContextIncomplete', awrDocument: { work_context: { context_hash: 'b'.repeat(64) }, error: { details: { incomplete_checkpoint_allowed: true } }, completeness: { source_fresh: true, issues: [{ code: 'x', reason: 'y' }] } } }) }
  const incomplete = scripted({ status: () => status, 'context compile': gap, 'session checkpoint': () => ({ checkpoint: { id: 'C2' } }) })
  const noted = await createAwrCommand({ awr: incomplete, bindings })({ agent, rawInput: 'checkpoint did it :: next' })
  assert.equal(first(noted), 'Saved a progress note. Some information about the work is still missing; that was noted too.')
  const missing = await createAwrCommand({ awr: ok, bindings })({ agent, rawInput: 'checkpoint only a digest --ui zh' })
  assert.equal(missing.kind, 'error')
  assert.equal(first(missing), '进度记录需要写明做了什么、接下来做什么。')
})

test('ending says the work is not completed by it; an error from AWR starts with a plain sentence and keeps AWR\'s own words after it', async () => {
  const awr = scripted({ status: () => status, 'session end': () => ({}) })
  const ended = await createAwrCommand({ awr, bindings })({ agent, rawInput: 'end --ui zh' })
  assert.equal(first(ended), '已结束这个会话的工作记录；工作本身不会因此算作完成。')
  const refusing = scripted({ status: () => status, 'work claim': () => { throw new AwrError('failed', 'RuleViolation: nope', { code: 'RuleViolation', awrMessage: 'nope' }) }, 'work show': () => ({}) })
  const refused = await createAwrCommand({ awr: refusing, bindings })({ agent, rawInput: 'claim --ui zh' })
  assert.equal(refused.kind, 'error')
  assert.equal(first(refused), 'AWR 没能完成这个操作。')
  assert.match(refused.text, /RuleViolation/, 'the details are kept')
  const outside = await createAwrCommand({ awr: scripted({}), bindings: { get: () => undefined } })({ agent, rawInput: 'claim --ui zh' })
  assert.equal(first(outside), '这个项目不在 AWR 管理之下，这里没有可做的事。')
})

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-awr-progress-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const graph = { version: 1, project_revision: 5, work_graph: { nodes: [{ key: 'A', title: 'Do A', status: 'in_progress', ready: false, blocker: null, active_claims: [], archived: false }], edges: [], cycle: [], graph_valid: true }, nav: { project: { name: 'demo' }, mainline_graph: { nodes: [] } }, goals: { hits: [] }, sessions: { sessions: [] } }
const managed = { projectRoot: '/p', state: 'initialized', steps: [], stop: null, receipt: null }
const capabilities = (...commands) => ({ capabilities: [{ id: 'overview', commands }] })

test('/awr progress writes the page\'s data and answers with one sentence', async () => {
  await withDirectory(async (dir) => {
    const awr = scripted({ capabilities: () => capabilities('overview snapshot', 'overview snapshot --refresh'), overview: (args) => { awr.last = args; return graph } })
    const progress = createProgress({ awr, takeover: { status: async () => managed }, dir, now: () => 99 })
    const command = createAwrCommand({ awr, bindings, progress })
    const answer = await command({ agent, rawInput: 'progress --ui zh' })
    assert.equal(answer.text, '项目进展已更新：1 项工作，1 项进行中，0 项受阻。')
    assert.deepEqual(awr.last, ['overview', 'snapshot'], 'no refresh unless asked')
    const written = JSON.parse(await readFile(join(dir, progressFileName('conv-1')), 'utf8'))
    assert.equal(written.ok, true)
    assert.equal(written.updatedAt, 99)
    assert.equal(written.nodes[0].title, 'Do A')
    await command({ agent, rawInput: 'progress refresh --ui zh' })
    assert.deepEqual(awr.last, ['overview', 'snapshot', '--refresh'], 'refresh has AWR synchronize the sources')
    assert.ok(!answer.text.includes('{'), 'a sentence')
  })
})

test('the progress file says why there is nothing to draw: not managed, an awr that is too old, a failure', async () => {
  await withDirectory(async (dir) => {
    const read = async () => JSON.parse(await readFile(join(dir, progressFileName('conv-1')), 'utf8'))
    const old = scripted({ capabilities: () => capabilities('status'), overview: () => { throw new Error('must not run: an unsupported command stops the plugin\'s awr use') } })
    const unsupported = createProgress({ awr: old, takeover: { status: async () => managed }, dir })
    const text = await createAwrCommand({ awr: old, bindings, progress: unsupported })({ agent, rawInput: 'progress --ui zh' })
    assert.equal(text.text, '已安装的 awr 版本太旧，不支持项目进展页。')
    assert.equal((await read()).reason, 'unsupported')
    assert.ok(!old.calls.some((call) => call[0] === 'overview'), 'the command itself is never run to find out')

    const none = createProgress({ awr: old, takeover: { status: async () => ({ projectRoot: '/p', state: 'not_initialized', steps: [] }) }, dir })
    assert.equal((await createAwrCommand({ awr: old, bindings, progress: none })({ agent, rawInput: 'progress --ui zh' })).text, 'AWR 还没有接管这个项目。')
    assert.equal((await read()).reason, 'not_managed')

    const broken = scripted({ capabilities: () => capabilities('overview snapshot'), overview: () => { throw new Error('the database is locked') } })
    const failing = createProgress({ awr: broken, takeover: { status: async () => managed }, dir })
    const failed = await createAwrCommand({ awr: broken, bindings, progress: failing })({ agent, rawInput: 'progress --ui zh' })
    assert.equal(failed.text.split('\n')[0], '读取不到项目进展。')
    assert.equal((await read()).reason, 'failed')
    assert.match((await read()).message, /database is locked/)
  })
})

test('a page that was opened is written again after a command that changes the work; one that never was is not', async () => {
  await withDirectory(async (dir) => {
    const awr = scripted({ status: () => status, 'work claim': () => ({}), 'work show': () => ({ work: { title: 'T' } }), capabilities: () => capabilities('overview snapshot'), overview: () => graph })
    const progress = createProgress({ awr, takeover: { status: async () => managed }, dir })
    const command = createAwrCommand({ awr, bindings, progress })
    await command({ agent, rawInput: 'claim' })
    await assert.rejects(() => readFile(join(dir, progressFileName('conv-1')), 'utf8'), /ENOENT/, 'nobody opened the page, so nothing is written')
    await command({ agent, rawInput: 'progress' })
    await writeFile(join(dir, progressFileName('conv-1')), '{"stale":true}')
    await command({ agent, rawInput: 'claim' })
    assert.equal(JSON.parse(await readFile(join(dir, progressFileName('conv-1')), 'utf8')).ok, true, 'the opened page is refreshed')
  })
})

test('two asks at once read the snapshot once, and a conversation without an id is refused', async () => {
  await withDirectory(async (dir) => {
    let runs = 0
    const awr = scripted({ capabilities: () => capabilities('overview snapshot'), overview: async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return graph } })
    const progress = createProgress({ awr, takeover: { status: async () => managed }, dir })
    await Promise.all([progress.publish(agent), progress.publish(agent)])
    assert.equal(runs, 1)
    await assert.rejects(() => progress.publish({}), /needs a conversation/)
  })
})
