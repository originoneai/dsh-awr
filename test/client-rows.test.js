// The rows of `/awr` commands in the conversation (DSH-060): what the plugin's own interface ran is not drawn at all, and
// a command a person typed is one quiet line with its technical details folded.
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClient, settle, textOf } from '../test-support/client-harness.js'

const command = (args, text, kind = 'success') => ({ kind: 'command', seq: 3, commandId: 'cmd-1', name: 'awr', args, outcome: text === null ? null : { kind, text } })
const isHidden = (ui) => ui.find((node) => node.props['data-awr-row'] === 'hidden') !== undefined && ui.byTestId('awr-row') === undefined
const summary = (ui) => textOf(ui.byTestId('awr-row-summary'))

test('what the plugin\'s own interface ran is not drawn: its questions, its buttons, and anything asked as JSON', () => {
  const client = loadClient()
  const internal = [
    command(' panel zh', 'AWR 项目 · 3 项进行中'),
    command(' panel --ui en', 'ok'),
    command(' progress --ui zh', '项目进展已更新：24 项工作，3 项进行中，2 项受阻。'),
    command(' progress refresh --ui en', 'ok'),
    command(' takeover --ui zh', '已开始接管这个项目。\nStarted the takeover of /p.'),
    command(' update check --ui en', 'The plugin is up to date.'),
    command(' claim --ui zh', '已认领「Parser」，这个会话开始负责这项工作。'),
    command(' takeover status --json', '{"projectRoot":"/p","state":"running"}'),
    command(' state --json', '{"project":{}}'),
  ]
  for (const node of internal) assert.ok(isHidden(client.row(node)), node.args)
})

test('a question of the interface that failed, or is still running, is not drawn either', () => {
  const client = loadClient()
  assert.ok(isHidden(client.row(command(' progress --ui zh', 'Unknown subcommand "progress".\n/awr ...', 'error'))))
  assert.ok(isHidden(client.row(command(' panel --ui en', 'AWR panel: boom', 'error'))))
  assert.ok(isHidden(client.row(command(' takeover --ui zh', null))))
})

test('rows that earlier versions left in a conversation disappear the same way', () => {
  const client = loadClient()
  assert.ok(isHidden(client.row(command(' takeover status --json', '{"projectRoot":"/Users/mac/demo","state":"not_initialized","steps":[]}'))))
  assert.ok(isHidden(client.row(command(' panel zh', '接管在「应用」停下 · awr_error <!--awr-panel:{"view":{"projectRoot":"/p"}}-->'))))
  assert.ok(isHidden(client.row(command(' state', '  {"project":{"name":"p"}}'))), 'raw JSON, whatever asked for it')
})

test('a command a person typed is one line: the first line of the answer, the rest folded until it is opened', async () => {
  const client = loadClient()
  const ui = client.row(command(' status', '3 in progress, 4 ready, 2 blocked\nProject P1, revision 128\nThis conversation is bound to AWR session S-0001 (work W-1)'))
  assert.equal(summary(ui), '3 in progress, 4 ready, 2 blocked')
  assert.ok(!ui.text().includes('S-0001') && !ui.text().includes('revision'), 'identifiers are not shown by default')
  assert.equal(ui.byTestId('awr-row-details'), undefined)
  const line = ui.byTestId('awr-row')
  assert.equal(line.type, 'button')
  assert.equal(line.props['aria-expanded'], false)
  await ui.click(line)
  assert.match(textOf(ui.byTestId('awr-row-details')), /^Project P1, revision 128\nThis conversation is bound to AWR session S-0001 \(work W-1\)$/)
  assert.equal(ui.byTestId('awr-row').props['aria-expanded'], true)
  await ui.click(ui.byTestId('awr-row'))
  assert.equal(ui.byTestId('awr-row-details'), undefined, 'and folds again')
})

