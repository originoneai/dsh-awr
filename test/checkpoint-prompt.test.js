// The end-of-turn checkpoint request (DSH-030): when it is made, what it says, and what it never does.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkpointRequest, createCheckpointPrompter, registerCheckpointPrompts, requestMessage } from '../lib/checkpoint-prompt.js'

const bound = { projectRoot: '/p', outcome: 'created', sessionId: 'S1', work: { key: 'W-1' } }
const bindingsOf = (map) => ({ get: (id) => (map[id] ? Promise.resolve(map[id]) : undefined) })
const agentWith = (id = 'c1') => {
  const steered = []
  return { steered, session: { id }, steer: (message) => steered.push(message) }
}
const toolCall = (agent, name, args, isError = false) => [{ agent, name, arguments: args }, { isError }]

function prompterWith(options = {}) {
  let clock = 1_000_000
  const traces = []
  const prompter = createCheckpointPrompter({ bindings: bindingsOf({ c1: bound, c2: { ...bound, sessionId: 'S2' } }) }, { now: () => clock, trace: (e) => traces.push(e), ...options })
  return { prompter, traces, advance: (ms) => (clock += ms) }
}

test('a turn that wrote, edited or ran something is asked for a checkpoint, once, with the session id', async () => {
  for (const tool of ['write', 'edit', 'bash']) {
    const { prompter } = prompterWith()
    const agent = agentWith()
    prompter.observe(...toolCall(agent, tool, {}))
    assert.equal(await prompter.stopping({ agent, turn: 1 }), 'asked', tool)
    assert.equal(agent.steered.length, 1)
    const message = agent.steered[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'dsh-awr')
    assert.match(message.id, /^[0-9a-f-]{36}$/)
    assert.match(message.content[0].text, /AWR checkpoint request/)
    assert.match(message.content[0].text, /session S1/)
    assert.match(message.content[0].text, /context compile --session S1/)
    assert.match(message.content[0].text, /session checkpoint --session S1 --context-hash/)
    // The checkpoint step is part of the same turn: its stop does not ask again.
    assert.equal(await prompter.stopping({ agent, turn: 1 }), 'already_asked')
    assert.equal(agent.steered.length, 1)
  }
})

test('a turn that only read is not meaningful until it made enough tool calls, and awr\'s own tools do not count', async () => {
  const { prompter } = prompterWith({ minTools: 3 })
  const agent = agentWith()
  prompter.observe(...toolCall(agent, 'read', {}))
  prompter.observe(...toolCall(agent, 'glob', {}))
  prompter.observe(...toolCall(agent, 'awr_project_status', {}))
  prompter.observe(...toolCall(agent, 'awr', { args: ['status'] }))
  assert.equal(await prompter.stopping({ agent, turn: 1 }), 'not_meaningful')
  prompter.observe(...toolCall(agent, 'read', {}))
  prompter.observe(...toolCall(agent, 'grep', {}))
  prompter.observe(...toolCall(agent, 'read', {}))
  assert.equal(await prompter.stopping({ agent, turn: 2 }), 'asked', 'three tool calls make a turn meaningful')
  const quiet = agentWith()
  assert.equal(await prompter.stopping({ agent: quiet, turn: 1 }), 'not_meaningful', 'a turn with no tool calls')
  assert.deepEqual(quiet.steered, [])
})

test('counters belong to one turn: work in one turn does not make the next one meaningful', async () => {
  const { prompter } = prompterWith({ cooldownMs: 0 })
  const agent = agentWith()
  prompter.observe(...toolCall(agent, 'bash', {}))
  assert.equal(await prompter.stopping({ agent, turn: 1 }), 'asked')
  assert.equal(await prompter.stopping({ agent, turn: 1 }), 'already_asked')
  assert.equal(await prompter.stopping({ agent, turn: 2 }), 'not_meaningful')
  prompter.observe(...toolCall(agent, 'edit', {}))
  assert.equal(await prompter.stopping({ agent, turn: 3 }), 'asked')
})

