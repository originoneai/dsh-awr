// The AWR light in the conversation header and the card it opens (DSH-061): what a person sees is plain language, the
// engineering facts stay folded, and looking never puts anything in the conversation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildClient } from '../scripts/build-client.mjs'
import { loadClient, settle, textOf } from '../test-support/client-harness.js'

const STEPS = ['preflight', 'preview', 'review', 'accept', 'organize', 'receipt']
const steps = (statuses) => STEPS.map((name, index) => ({ name, status: statuses[index] ?? 'pending' }))
const awr = { cli: '/opt/tools/awr', source: 'path', version: '0.8.0', takeover: 'awr' }
const offer = () => ({ projectRoot: '/work/demo', state: 'not_initialized', steps: [], stop: null, receipt: null, awr })
const running = () => ({ projectRoot: '/work/demo', state: 'running', steps: steps(['done', 'done', 'running']), stop: null, receipt: null, awr })
const stopped = () => ({ projectRoot: '/work/demo', state: 'stopped', steps: steps(['done', 'done', 'stopped']), stop: { step: 'review', reason: 'secret_boundary', message: 'RuleViolation: content boundary', detail: { path: 'docs/README.md', line: 302, category: 'credential' } }, receipt: null, awr })
const managed = () => ({ projectRoot: '/work/demo', state: 'initialized', steps: [], stop: null, receipt: null, awr })
const workView = (patch = {}) => ({
  project: { revision: 7 },
  session: { id: 'S-0001', status: 'active' },
  bound_work: { key: 'W-1', title: 'Parser', status: 'in_progress', next_action: 'write the tests', blocker: null },
  claims: [],
  in_progress: [{ key: 'W-1' }],
  ready: [{ key: 'W-2' }, { key: 'W-3' }],
  blocked: [],
  ...patch,
})
const light = (ui) => ui.find((node) => node.props['data-light'] !== undefined)?.props['data-light']
const open = async (client) => {
  const ui = await client.chip()
  await ui.click('awr-header-action')
  await settle()
  return ui
}
const fold = (ui, label = 'Technical details') => ui.find((node) => node.type === 'button' && textOf(node) === label)
/** The colour a count is drawn in, to tell the red one from the others. */
const numberColor = (ui, name) => ui.all((node) => node.props['data-count'] === name)[0].children[0].props.style.color

test('client.js is what the parts in client/ build', () => {
  const committed = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  assert.equal(committed, buildClient(), 'run `npm run build` after editing client/*.js')
})

test('the light says how the project stands, without asking the host anything', async () => {
  const cases = [
    [{ view: offer }, 'ready', 'an empty ring: AWR does not manage the project'],
    [{ view: running }, 'active', 'lit while a takeover runs'],
    [{ view: stopped }, 'blocked', 'red where a takeover stopped'],
    [{ view: managed, work: () => workView() }, 'good', 'green when all is well'],
    [{ view: managed, work: () => workView({ blocked: [{ key: 'W-9', title: 'Deploy', blocker: 'needs a domain' }] }) }, 'waiting', 'amber when something needs the person'],
    [{ view: managed, work: () => workView({ organization: { ready: false, gaps: 3 }, blocked: [{ key: 'W-9', title: 'Deploy' }] }) }, 'waiting', 'amber while AWR cannot start work in an incomplete project'],
    [{ view: managed, work: () => workView({ organization: { ready: true, gaps: 40 }, blocked: [{ key: 'W-9', title: 'Deploy', structural: ['work_structure_incomplete'] }] }) }, 'good', 'work that is only not ready is not the person\'s to do'],
    [{ view: () => ({ ...managed(), state: 'completed', receipt: { awaitingConfirmation: [{ title: 'A goal' }] } }), work: () => workView() }, 'waiting', 'amber while goals wait for confirmation'],
    [{ files: 'none' }, 'planned', 'nothing known yet'],
  ]
  for (const [options, expected, why] of cases) {
    const client = loadClient(options)
    const ui = await client.chip()
    assert.equal(light(ui), expected, why)
    assert.deepEqual(client.calls, [], `${why}: no command`)
    assert.deepEqual(client.timers(), [], `${why}: no timer`)
  }
})

