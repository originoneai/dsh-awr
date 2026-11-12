// What the panel's own queries put in the conversation (DSH-056): one readable sentence and nothing else.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAwrCommand } from '../lib/commands.js'
import { createPanelPublisher } from '../lib/panel-snapshot.js'
import { panelSentence } from '../lib/panel-text.js'

const steps = (statuses) => ['preflight', 'preview', 'review', 'accept', 'organize', 'receipt'].map((name, index) => ({ name, status: statuses[index] ?? 'pending' }))
const view = (state, extra = {}) => ({ projectRoot: '/p', state, steps: steps([]), stop: null, receipt: null, ...extra })

test('every state is one sentence in English and in Chinese', () => {
  const work = { in_progress: [{}, {}], ready: [{}], blocked: [] }
  const cases = [
    [view('unavailable'), undefined, /cannot work/, /无法处理/],
    [view('not_initialized'), undefined, /no AWR work state/, /还没有 AWR 工作状态/],
    [view('running', { steps: steps(['done', 'done']) }), undefined, /Taking the project over · reviewing the draft \(step 3 of 6\)/, /正在接管项目 · 审阅草稿（第 3\/6 步）/],
    [view('completed', { receipt: { organization: { goalTotal: 2, gapTotal: 1 } } }), undefined, /Takeover done · 2 goal\(s\), 1 open gap\(s\)/, /接管完成 · 2 个目标，1 个未决缺口/],
    [view('stopped', { stop: { step: 'review', reason: 'review_failed' } }), undefined, /Takeover stopped at reviewing the draft · review_failed/, /接管在「审阅草稿」停下 · review_failed/],
    [view('failed', { stop: { step: 'accept', reason: 'x' } }), undefined, /Takeover failed at applying/, /接管在「应用」失败/],
    [view('interrupted', { steps: steps(['done']) }), undefined, /interrupted at reading the project; it can continue/, /接管在「读取项目」被中断，可以继续/],
    [view('initialized'), work, /AWR project · 2 in progress, 1 ready, 0 blocked/, /AWR 项目 · 2 项进行中，1 项就绪，0 项阻塞/],
    [view('completed', { receipt: { organization: { goalTotal: 1, gapTotal: 0 } } }), work, /AWR project · 2 in progress/, /AWR 项目 · 2 项进行中/],
  ]
  for (const [state, workView, en, zh] of cases) {
    assert.match(panelSentence(state, workView, 'en'), en, state.state)
    assert.match(panelSentence(state, workView, 'zh'), zh, state.state)
    assert.match(panelSentence(state, workView), en, 'English is the default')
  }
})

test('the managed sentence counts the whole queue when awr counted it', () => {
  const work = { totals: { active: 24, ready: 23, blocked: 39, waiting: 32 }, in_progress: [{}, {}], ready: [{}], blocked: [] }
  assert.match(panelSentence(view('initialized'), work, 'en'), /AWR project · 24 in progress, 23 ready, 39 blocked/)
  assert.match(panelSentence(view('initialized'), work, 'zh'), /AWR 项目 · 24 项进行中，23 项就绪，39 项阻塞/)
})