test('no request when the model saved a checkpoint during the turn, or within the cooldown; a failed one does not count', async () => {
  const { prompter, advance } = prompterWith({ cooldownMs: 60_000 })
  const agent = agentWith()
  prompter.observe(...toolCall(agent, 'bash', {}))
  prompter.observe(...toolCall(agent, 'awr', { args: ['session', 'checkpoint', '--session', 'S1'] }, true))
  assert.equal(await prompter.stopping({ agent, turn: 1 }), 'asked', 'a checkpoint that failed is not a checkpoint')
  assert.equal(await prompter.stopping({ agent, turn: 1 }), 'already_asked')

  prompter.observe(...toolCall(agent, 'bash', {}))
  prompter.observe(...toolCall(agent, 'awr', { args: ['session', 'checkpoint', '--session', 'S1'] }))
  assert.equal(await prompter.stopping({ agent, turn: 2 }), 'checkpointed_in_turn')

  advance(30_000)
  prompter.observe(...toolCall(agent, 'bash', {}))
  assert.equal(await prompter.stopping({ agent, turn: 3 }), 'checkpointed_recently')
  advance(61_000)
  prompter.observe(...toolCall(agent, 'bash', {}))
  assert.equal(await prompter.stopping({ agent, turn: 4 }), 'asked', 'after the cooldown')
  assert.equal(agent.steered.length, 2)
})

test('an unbound conversation, one whose binding failed, and an agent that cannot be steered are left alone', async () => {
  const { prompter } = prompterWith()
  const none = agentWith('nobody')
  prompter.observe(...toolCall(none, 'bash', {}))
  assert.equal(await prompter.stopping({ agent: none, turn: 1 }), 'not_bound')
  assert.deepEqual(none.steered, [])
  const failedBindings = createCheckpointPrompter({ bindings: bindingsOf({ f: { projectRoot: '/p', outcome: 'failed', message: 'x' } }) })
  const failed = agentWith('f')
  failedBindings.observe(...toolCall(failed, 'bash', {}))
  assert.equal(await failedBindings.stopping({ agent: failed, turn: 1 }), 'not_bound')
  const mute = { session: { id: 'c1' } }
  prompter.observe(...toolCall(mute, 'bash', {}))
  assert.equal(await prompter.stopping({ agent: mute, turn: 1 }), 'cannot_steer')
  assert.equal(await prompter.stopping({}), 'no_agent')
  assert.equal(await prompter.stopping(undefined), 'no_agent')
})

test('conversations keep their own counters, and a failure in steering or in observing never reaches DSH', async () => {
  const { prompter } = prompterWith()
  const a = agentWith('c1')
  const b = agentWith('c2')
  prompter.observe(...toolCall(a, 'bash', {}))
  assert.equal(await prompter.stopping({ agent: b, turn: 1 }), 'not_meaningful')
  assert.equal(await prompter.stopping({ agent: a, turn: 1 }), 'asked')
  const warnings = []
  const broken = createCheckpointPrompter({ bindings: bindingsOf({ c1: bound }) }, { warn: (m) => warnings.push(m) })
  const angry = { session: { id: 'c1' }, steer: () => { throw new Error('inbox closed') } }
  broken.observe(...toolCall(angry, 'bash', {}))
  assert.equal(await broken.stopping({ agent: angry, turn: 1 }), 'error')
  assert.match(warnings[0], /inbox closed/)
  assert.doesNotThrow(() => broken.observe(undefined, undefined))
  assert.doesNotThrow(() => broken.observe({}, {}))
  const throwingBindings = createCheckpointPrompter({ bindings: { get: () => { throw new Error('lost') } } }, { warn: () => {} })
  throwingBindings.observe(...toolCall(a, 'bash', {}))
  assert.equal(await throwingBindings.stopping({ agent: a, turn: 1 }), 'error')
})