test('a card opened on data written a moment ago asks the host nothing', async () => {
  const client = loadClient({ view: managed, work: () => workView() })
  const ui = await open(client)
  assert.deepEqual(client.calls, [], 'no command, so nothing in the conversation')
  assert.ok(ui.byTestId('awr-managed'))
  assert.equal(client.reads.at(-1).path, '/Users/test/.local/state/dsh-awr/panel/conv-1.json')
  assert.equal(JSON.stringify(client.reads.at(-1).range), '{}')
})

test('data that is missing or older than 30 s makes the host write it, with one command in the interface language', async () => {
  for (const files of ['none', 'stale']) {
    const client = loadClient({ view: managed, work: () => workView(), files })
    const ui = await open(client)
    assert.deepEqual(client.calls, ['/awr panel --ui en'], files)
    assert.ok(ui.byTestId('awr-managed'), 'and then the card shows the project')
  }
  const chinese = loadClient({ view: managed, work: () => workView(), files: 'none', language: 'zh' })
  await open(chinese)
  assert.deepEqual(chinese.calls, ['/awr panel --ui zh'])
})

test('a managed project is shown in plain words: the counts, what this conversation is on, what needs the person', async () => {
  const client = loadClient({
    view: managed,
    work: () => workView({ blocked: [{ key: 'W-7', title: 'Deploy', blocker: 'waiting for the security team' }, { key: 'W-8', title: 'Search' }, { key: 'W-9', title: 'Third' }] }),
  })
  const ui = await open(client)
  const text = ui.text()
  assert.match(text, /demo/, 'the project by the name of its folder')
  assert.match(text, /Managed by AWR/)
  const counts = Object.fromEntries(ui.all((node) => node.props['data-count']).map((node) => [node.props['data-count'], textOf(node.children[0])]))
  assert.deepEqual(counts, { active: '1', ready: '2', held: '3' })
  assert.match(textOf(ui.byTestId('awr-bound-work')), /This conversation is on.*Parser.*Next: write the tests/)
  const needs = textOf(ui.byTestId('awr-needs'))
  assert.match(needs, /“Deploy” is blocked.*waiting for the security team/)
  assert.match(needs, /“Search” cannot start yet/, 'work AWR holds back without a reason is not called stuck')
  assert.match(needs, /1 more/, 'two are listed, the rest counted')
  assert.match(text, /The whole picture is on the Progress tab/)
})

test('the counts are those AWR reports for the whole queue, not the length of the sample it listed', async () => {
  const sample = (n) => Array.from({ length: 5 }, (_, i) => ({ key: `W-${n + i}`, title: `Work ${n + i}` }))
  const client = loadClient({
    view: managed,
    work: () => workView({ totals: { active: 24, ready: 23, blocked: 39, waiting: 32 }, in_progress: sample(100), ready: sample(200), blocked: sample(300), counts: { blocked: 21 } }),
  })
  const ui = await open(client)
  const counts = Object.fromEntries(ui.all((node) => node.props['data-count']).map((node) => [node.props['data-count'], textOf(node.children[0])]))
  assert.deepEqual(counts, { active: '24', ready: '23', held: '39' })
  assert.match(textOf(ui.byTestId('awr-needs')), /37 more/, 'two of the 39 are named, the rest counted')
  assert.notEqual(numberColor(ui, 'held'), numberColor(ui, 'active'), 'something is recorded as blocking, so the number is red')
})

