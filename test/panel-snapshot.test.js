// The file the panel reads its data from (DSH-056): what is written, where, and when it is written again.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAwrCommand } from '../lib/commands.js'
import { createPanelPublisher, panelDir, refreshAfterAgent, SNAPSHOT_VERSION, snapshotFileName, snapshotPath } from '../lib/panel-snapshot.js'

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-awr-snapshot-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const agent = (id = 'conv-1') => ({ session: { id } })
const read = async (file) => JSON.parse(await readFile(file, 'utf8'))
const idle = { run: async () => ({}) }
const nobody = { get: () => undefined }

/** A takeover whose state the test moves; `calls` counts how often the panel asked for it. */
function fakeTakeover(states) {
  const takeover = { calls: 0, status: async () => states[Math.min(takeover.calls++, states.length - 1)] }
  return takeover
}
const running = { projectRoot: '/p', state: 'running', steps: [{ name: 'preflight', status: 'done' }], stop: null, receipt: null }
const stopped = { projectRoot: '/p', state: 'stopped', steps: [{ name: 'preflight', status: 'done' }], stop: { step: 'review', reason: 'review_failed', message: 'no' }, receipt: null }

/** Timers the test fires by hand. */
function fakeTimers() {
  const waiting = []
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true, unref() {} }; waiting.push(timer); return timer },
    clearTimer: (timer) => { timer.live = false },
    waiting: () => waiting.filter((timer) => timer.live),
    async fire() {
      const timer = waiting.find((item) => item.live)
      assert.ok(timer, 'no timer is waiting')
      timer.live = false
      await timer.fn()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('a conversation the plugin instance has not bound (loaded again by an update) still gets its work in the file', async () => {
  const initialized = { projectRoot: '/p', state: 'initialized', steps: [], stop: null, receipt: null }
  const status = { project: 'demo', project_id: 'P1', project_revision: 3, counts: { planned: 2 }, current: [], ready: [], blocked: [], waiting: [] }
  const awr = { run: async (root, args) => { if (args[0] === 'status') return status; throw new Error(`unexpected ${args.join(' ')}`) } }
  const asked = []
  const found = { get: () => undefined, ensure: async (who) => { asked.push(who.session.id); return { projectRoot: '/p', outcome: 'existing' } } }
  const { collectPanel } = await import('../lib/panel-snapshot.js')
  const panel = await collectPanel({ takeover: { status: async () => initialized }, awr, bindings: found, agent: agent('conv-1') })
  assert.deepEqual(asked, ['conv-1'])
  assert.equal(panel.work.project.name, 'demo', 'the work is read, not left empty until DeepSeek Harness restarts')
  const lost = await collectPanel({ takeover: { status: async () => initialized }, awr, bindings: { get: () => undefined }, agent: agent('conv-1') })
  assert.equal(lost.work, undefined, 'a store that cannot find the binding leaves the work out, as before')
})

test('the snapshot is one JSON file with the view, the work and when it was written', async () => {
  await withDirectory(async (dir) => {
    const publisher = createPanelPublisher({ takeover: fakeTakeover([stopped]), awr: idle, bindings: nobody, dir, now: () => 1234 })
    const answer = await publisher.publish(agent())
    assert.equal(answer.view.state, 'stopped')
    assert.deepEqual(await read(join(dir, 'conv-1.json')), { version: SNAPSHOT_VERSION, updatedAt: 1234, view: stopped, work: null, plugin: null })
    assert.deepEqual(await readdir(dir), ['conv-1.json'], 'no temporary file is left')
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'conv-1.json'))).mode & 0o777, 0o600, 'readable by the user only')
  })
})

test('the path is the host home, then .local/state/dsh-awr/panel, then the conversation id made safe', () => {
  assert.equal(panelDir('/Users/mac'), join('/Users/mac', '.local', 'state', 'dsh-awr', 'panel'))
  assert.equal(snapshotFileName('019f-AB_c.d'), '019f-AB_c.d.json')
  assert.equal(snapshotFileName('../../etc/passwd'), '.._.._etc_passwd.json', 'a conversation id cannot leave the directory')
  assert.equal(snapshotPath('conv-1', '/home/u'), join('/home/u', '.local', 'state', 'dsh-awr', 'panel', 'conv-1.json'))
})

test('a running takeover is written again every interval, and the writing stops when it is not running', async () => {
  await withDirectory(async (dir) => {
    const timers = fakeTimers()
    const takeover = fakeTakeover([running, running, stopped])
    const publisher = createPanelPublisher({ takeover, awr: idle, bindings: nobody, dir, intervalMs: 2000, ...timers })
    await publisher.publish(agent())
    assert.deepEqual(timers.waiting().map((timer) => timer.ms), [2000], 'running: it will write again')
    await timers.fire()
    assert.equal((await read(join(dir, 'conv-1.json'))).view.state, 'running')
    assert.deepEqual(timers.waiting().map((timer) => timer.ms), [2000])
    await timers.fire()
    assert.equal((await read(join(dir, 'conv-1.json'))).view.state, 'stopped', 'the last write is the state it ended in')
    assert.deepEqual(timers.waiting(), [], 'stopped: nothing is waiting')
    assert.equal(takeover.calls, 3)
  })
})