test('what the request says: instructions for the model, with nothing written for it', () => {
  const text = checkpointRequest({ sessionId: 'S9' })
  assert.match(text, /Write the digest, the next action and the open loops yourself, from what happened in this conversation/)
  assert.match(text, /Do not complete or end anything/)
  // The placeholders are the model's to fill; the request holds no digest, next action or open loop of its own.
  assert.match(text, /--digest "<what was done>" --next-action "<what comes next>" --open-loop "<anything unfinished>"/)
  assert.doesNotMatch(text, /--digest "[^<]/)
  assert.deepEqual(requestMessage('x').content, [{ type: 'text', text: 'x' }])
  assert.throws(() => { requestMessage('x').role = 'assistant' }, TypeError, 'frozen like DSH\'s own messages')
})

// --- registration and what the plugin never does ----------------------------------------------------------------------

function fakeContext() {
  const listeners = {}
  return { listeners, ctx: { on: (event, fn) => ((listeners[event] ??= []).push(fn), () => {}), logger: { warn: () => {} } } }
}

test('the listeners observe tool results and ask at turn-stopping, and a disabled prompter registers nothing', async () => {
  const { ctx, listeners } = fakeContext()
  const traces = []
  registerCheckpointPrompts(ctx, { bindings: bindingsOf({ c1: bound }), trace: (e) => traces.push(e) })
  assert.deepEqual(Object.keys(listeners).sort(), ['agent/disposed', 'agent/turn-stopping', 'tools/result'])
  const agent = agentWith()
  listeners['tools/result'][0]({ agent, name: 'bash', arguments: {} }, { isError: false })
  await listeners['agent/turn-stopping'][0]({ agent, turn: 4 })
  assert.equal(agent.steered.length, 1)
  assert.deepEqual(traces.map((t) => t.event), ['checkpoint-requested', 'checkpoint-decision'])
  assert.equal(traces[1].outcome, 'asked')
  const off = fakeContext()
  assert.equal(registerCheckpointPrompts(off.ctx, { bindings: bindingsOf({}), enabled: false }), undefined)
  assert.deepEqual(off.listeners, {})
})

test('the plugin never runs awr at a turn boundary, so the checkpoint is the model\'s and not the plugin\'s', async () => {
  const awrCalls = []
  const awr = { run: async (...args) => (awrCalls.push(args), {}) }
  void awr // not handed to the prompter at all: it has no way to run awr
  const { prompter } = prompterWith()
  const agent = agentWith()
  prompter.observe(...toolCall(agent, 'bash', {}))
  await prompter.stopping({ agent, turn: 1 })
  assert.deepEqual(awrCalls, [])
  assert.equal(createCheckpointPrompter.length, 1, 'its only dependency is the binding lookup')
})

test('disposing a conversation does not touch its AWR session: no awr call, and nothing in the plugin builds a session end or a work complete by itself', async () => {
  // 1. The listeners for disposal only forget.
  const { ctx, listeners } = fakeContext()
  registerCheckpointPrompts(ctx, { bindings: bindingsOf({ c1: bound }) })
  const agent = agentWith()
  listeners['tools/result'][0]({ agent, name: 'bash', arguments: {} }, {})
  assert.doesNotThrow(() => listeners['agent/disposed'].forEach((fn) => fn({ agent })))
  assert.doesNotThrow(() => listeners['agent/disposed'].forEach((fn) => fn(undefined)))
  // 2. Structurally: the words that end a session or complete work appear in the library only in what the user types
  //    (commands.js), what the model is told (skill.js, tools.js refusing words) and the takeover's own stop reasons.
  const lib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  for (const file of readdirSync(lib).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(join(lib, file), 'utf8')
    const buildsSessionEnd = /\[\s*'session'\s*,\s*'end'/.test(text)
    const buildsComplete = /\[\s*'work'\s*,\s*'complete'/.test(text)
    if (file === 'commands.js') {
      assert.ok(buildsSessionEnd, 'the user\'s /awr end is built there')
      assert.ok(!buildsComplete, '/awr never completes work')
    } else {
      assert.ok(!buildsSessionEnd && !buildsComplete, `${file} builds no session end or work complete`)
    }
  }
})