test('a project AWR cannot start work in yet says so once, instead of listing every piece of work as stuck', async () => {
  const client = loadClient({
    view: () => ({ ...managed(), state: 'completed', receipt: { organization: { goalTotal: 1, gapTotal: 8 }, awaitingConfirmation: [{ title: 'Project goal' }] } }),
    work: () => workView({
      organization: { ready: false, gaps: 8 },
      bound_work: null,
      in_progress: [],
      ready: [],
      blocked: [{ key: 'W-8', title: 'Search endpoint', structural: ['work_structure_incomplete', 'work_goal_missing'] }, { key: 'W-9', title: 'Ranking by recency', structural: ['work_structure_incomplete'] }],
    }),
  })
  const ui = await open(client)
  const needs = textOf(ui.byTestId('awr-needs'))
  assert.match(needs, /Work cannot start until the missing details are filled in \(8\)/)
  assert.match(needs, /1 goal\(s\) wait for your confirmation/)
  assert.ok(!needs.includes('Search endpoint') && !needs.includes('Ranking by recency'), 'not one line for each piece of work')
  assert.ok(!needs.includes('more'), 'and nothing left over to count')
  const counts = Object.fromEntries(ui.all((node) => node.props['data-count']).map((node) => [node.props['data-count'], textOf(node.children[0])]))
  assert.deepEqual(counts, { active: '0', ready: '0', held: '2' })
  assert.equal(numberColor(ui, 'held'), numberColor(ui, 'active'), 'nothing is recorded as blocking, so the number is not red')
})

test('the engineering facts are folded until someone opens them', async () => {
  const client = loadClient({ view: managed, work: () => workView() })
  const ui = await open(client)
  for (const hidden of ['S-0001', 'W-1', '/work/demo', '/opt/tools/awr', '0.8.0', 'revision']) assert.ok(!ui.text().includes(hidden), `${hidden} is not shown by default`)
  assert.equal(ui.byTestId('awr-tech'), undefined)
  await ui.click(fold(ui))
  const tech = textOf(ui.byTestId('awr-tech'))
  for (const shown of ['/work/demo', '7', 'S-0001 (active)', 'W-1', '0.8.0 · /opt/tools/awr', 'The takeover runs through awr takeover', '/awr help']) assert.ok(tech.includes(shown), `${shown} is in the technical details`)
})

test('the card offers no buttons for what the agent does on its own', async () => {
  const client = loadClient({ view: managed, work: () => workView() })
  const ui = await open(client)
  await ui.click(fold(ui))
  for (const id of ['awr-claim', 'awr-checkpoint-open', 'awr-checkpoint-digest', 'awr-checkpoint-next', 'awr-checkpoint-save', 'awr-end-open', 'awr-end-confirm']) assert.equal(ui.byId(id), undefined, id)
  assert.equal(ui.all((node) => node.type === 'input' || node.type === 'textarea' || node.type === 'select').length, 0, 'nothing to type into')
})

test('a project AWR does not manage gets the offer; one click starts the takeover and the card follows it by reading', async () => {
  let current = offer()
  const client = loadClient({ view: () => current, answer: (line) => { if (line.startsWith('/awr takeover')) current = running(); return 'Started taking the project over.' } })
  const ui = await open(client)
  assert.match(textOf(ui.byTestId('awr-offer')), /Let AWR keep track of this project.*It only adds a \.awr folder/)
  await ui.click('awr-takeover-start')
  assert.deepEqual(client.calls, ['/awr takeover --ui en'], 'one command; the data came with it')
  assert.match(textOf(ui.byTestId('awr-running')), /Taking over the project.*Step 3 of 6 · Reviewing the draft.*You can keep working/)
  const status = (name) => ui.find((node) => node.props['data-step'] === name).props['data-status']
  assert.deepEqual(STEPS.map(status), ['done', 'done', 'running', 'pending', 'pending', 'pending'])
  assert.deepEqual(client.timers(), [2500], 'it reads again in 2.5 s')
  current = { ...running(), steps: steps(['done', 'done', 'done', 'running']) }
  client.host.publish()
  await client.fire(2500)
  assert.equal(status('accept'), 'running')
  assert.deepEqual(client.calls, ['/awr takeover --ui en'], 'following the takeover runs no command')
  current = { ...managed(), state: 'completed', steps: steps(['done', 'done', 'done', 'done', 'done', 'done']), receipt: { organization: { goalTotal: 2, gapTotal: 9 }, awaitingConfirmation: [] } }
  client.host.publish()
  await client.fire(2500)
  assert.match(textOf(ui.byTestId('awr-done')), /The takeover is done · AWR organized 2 goal\(s\)\. 9 detail\(s\) still need filling in/)
  assert.deepEqual(client.timers(), [], 'nothing is read once it is done')
})