test('asking again while it waits does not start a second loop; stop() clears the waiting one', async () => {
  await withDirectory(async (dir) => {
    const timers = fakeTimers()
    const publisher = createPanelPublisher({ takeover: fakeTakeover([running]), awr: idle, bindings: nobody, dir, ...timers })
    await publisher.publish(agent())
    await publisher.publish(agent())
    await publisher.publish(agent())
    assert.equal(timers.waiting().length, 1, 'one loop for a conversation')
    await publisher.publish(agent('conv-2'))
    assert.equal(timers.waiting().length, 2, 'one for each conversation')
    publisher.stop()
    assert.deepEqual(timers.waiting(), [])
  })
})

test('a loop whose collecting fails stops, says why, and leaves the last file as it was', async () => {
  await withDirectory(async (dir) => {
    const timers = fakeTimers()
    const warnings = []
    let calls = 0
    const takeover = { status: async () => { calls += 1; if (calls > 1) throw new Error('awr went away'); return running } }
    const publisher = createPanelPublisher({ takeover, awr: idle, bindings: nobody, dir, warn: (message) => warnings.push(message), ...timers })
    await publisher.publish(agent())
    await timers.fire()
    assert.deepEqual(timers.waiting(), [])
    assert.match(warnings.join('\n'), /could not be refreshed: awr went away/)
    assert.equal((await read(join(dir, 'conv-1.json'))).view.state, 'running')
  })
})

test('two writes for a conversation never overtake each other', async () => {
  await withDirectory(async (dir) => {
    const releases = []
    const takeover = { status: () => new Promise((resolve) => releases.push(resolve)) }
    const publisher = createPanelPublisher({ takeover, awr: idle, bindings: nobody, dir, ...fakeTimers() })
    const first = publisher.publish(agent())
    const second = publisher.publish(agent())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releases.length, 1, 'the second waits for the first')
    releases[0]({ ...stopped, projectRoot: '/first' })
    await first
    await new Promise((resolve) => setImmediate(resolve))
    releases[1]({ ...stopped, projectRoot: '/second' })
    await second
    assert.equal((await read(join(dir, 'conv-1.json'))).view.projectRoot, '/second', 'the later answer is the one that stays')
  })
})

test('a conversation without an id cannot be written', async () => {
  await withDirectory(async (dir) => {
    const publisher = createPanelPublisher({ takeover: fakeTakeover([stopped]), awr: idle, bindings: nobody, dir })
    await assert.rejects(() => publisher.publish({}), /needs a conversation/)
    await assert.rejects(() => publisher.publish(undefined), /needs a conversation/)
    assert.deepEqual(await readdir(dir).catch(() => []), [])
  })
})

test('snapshots of conversations nobody opened for two weeks are removed, the others stay', async () => {
  await withDirectory(async (dir) => {
    const old = join(dir, 'old.json')
    const recent = join(dir, 'recent.json')
    await writeFile(old, '{}')
    await writeFile(recent, '{}')
    const longAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000)
    await utimes(old, longAgo, longAgo)
    const publisher = createPanelPublisher({ takeover: fakeTakeover([stopped]), awr: idle, bindings: nobody, dir })
    await publisher.publish(agent())
    assert.deepEqual((await readdir(dir)).sort(), ['conv-1.json', 'recent.json'])
  })
})

test('a command that changes what the panel shows writes the data again before it answers; the others do not', async () => {
  await withDirectory(async (dir) => {
    const takeover = fakeTakeover([stopped])
    const awr = {
      async run(_root, args) {
        if (args[0] === 'status') return { project_revision: 3 }
        if (args[0] === 'context') return { work_context: { context_hash: 'h' } }
        return { project_revision: 4 }
      },
    }
    const bindings = { get: async () => ({ projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } }) }
    const panel = createPanelPublisher({ takeover, awr, bindings, dir, ...fakeTimers() })
    const command = createAwrCommand({ awr, bindings, takeover: { ...takeover, start: async () => ({ started: true, message: 'Started.' }) }, panel })
    const written = async () => (await readdir(dir)).length
    for (const line of ['status', 'state', 'help', 'evidence']) {
      await command({ agent: agent(), rawInput: line })
      assert.equal(await written(), 0, `/awr ${line} writes nothing`)
    }
    await command({ agent: agent(), rawInput: 'takeover status' })
    assert.equal(await written(), 0, 'reading the takeover writes nothing')
    for (const [line, expected] of [['claim', /Claimed/], ['checkpoint did it :: next', /Checkpoint saved/], ['end ended', /Ended AWR session/], ['takeover', /Started\./]]) {
      await rm(join(dir, 'conv-1.json'), { force: true })
      const answer = await command({ agent: agent(), rawInput: line })
      assert.match(answer.text, expected, line)
      assert.equal(await written(), 1, `/awr ${line} writes the data`)
    }
  })
})

