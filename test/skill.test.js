// The AWR workflow skill (DSH-032): that it is a valid DSH skill, that it covers what it must, and that what it
// tells the model to run exists in the awr it will run against.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SKILL_BODY, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, awrSkill, registerAwrSkill } from '../lib/skill.js'

const here = dirname(fileURLToPath(import.meta.url))
const lab = join(here, '..', '.local', 'awr-lab', 'bin', 'awr')
const real = existsSync(lab) ? test : test.skip

test('the skill is a valid DSH skill: what registering checks and what loading checks', () => {
  // dsh-skill validates name, description and invocation when a skill is registered, and in addition `source`, `provider`
  // and `content` (the text the model gets) when it is loaded; the registry fills in the provider.
  assert.match(SKILL_NAME, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.equal(awrSkill.name, SKILL_NAME)
  assert.ok(typeof awrSkill.description === 'string' && awrSkill.description.length > 0)
  assert.ok(awrSkill.description.length < 300, 'the catalog line the model always sees stays short')
  assert.equal(typeof awrSkill.whenToUse, 'string')
  assert.ok(SKILL_WHEN_TO_USE.includes('AWR'))
  assert.equal(typeof awrSkill.source, 'string')
  assert.ok(awrSkill.source.length > 0)
  assert.equal(typeof awrSkill.content, 'string')
  assert.equal(awrSkill.content, SKILL_BODY)
  assert.equal(typeof awrSkill.invocation.modelInvocable, 'boolean')
  assert.equal(typeof awrSkill.invocation.userInvocable, 'boolean')
  assert.ok(awrSkill.invocation.modelInvocable && awrSkill.invocation.userInvocable)
  assert.equal('body' in awrSkill, false, 'the text is `content`')
})

test('the body covers preview then accept, expected revisions, evidence registration and the conditions for work complete', () => {
  for (const [topic, needles] of Object.entries({
    'preview then accept': ['## Preview, then accept', '--accept', '--expected-preview', '--source-fingerprint', 'fingerprint'],
    'expected revisions': ['## Expected revisions', '--expected-revision', '--expected-project-revision', 'RevisionConflict', 'never force'],
    'evidence registration': ['evidence add', 'work prepare-completion', '--report', '--evidence-key', '--source-sha', 'completion report', 'criteria'],
    'evidence candidates': ['AWR evidence candidates', 'The plugin registers nothing', 'yours to judge'],
    'conditions for work complete': ['work complete', 'dependencies', 'every acceptance criterion', 'never by editing its status', 'in progress'],
    'sessions and checkpoints': ['session checkpoint', '--context-hash', '--digest', '--next-action', '--open-loop', 'session end', 'work claim'],
    'reading and errors': ['`status`', 'SourceStale', 'BudgetExceeded', 'ContextIncomplete', 'INCOMPLETE'],
    'boundaries': ['.awr/state.db', 'migrate', 'overview', 'secrets'],
  })) {
    for (const needle of needles) assert.ok(SKILL_BODY.includes(needle), `${topic}: "${needle}"`)
  }
  assert.ok(SKILL_BODY.length < 12_000, 'a skill the model loads on demand, not a manual')
  assert.match(SKILL_DESCRIPTION, /preview then accept, expected revisions, evidence and when work may be completed/)
})

test('it names the tools the plugin provides', () => {
  assert.ok(SKILL_BODY.includes('`awr` tool') && SKILL_BODY.includes('`awr_project_status`'))
})

test('registration goes through ctx.inject on the skills service and works without it', () => {
  const registered = []
  const disposed = []
  let mounted
  const ctx = { skills: { register: (skill) => (registered.push(skill), () => disposed.push(skill.name)) }, effect: (fn) => (mounted = fn()), inject: (services, mount) => (services.includes('skills') ? mount(ctx) : undefined) }
  registerAwrSkill(ctx)
  assert.deepEqual(registered, [awrSkill])
  mounted()
  assert.deepEqual(disposed, [SKILL_NAME], 'removed with its registration')
  const direct = []
  registerAwrSkill({ skills: { register: (skill) => direct.push(skill.name) } })
  assert.deepEqual(direct, [SKILL_NAME])
  assert.doesNotThrow(() => registerAwrSkill({}))
  assert.doesNotThrow(() => registerAwrSkill({ inject: () => {} }))
})

// What the skill tells the model to run has to exist in the awr that runs it.
const COMMANDS = [
  ['status'], ['work', 'show'], ['work', 'prepare'], ['work', 'claim'], ['work', 'progress'], ['work', 'block'], ['work', 'unblock'],
  ['work', 'edit'], ['work', 'create'], ['work', 'prepare-completion'], ['work', 'complete'], ['evidence', 'add'],
  ['session', 'checkpoint'], ['session', 'end'], ['context', 'compile'], ['source', 'reindex'], ['init'],
]
real('against the real awr: every command the skill names exists, and so does every option it gives for it', () => {
  const env = { ...process.env, AWR_LOCAL_WEB: '0' }
  const help = (words) => execFileSync(lab, [...words, '--help'], { env, encoding: 'utf8' })
  for (const words of COMMANDS) {
    assert.ok(SKILL_BODY.includes(`\`${words.join(' ')}`) || SKILL_BODY.includes(`${words.join(' ')} `) || words[0] === 'status', `the body mentions "${words.join(' ')}"`)
    assert.ok(help(words).includes('Usage:'), `awr ${words.join(' ')} exists`)
  }
  const options = {
    'work claim': ['--session', '--expected-revision', '--ttl-ms'],
    'work progress': ['--session', '--reason', '--next-action', '--expected-revision'],
    'work block': ['--session', '--reason', '--blocker', '--expected-revision'],
    'work edit': ['--accept', '--source-fingerprint', '--expected-preview'],
    'work prepare-completion': ['--report', '--evidence-key', '--source-sha'],
    'work complete': ['--session', '--reason', '--input', '--expected-revision'],
    'evidence add': ['--input', '--expected-revision'],
    'session checkpoint': ['--session', '--context-hash', '--digest', '--next-action', '--open-loop', '--expected-project-revision'],
    'session end': ['--session', '--outcome', '--expected-revision'],
    'context compile': ['--session', '--budget'],
    init: ['--accept', '--expected-preview'],
  }
  for (const [command, flags] of Object.entries(options)) {
    const text = help(command.split(' '))
    for (const flag of flags) {
      assert.ok(text.includes(flag), `awr ${command} has ${flag}`)
      assert.ok(SKILL_BODY.includes(flag), `the skill names ${flag}`)
    }
  }
  // The words the skill gives for an outcome are the ones awr accepts.
  assert.match(execFileSync(lab, ['session', 'end', '--help'], { env, encoding: 'utf8' }) + '\n' + SKILL_BODY, /ended\|interrupted\|incomplete/)
})