test('a takeover whose data stops changing makes the card ask the host once; closing the card stops the reading', async () => {
  const client = loadClient({ view: running })
  const ui = await open(client)
  for (let round = 0; round < 5; round += 1) await client.fire(2500)
  assert.deepEqual(client.calls, [], 'five unchanged reads are not enough')
  await client.fire(2500)
  assert.deepEqual(client.calls, ['/awr panel --ui en'], 'the sixth asks once')
  assert.deepEqual(client.timers(), [2500])
  await client.press('Escape')
  assert.deepEqual(client.timers(), [], 'a closed card reads nothing')
  assert.equal(ui.byId('awr-panel'), undefined)
})

test('a takeover that stopped says why in words and where; the code and the raw message are in the technical details', async () => {
  let current = stopped()
  const client = loadClient({ view: () => current, answer: (line) => { if (line.startsWith('/awr takeover')) current = running(); return 'ok' } })
  const ui = await open(client)
  const block = textOf(ui.byTestId('awr-stopped'))
  assert.match(block, /The takeover stopped/)
  assert.match(block, /looks like a key or a password/)
  assert.match(textOf(ui.byTestId('awr-stop-location')), /Where: docs\/README\.md:302/)
  assert.ok(!ui.text().includes('secret_boundary') && !ui.text().includes('RuleViolation'), 'no reason code or raw message by default')
  await ui.click(fold(ui))
  assert.match(textOf(ui.byTestId('awr-tech')), /secret_boundary.*RuleViolation: content boundary/)
  assert.match(textOf(ui.byId('awr-takeover-start')), /^Continue$/)
  await ui.click('awr-takeover-start')
  assert.deepEqual(client.calls, ['/awr takeover --ui en'])
  assert.ok(ui.byTestId('awr-running'))
})

test('a reason this version does not know still gets a sentence, and a refusal to start is shown as the host wrote it', async () => {
  const client = loadClient({
    view: () => ({ ...stopped(), stop: { step: 'accept', reason: 'brand_new_reason', message: 'x' } }),
    answer: () => ({ error: 'The takeover is already running.\nThe takeover of /work/demo is already running.' }),
  })
  const ui = await open(client)
  assert.match(textOf(ui.byTestId('awr-reason')), /Something unexpected happened/)
  await ui.click('awr-takeover-start')
  assert.equal(textOf(ui.byTestId('awr-failure')), 'The takeover is already running.', 'the first line, the one written for people')
})

test('a conversation without a project, and a host that cannot be read, are said plainly', async () => {
  const none = loadClient({ view: () => ({ projectRoot: null, state: 'unavailable', steps: [], stop: null, receipt: null }) })
  assert.match(textOf((await open(none)).byTestId('awr-none')), /No project in this conversation/)
  const broad = loadClient({ view: () => ({ projectRoot: null, state: 'unavailable', steps: [], stop: { step: 'preflight', reason: 'too_broad', message: 'x' }, receipt: null }) })
  assert.match(textOf((await open(broad)).byTestId('awr-none')), /too broad to be one project/)
  const noFiles = loadClient({ fileService: false, files: 'none' })
  const ui = await open(noFiles)
  assert.match(textOf(ui.byTestId('awr-error')), /The project state could not be read/)
  assert.ok(!ui.text().includes('no file service'), 'the reason is folded')
  await ui.click(fold(ui))
  assert.match(ui.text(), /no file service for the plugin/)
})

test('Refresh asks the host once more', async () => {
  const client = loadClient({ view: managed, work: () => workView() })
  const ui = await open(client)
  await ui.click('awr-refresh')
  assert.deepEqual(client.calls, ['/awr panel --ui en'])
})

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const fromGithub = (check) => ({ kind: 'github', version: '0.1.0', repo: 'originoneai/dsh-awr', ref: 'main', installed: A, ...(check ? { check } : {}) })
const available = { checkedAt: 1, ref: 'main', latest: B, available: true, spec: `github:originoneai/dsh-awr#${B}` }

