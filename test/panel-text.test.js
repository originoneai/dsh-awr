// What the panel's own queries put in the conversation (DSH-056): one readable sentence, and the data out of sight.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAwrCommand } from '../lib/commands.js'
import { decodePanel, encodePanel, panelSentence, panelText } from '../lib/panel-text.js'

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

test('the first line a person sees has no JSON in it, and without the comment nothing but the sentence is left', () => {
  const state = view('stopped', { stop: { step: 'review', reason: 'review_failed', message: 'The review failed: "quoted" {braces}' }, receipt: { mapped: { sources: [{ path: 'README.md' }] } } })
  for (const language of ['en', 'zh']) {
    const text = panelText(state, { in_progress: [], ready: [], blocked: [] }, language)
    const [first, ...rest] = text.split('\n')
    assert.ok(!/[{}"\[\]]/.test(first), `a readable sentence: ${first}`)
    assert.equal(rest.length, 1, 'one more line: the comment')
    assert.equal(text.replace(/<!--[\s\S]*?-->/g, '').trim(), first, 'a Markdown view that hides comments shows only the sentence')
  }
})

test('the payload survives a round trip, including text that would end a comment', () => {
  const nasty = { view: { state: 'stopped', stop: { message: 'a --> b <!-- c -- d ---- e', detail: { path: '文档/说明.md', line: 4 } } }, work: null, n: -1, tail: '--' }
  const text = encodePanel(nasty)
  assert.equal(text.indexOf('-->'), text.length - 3, 'the only comment end is the last one')
  assert.ok(!text.slice(4, -3).includes('--'), 'no double hyphen inside the comment')
  assert.deepEqual(decodePanel(`A sentence\n${text}\n`), nasty)
})

test('text without a payload, or with a broken one, decodes to nothing', () => {
  assert.equal(decodePanel('Just a sentence'), undefined)
  assert.equal(decodePanel('<!--awr-panel:{not json}-->'), undefined)
  assert.equal(decodePanel(undefined), undefined)
  assert.equal(decodePanel('<!-- another comment -->'), undefined)
})

test('/awr panel answers with the sentence and the data, in the language it is given', async () => {
  const takeover = { status: async () => view('running', { steps: steps(['done', 'done']) }) }
  const command = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover })
  const agent = { session: { id: 'conv-1' } }
  const zh = await command({ agent, rawInput: 'panel zh' })
  assert.equal(zh.kind, 'success')
  assert.match(zh.text.split('\n')[0], /正在接管项目 · 审阅草稿/)
  assert.equal(decodePanel(zh.text).view.state, 'running')
  const en = await command({ agent, rawInput: 'panel' })
  assert.match(en.text.split('\n')[0], /Taking the project over/)
  const other = await command({ agent, rawInput: 'panel fr' })
  assert.match(other.text.split('\n')[0], /Taking the project over/, 'an unknown language falls back to English')
})

test('/awr panel adds the work state of a project AWR manages and nothing for one that is not', async () => {
  const awr = {
    async run(root, args) {
      if (args[0] === 'status') return { project: 'p', project_id: 'P', project_revision: 7, current: [{ key: 'W-1' }], ready: [{ key: 'W-2' }], blocked: [], waiting: [] }
      if (args[0] === 'session') return { session: { status: 'active' }, claims: [] }
      if (args[0] === 'work') return { work: { external_key: args[2], title: 'T', status: 'in_progress' } }
      throw new Error(`unexpected: ${args.join(' ')}`)
    },
  }
  const bindings = { get: async () => ({ projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } }) }
  const agent = { session: { id: 'conv-1' } }
  const managed = createAwrCommand({ awr, bindings, takeover: { status: async () => view('initialized') } })
  const answer = await managed({ agent, rawInput: 'panel' })
  assert.match(answer.text.split('\n')[0], /AWR project · 1 in progress, 1 ready, 0 blocked/)
  const payload = decodePanel(answer.text)
  assert.equal(payload.work.session.id, 'S1')
  assert.equal(payload.work.bound_work.key, 'W-1')

  const plain = createAwrCommand({ awr, bindings, takeover: { status: async () => view('not_initialized') } })
  assert.equal(decodePanel((await plain({ agent, rawInput: 'panel' })).text).work, null)
})

test('/awr panel is not in the usage that people read, and a failure is a short sentence', async () => {
  const command = createAwrCommand({ awr: { run: async () => ({}) }, bindings: { get: () => undefined }, takeover: { status: async () => { throw new Error('boom') } } })
  const agent = { session: { id: 'conv-1' } }
  const help = await command({ agent, rawInput: 'help' })
  assert.ok(!/panel/.test(help.text), help.text)
  const failed = await command({ agent, rawInput: 'panel' })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /^AWR panel: boom$/)
})