test('a sentence is a sentence: no JSON, no markup, one line', () => {
  const state = view('stopped', { stop: { step: 'review', reason: 'review_failed', message: 'The review failed: "quoted" {braces}' }, receipt: { mapped: { sources: [{ path: 'README.md' }] } } })
  const work = { in_progress: [], ready: [], blocked: [] }
  for (const language of ['en', 'zh']) {
    for (const shown of [state, view('running'), view('completed', { receipt: { organization: { goalTotal: 1, gapTotal: 0 } } }), view('not_initialized'), view('unavailable')]) {
      const text = panelSentence(shown, work, language)
      assert.ok(!/[{}"\[\]<>]/.test(text), `a readable sentence: ${text}`)
      assert.ok(!text.includes('\n'), 'one line')
    }
  }
})

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-awr-panel-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const agent = { session: { id: 'conv-1' } }

test('/awr panel answers with the sentence alone, in the language it is given, and writes the data to the file', async () => {
  await withDirectory(async (dir) => {
    const takeover = { status: async () => view('running', { steps: steps(['done', 'done']) }) }
    const panel = createPanelPublisher({ takeover, awr: { run: async () => ({}) }, bindings: { get: () => undefined }, dir, setTimer: () => undefined })
    const command = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover, panel })
    const zh = await command({ agent, rawInput: 'panel zh' })
    assert.equal(zh.kind, 'success')
    assert.equal(zh.text, '正在接管项目 · 审阅草稿（第 3/6 步）', 'the whole text of the row')
    const en = await command({ agent, rawInput: 'panel' })
    assert.equal(en.text, 'Taking the project over · reviewing the draft (step 3 of 6)')
    const other = await command({ agent, rawInput: 'panel fr' })
    assert.match(other.text, /^Taking the project over/, 'an unknown language falls back to English')
    const written = JSON.parse(await readFile(panel.file('conv-1'), 'utf8'))
    assert.equal(written.view.state, 'running')
    assert.equal(written.work, null)
  })
})

test('/awr panel adds the work state of a project AWR manages and nothing for one that is not', async () => {
  await withDirectory(async (dir) => {
    const awr = {
      async run(root, args) {
        if (args[0] === 'status') return { project: 'p', project_id: 'P', project_revision: 7, current: [{ key: 'W-1' }], ready: [{ key: 'W-2' }], blocked: [], waiting: [] }
        if (args[0] === 'session') return { session: { status: 'active' }, claims: [] }
        if (args[0] === 'work') return { work: { external_key: args[2], title: 'T', status: 'in_progress' } }
        throw new Error(`unexpected: ${args.join(' ')}`)
      },
    }
    const bindings = { get: async () => ({ projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } }) }
    const managedTakeover = { status: async () => view('initialized') }
    const managed = createAwrCommand({ awr, bindings, takeover: managedTakeover, panel: createPanelPublisher({ takeover: managedTakeover, awr, bindings, dir }) })
    const answer = await managed({ agent, rawInput: 'panel' })
    assert.equal(answer.text, 'AWR project · 1 in progress, 1 ready, 0 blocked')
    const payload = JSON.parse(await readFile(join(dir, 'conv-1.json'), 'utf8'))
    assert.equal(payload.work.session.id, 'S1')
    assert.equal(payload.work.bound_work.key, 'W-1')

    const plainTakeover = { status: async () => view('not_initialized') }
    const plain = createAwrCommand({ awr, bindings, takeover: plainTakeover, panel: createPanelPublisher({ takeover: plainTakeover, awr, bindings, dir }) })
    await plain({ agent, rawInput: 'panel' })
    assert.equal(JSON.parse(await readFile(join(dir, 'conv-1.json'), 'utf8')).work, null)
  })
})

test('/awr panel works without a publisher: the sentence, and no file', async () => {
  const takeover = { status: async () => view('not_initialized') }
  const command = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover })
  assert.equal((await command({ agent, rawInput: 'panel' })).text, 'This project has no AWR work state yet')
})

test('/awr panel is not in the usage that people read, and a failure is a short sentence', async () => {
  const command = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover: { status: async () => { throw new Error('boom') } } })
  const agent = { session: { id: 'conv-1' } }
  const help = await command({ agent, rawInput: 'help' })
  assert.ok(!/panel/.test(help.text), help.text)
  const failed = await command({ agent, rawInput: 'panel' })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /^AWR panel: boom$/)
  const withPublisher = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover: { status: async () => { throw new Error('boom') } }, panel: createPanelPublisher({ takeover: { status: async () => { throw new Error('boom') } }, awr: { run: async () => ({}) }, bindings: { get: () => undefined }, dir: join(tmpdir(), 'dsh-awr-never-written') }) })
  assert.match((await withPublisher({ agent, rawInput: 'panel' })).text, /^AWR panel: boom$/)
})