test('a plugin installed from GitHub can check for a newer version and install it from the card', async () => {
  let plugin = fromGithub()
  const client = loadClient({ view: managed, work: () => workView(), plugin: () => plugin, answer: (line) => { if (line.startsWith('/awr update')) plugin = fromGithub(available); return 'A newer version is available.' } })
  const ui = await open(client)
  assert.match(textOf(ui.byTestId('awr-update')), /^Plugin 0\.1\.0Check for updates$/)
  assert.ok(!ui.text().includes(A.slice(0, 7)), 'the commit is not shown by default')
  await ui.click('awr-update-check')
  assert.deepEqual(client.calls, ['/awr update check --ui en'])
  assert.match(textOf(ui.byTestId('awr-update')), /Update available/)
  await ui.click('awr-update-apply')
  assert.deepEqual(client.installs.map((call) => call.spec), [`github:originoneai/dsh-awr#${B}`], 'the plugin manager installs the same repository pinned to the newest commit')
  assert.match(textOf(ui.byTestId('awr-update')), /Updated\. Reloading/)
})

test('after an update the card is rebuilt: an offer that was taken is asked again and goes, and a host still running the old code says it needs a restart', async () => {
  // The card opens on the answer of an earlier check; meanwhile the update was installed.
  let plugin = fromGithub(available)
  const client = loadClient({ view: managed, work: () => workView(), plugin: () => plugin })
  const chip = await client.chip()
  plugin = { ...fromGithub({ ...available, available: false }), installed: B, version: '0.1.1', running: '0.1.0' }
  await chip.click('awr-header-action')
  await settle()
  assert.deepEqual(client.calls, ['/awr panel --ui en'], 'one question to the host when the card opens on an offer, and no row for it')
  const line = textOf(chip.byTestId('awr-update'))
  assert.match(line, /^Plugin 0\.1\.1Updated\. Restart DeepSeek Harness to use it$/, 'the version on disk, and that the running host has not loaded it')
  assert.equal(chip.byId('awr-update-apply'), undefined, 'nothing is offered again')
  assert.equal(chip.byId('awr-update-check'), undefined)
  // A card that opens on no offer asks nothing.
  const quiet = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub() })
  await open(quiet)
  assert.deepEqual(quiet.calls, [])
  // Code that is as new as the files has nothing to restart.
  const current = loadClient({ view: managed, work: () => workView(), plugin: () => ({ ...fromGithub(), running: '0.1.0' }) })
  assert.match(textOf((await open(current)).byTestId('awr-update')), /Check for updates/)
})

test('an update that went through is not reported as failed because the answer of the call was lost', async () => {
  // DeepSeek Harness loads the updated plugin while the call is open: the call may end as an error although the files changed.
  let plugin = fromGithub(available)
  const installed = () => { plugin = { ...fromGithub({ ...available, available: false }), installed: B, version: '0.1.1', running: '0.1.1' } }
  for (const install of [async () => { installed(); throw new Error('the connection went away') }, async () => { installed(); return { ok: false, error: { code: 'gateway/closed' } } }]) {
    plugin = fromGithub(available)
    const client = loadClient({ view: managed, work: () => workView(), plugin: () => plugin, install })
    const ui = await open(client)
    client.calls.length = 0
    await ui.click('awr-update-apply')
    assert.deepEqual(client.calls, ['/awr panel --ui en'], 'the host is asked what is installed')
    const line = textOf(ui.byTestId('awr-update'))
    assert.match(line, /^Plugin 0\.1\.1Up to date/, 'and what it says is shown')
    assert.equal(ui.byTestId('awr-update-failure'), undefined, 'no failure is reported for an update that happened')
  }
  // A failure that left the plugin as it was is still a failure, and says so once the host has been asked.
  plugin = fromGithub(available)
  const failed = loadClient({ view: managed, work: () => workView(), plugin: () => plugin, install: async () => ({ ok: true, value: { application: 'failed', error: { code: 'incompatible-version' } } }) })
  const ui = await open(failed)
  failed.calls.length = 0
  await ui.click('awr-update-apply')
  assert.match(textOf(ui.byTestId('awr-update')), /The update did not go through/)
  assert.deepEqual(failed.calls, ['/awr panel --ui en'], 'the host is asked after a failure as well')
})

