// The data the AWR panel draws from (DSH-056).
//
// DeepSeek Harness writes every command it runs into the conversation as a row and shows the text the command
// returned; no plugin can switch that off. A panel that asked the host for its data with a command would put that
// data in the conversation, however it was dressed. So the panel does not: the host writes the data into a small file,
// and the panel reads the file through DeepSeek Harness's workspace-file service, which writes nothing anywhere. The
// only thing a `/awr panel` command leaves in the conversation is one sentence (lib/panel-text.js).
//
//   <home>/.local/state/dsh-awr/panel/<conversation>.json   { version, updatedAt, view, work, plugin }
//
// The path is worked out from the host's home directory alone, the same way here and in client.js, whatever
// DSH_AWR_STATE or XDG_STATE_HOME say about the takeover's own records: the panel cannot see the host's environment.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bindingFor } from './binding.js'
import { buildStateView } from './state-view.js'

export const SNAPSHOT_VERSION = 1
/** The directory of the snapshots below the host's home. client.js builds the same path. */
export const PANEL_DIR = ['.local', 'state', 'dsh-awr', 'panel']
/** Snapshots of conversations nobody has opened for this long are removed. */
const MAX_AGE_MS = 14 * 24 * 3600 * 1000

export const panelDir = (home = homedir()) => join(home, ...PANEL_DIR)
/** The file name of a conversation: its id with every character outside `A-Za-z0-9._-` replaced by `_`. */
export const snapshotFileName = (sessionId) => `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
export const snapshotPath = (sessionId, home = homedir()) => join(panelDir(home), snapshotFileName(sessionId))

const UNAVAILABLE = { projectRoot: null, state: 'unavailable', steps: [], stop: null, receipt: null }

/**
 * What the panel shows for a conversation: the takeover view and, for a project AWR manages, its work state.
 *
 * @param {{ takeover?: { status(agent: any): Promise<object> }, awr: { run: Function }, bindings: { get(id: string): Promise<object> | object | undefined }, agent: any, installer?: { describe(): Promise<object> } }} options
 */
export async function collectPanel({ takeover, awr, bindings, agent, installer }) {
  const view = takeover ? await takeover.status(agent) : UNAVAILABLE
  let work
  if (view.state === 'initialized' || view.state === 'completed') {
    const conversationId = agent?.session?.id
    const binding = conversationId ? await bindingFor(bindings, agent) : undefined
    if (binding?.projectRoot) work = await buildStateView(awr, binding).catch(() => undefined)
  }
  // The bundled awr the panel can offer to install or use when the machine has none or an old one (DSH-067).
  const runtime = installer ? await installer.describe().catch(() => undefined) : undefined
  return { view, work, ...(runtime ? { installer: runtime } : {}) }
}

/** Writes `payload` as `dir/name` so that a reader sees the old file or the new one, never half of it. */
export async function writeFileAtomic(dir, name, payload) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, name)
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(temp, JSON.stringify(payload), { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return file
}

const writeSnapshot = (dir, sessionId, payload) => writeFileAtomic(dir, snapshotFileName(sessionId), payload)

async function prune(dir, now) {
  try {
    for (const name of await readdir(dir)) {
      const file = join(dir, name)
      const info = await stat(file).catch(() => undefined)
      if (info && now - info.mtimeMs > MAX_AGE_MS) await rm(file, { force: true })
    }
  } catch {
    // a directory that is not there yet has nothing to prune
  }
}

/**
 * Writes the panel's data and keeps it current while a takeover runs.
 *
 * `publish(agent)` collects the data of the agent's conversation and writes it. While a takeover runs, the publisher
 * goes on writing every `intervalMs`, so the panel can read the steps as they finish without asking the host anything;
 * it stops when the takeover is no longer running, or when collecting fails (the panel then notices that the file no
 * longer changes and asks once).
 *
 * `onSettled(agent, view)` is called once when a takeover the publisher followed is no longer running.
 *
 * @param {{ takeover?: object, awr: { run: Function }, bindings: object, updater?: { describe(): Promise<object> }, installer?: { describe(): Promise<object> }, onSettled?: Function, dir?: string, intervalMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function, warn?: (message: string) => void }} options
 */
export function createPanelPublisher({ takeover, awr, bindings, updater, installer, dir = panelDir(), intervalMs = 2000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, warn, onSettled }) {
  const timers = new Map()
  const queues = new Map()
  let pruned = false

  const idOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id ? id : undefined
  }

  /** One write at a time for a conversation, so an older answer cannot land after a newer one. */
  function queue(id, task) {
    const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(task)
    queues.set(id, run)
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id) })
    return run
  }

  function schedule(id, agent) {
    if (timers.has(id)) return
    const timer = setTimer(async () => {
      timers.delete(id)
      try {
        const { view } = await publish(agent)
        // The takeover this loop followed is over: whoever shows the project's work is told once.
        if (view.state !== 'running') onSettled?.(agent, view)
      } catch (error) {
        warn?.(`The AWR panel data could not be refreshed: ${error?.message ?? error}`)
      }
    }, intervalMs)
    timer?.unref?.()
    timers.set(id, timer)
  }

  async function publish(agent, { onlyIfWatched = false } = {}) {
    const id = idOf(agent)
    if (!id) throw new Error('The panel needs a conversation.')
    // A conversation whose light nobody has looked at has no file, and gets none just because the agent did something.
    if (onlyIfWatched && !(await stat(join(dir, snapshotFileName(id))).then(() => true, () => false))) return undefined
    return queue(id, async () => {
      const { view, work, installer: runtime } = await collectPanel({ takeover, awr, bindings, agent, installer })
      if (!pruned) {
        pruned = true
        await prune(dir, now())
      }
      // What the panel shows about the plugin itself (its version and commit, the last check for a newer one).
      const plugin = await updater?.describe().catch(() => undefined)
      await writeSnapshot(dir, id, { version: SNAPSHOT_VERSION, updatedAt: now(), view, work: work ?? null, plugin: plugin ?? null, ...(runtime ? { installer: runtime } : {}) })
      if (view.state === 'running') schedule(id, agent)
      return { view, work }
    })
  }

  return {
    publish,
    /** Where the snapshot of a conversation is written. */
    file: (sessionId) => join(dir, snapshotFileName(sessionId)),
    /** Stops the periodic writing (plugin unload). */
    stop() {
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
    },
  }
}

/** The awr commands that can change what the interface shows; the rest only read. */
const CHANGING = new Set(['work', 'session', 'evidence', 'proposal', 'batch', 'document', 'host', 'organization', 'branch', 'event', 'execution', 'source', 'intake', 'init', 'decision', 'spec', 'artifact'])

/**
 * After the agent ran an awr command that can change the work, the data of the surfaces that are being looked at is
 * written again, once per conversation for a burst of commands (`delayMs` after the last one).
 *
 * @param {{ panel?: { publish: Function }, progress?: { publish: Function }, delayMs?: number, setTimer?: Function, clearTimer?: Function }} options
 * @returns {(agent: any, words: string[]) => void} for `registerAwrTools({ onRun })`
 */
export function refreshAfterAgent({ panel, progress, delayMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = new Map()
  return (agent, words) => {
    const id = agent?.session?.id
    if (typeof id !== 'string' || !CHANGING.has(String(words?.[0]))) return
    if (waiting.has(id)) clearTimer(waiting.get(id))
    const timer = setTimer(() => {
      waiting.delete(id)
      panel?.publish(agent, { onlyIfWatched: true }).catch(() => {})
      progress?.publish(agent, { onlyIfWatched: true }).catch(() => {})
    }, delayMs)
    timer?.unref?.()
    waiting.set(id, timer)
  }
}