test('an error is answered as it is, and the data is still written because the state may have changed', async () => {
  await withDirectory(async (dir) => {
    const awr = { run: async () => { throw new Error('boom') } }
    const bindings = { get: async () => ({ projectRoot: '/p', sessionId: 'S1' }) }
    const takeover = fakeTakeover([stopped])
    const panel = createPanelPublisher({ takeover, awr, bindings, dir })
    const command = createAwrCommand({ awr, bindings, takeover, panel })
    const answer = await command({ agent: agent(), rawInput: 'claim W-1' })
    assert.equal(answer.kind, 'error')
    assert.deepEqual(await readdir(dir), ['conv-1.json'])
  })
})

test('failing to write the data never changes what a command answers', async () => {
  const awr = { run: async () => ({ project_revision: 3 }) }
  const bindings = { get: async () => ({ projectRoot: '/p', sessionId: 'S1', work: { key: 'W-1' } }) }
  const panel = { publish: async () => { throw new Error('disk full') } }
  const command = createAwrCommand({ awr, bindings, takeover: fakeTakeover([stopped]), panel })
  const answer = await command({ agent: agent(), rawInput: 'claim' })
  assert.equal(answer.kind, 'success')
  assert.match(answer.text, /Claimed W-1/)
})

test('a conversation whose light nobody looked at gets no file just because the agent did something', async () => {
  await withDirectory(async (dir) => {
    const publisher = createPanelPublisher({ takeover: fakeTakeover([stopped]), awr: idle, bindings: nobody, dir })
    assert.equal(await publisher.publish(agent(), { onlyIfWatched: true }), undefined)
    assert.deepEqual(await readdir(dir).catch(() => []), [], 'nothing was written')
    await publisher.publish(agent())
    const again = await publisher.publish(agent(), { onlyIfWatched: true })
    assert.equal(again.view.state, 'stopped', 'a file that exists is written again')
  })
})

test('after the agent ran awr commands that can change the work, the watched data is written again, once for a burst', async () => {
  const timers = fakeTimers()
  const written = []
  const panel = { publish: async (who, options) => { written.push(['panel', who.session.id, options]) } }
  const progress = { publish: async (who, options) => { written.push(['progress', who.session.id, options]) } }
  const onRun = refreshAfterAgent({ panel, progress, delayMs: 1500, ...timers })
  onRun(agent('c1'), ['status'])
  onRun(agent('c1'), ['ready'])
  onRun(agent('c1'), ['context', 'compile'])
  onRun(agent('c1'), ['capabilities'])
  assert.deepEqual(timers.waiting(), [], 'commands that only read start nothing')
  onRun(agent('c1'), ['work', 'claim', 'W-1'])
  assert.deepEqual(timers.waiting().map((timer) => timer.ms), [1500], 'one that can change the work does')
  onRun(agent('c1'), ['session', 'checkpoint'])
  onRun(agent('c2'), ['evidence', 'add'])
  assert.equal(timers.waiting().length, 2, 'one wait for a conversation, however many commands')
  await timers.fire()
  await timers.fire()
  assert.deepEqual(written, [
    ['panel', 'c1', { onlyIfWatched: true }], ['progress', 'c1', { onlyIfWatched: true }],
    ['panel', 'c2', { onlyIfWatched: true }], ['progress', 'c2', { onlyIfWatched: true }],
  ])
  onRun({}, ['work', 'claim'])
  onRun(undefined, ['work', 'claim'])
  assert.equal(timers.waiting().length, 0, 'without a conversation there is nothing to refresh')
})

test('a refresh that fails after the agent\'s command is nobody\'s error', async () => {
  const timers = fakeTimers()
  const onRun = refreshAfterAgent({ panel: { publish: async () => { throw new Error('disk full') } }, ...timers })
  onRun(agent('c1'), ['work', 'claim'])
  await timers.fire()
})

test('when a takeover the publisher followed is no longer running, whoever shows the work is told once', async () => {
  await withDirectory(async (dir) => {
    const timers = fakeTimers()
    const settled = []
    const publisher = createPanelPublisher({ takeover: fakeTakeover([running, running, stopped, stopped]), awr: idle, bindings: nobody, dir, onSettled: (who, view) => settled.push([who.session.id, view.state]), ...timers })
    await publisher.publish(agent())
    assert.deepEqual(settled, [], 'a publish that somebody asked for is not the end of a takeover')
    await timers.fire()
    assert.deepEqual(settled, [], 'still running')
    await timers.fire()
    assert.deepEqual(settled, [['conv-1', 'stopped']])
    await publisher.publish(agent())
    assert.deepEqual(settled, [['conv-1', 'stopped']], 'once')
  })
})