test('once the update is applied the host is asked for the facts again', async () => {
  const client = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub(available) })
  const ui = await open(client)
  client.calls.length = 0
  await ui.click('awr-update-apply')
  assert.deepEqual(client.calls, ['/awr panel --ui en'])
})

test('an update that needs a restart, fails or cannot reach GitHub says so, and the installed version is said to be unchanged', async () => {
  const outcome = async (value) => {
    const client = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub(available), install: async () => value })
    const ui = await open(client)
    await ui.click('awr-update-apply')
    return textOf(ui.byTestId('awr-update'))
  }
  assert.match(await outcome({ ok: true, value: { application: 'restart-required' } }), /Updated\. Restart DeepSeek Harness to use it/)
  assert.match(await outcome({ ok: true, value: { application: 'failed', failedAt: 'spec-host' } }), /GitHub could not be reached\. Try again later/)
  assert.match(await outcome({ ok: true, value: { application: 'failed', packageResult: { kind: 'timeout' } } }), /GitHub could not be reached/)
  assert.match(await outcome({ ok: true, value: { application: 'failed', error: { code: 'incompatible-version' } } }), /The update did not go through\. The installed version is unchanged/)
  assert.match(await outcome({ ok: false, error: { code: 'gateway/forbidden' } }), /The update did not go through/)
})

test('only the exact shape of an update is ever installed, and without a plugin manager there is no Update button', async () => {
  for (const spec of ['github:someone/else#main', 'https://evil.example/x.tgz', `github:originoneai/dsh-awr#${B} --ignore-scripts`, 'link:/tmp/x', undefined]) {
    const client = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub({ ...available, spec }) })
    const ui = await open(client)
    await ui.click('awr-update-apply')
    assert.deepEqual(client.installs, [], String(spec))
  }
  const noManager = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub(available), manager: false })
  const ui = await open(noManager)
  assert.match(textOf(ui.byTestId('awr-update')), /Update available/)
  assert.equal(ui.byId('awr-update-apply'), undefined)
})

test('a plugin that runs from a folder, or was not installed from GitHub, offers no update and says why in the details', async () => {
  for (const [kind, why] of [['checkout', /Runs from a local folder\. Update it with git/], ['other', /Not installed from GitHub/]]) {
    const client = loadClient({ view: managed, work: () => workView(), plugin: () => ({ kind, version: '0.1.0' }) })
    const ui = await open(client)
    assert.equal(textOf(ui.byTestId('awr-update')), 'Plugin 0.1.0')
    assert.equal(ui.byId('awr-update-check'), undefined)
    await ui.click(fold(ui))
    assert.match(textOf(ui.byTestId('awr-tech')), why)
  }
  const up = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub({ ...available, available: false }) })
  assert.match(textOf((await open(up)).byTestId('awr-update')), /Up to date/)
})

test('a check that fails says so in the host\'s own first line', async () => {
  const client = loadClient({ view: managed, work: () => workView(), plugin: () => fromGithub(), answer: () => ({ error: 'Could not check for updates.\nGitHub did not answer within 10 s.' }) })
  const ui = await open(client)
  await ui.click('awr-update-check')
  assert.equal(textOf(ui.byTestId('awr-update-failure')), 'Could not check for updates.')
})

test('every sentence exists in both languages, and the Chinese interface is Chinese', async () => {
  const client = loadClient({ view: managed, work: () => workView(), language: 'zh' })
  const ui = await open(client)
  assert.match(ui.text(), /由 AWR 管理/)
  assert.match(ui.text(), /这个会话在做/)
  const { en, zh } = client.dictionaries.awr
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the two dictionaries have the same keys')
  for (const dictionary of [en, zh]) {
    for (const [key, value] of Object.entries(dictionary)) assert.ok(!/[!！]/.test(value), `no exclamation mark in ${key}`)
  }
  for (const key of Object.keys(en)) {
    const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort().join()
    assert.equal(placeholders(zh[key]), placeholders(en[key]), `the same placeholders in ${key}`)
  }
})