test('an answer of one line has nothing to unfold; a refusal is red and keeps AWR\'s own words folded', async () => {
  const client = loadClient()
  const plain = client.row(command(' evidence', 'No evidence candidates.'))
  assert.equal(summary(plain), 'No evidence candidates.')
  assert.equal(plain.byTestId('awr-row').type, 'div', 'not a button: there is nothing behind it')
  const refused = client.row(command(' claim W-9', 'AWR could not do that.\nRuleViolation: the work is claimed by another session (S-0002)', 'error'))
  assert.equal(summary(refused), 'AWR could not do that.')
  assert.equal(refused.find((node) => node.props['data-awr-row'] === 'error') !== undefined, true)
  assert.match(JSON.stringify(refused.byTestId('awr-row-summary').props.style), /state-error/)
  assert.ok(!refused.text().includes('S-0002'))
  await refused.click(refused.byTestId('awr-row'))
  assert.match(textOf(refused.byTestId('awr-row-details')), /RuleViolation: the work is claimed by another session \(S-0002\)/)
})

test('a typed command that is still running says so, and an empty answer says it is done', () => {
  const client = loadClient({ language: 'zh' })
  assert.equal(summary(client.row(command(' checkpoint did :: next', null))), '处理中')
  assert.equal(summary(client.row(command(' evidence dismiss', ''))), '已完成')
  assert.equal(summary(client.row(command(' end', '', 'error'))), '没有成功')
})

test('answers written by earlier versions get a plain sentence, and their original text is folded whole', async () => {
  const client = loadClient({ language: 'zh' })
  const cases = [
    [command(' takeover', 'Started the takeover of /Users/mac/demo. It runs in the background; this conversation stays free.'), '已开始接管这个项目'],
    [command(' takeover', 'Resumed the takeover of /Users/mac/demo. It runs in the background.'), '已继续接管这个项目'],
    [command(' claim', 'Claimed md-01da5526 for AWR session 01M7853FX3F0SYCSN0AXQ70N21 (project revision 16).'), '已认领一项工作'],
    [command(' checkpoint a :: b', 'Checkpoint saved for AWR session 01M7853FX3F0SYCSN0AXQ70N21 (01M785HHWF), marked incomplete.'), '已保存进度记录'],
    [command(' end ended', 'Ended AWR session 01M7853FX3F0SYCSN0AXQ70N21 as ended. Work is not completed by ending a session.'), '已结束这个会话的工作记录'],
    [command(' claim', 'Name the work to claim: /awr claim WORK', 'error'), 'AWR 没能完成这个操作'],
    [command(' checkpoint a :: b', 'AWR for /Users/mac/demo: ContextIncomplete: context incomplete: L1 has required gaps', 'error'), 'AWR 没能完成这个操作'],
  ]
  for (const [node, expected] of cases) {
    const ui = client.row(node)
    assert.equal(summary(ui), expected, node.outcome.text)
    await ui.click(ui.byTestId('awr-row'))
    assert.equal(textOf(ui.byTestId('awr-row-details')), node.outcome.text, 'nothing of the original is lost')
  }
  const status = client.row(command(' status', 'Project 01M1YJBR5PW6QXYGABADJVAJPC, revision 23567\n5 in progress, 5 ready, 5 blocked\nIn progress: AWR-CG-008'))
  assert.equal(summary(status), '5 in progress, 5 ready, 5 blocked', 'the old status is read by its second line')
})

test('a sentence of this version is never taken for an old one', () => {
  const client = loadClient()
  for (const text of ['Claimed “Parser” for this conversation.', 'Saved a progress note for this conversation.', 'Started taking the project over. It runs in the background; you can keep working.']) {
    assert.equal(summary(client.row(command(' x', `${text}\ndetails`))), text)
  }
})

test('the row carries the mark that lets the stylesheet close the gap of rows that are not drawn', async () => {
  const client = loadClient()
  const hidden = client.row(command(' panel --ui en', 'ok'))
  const mark = hidden.find((node) => node.props['data-awr-row'] === 'hidden')
  assert.equal(mark.props.hidden, true)
  assert.equal(hidden.text(), '')
  await settle()
})
