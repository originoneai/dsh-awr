// The data the AWR panel draws from (DSH-056).
//
// DeepSeek Harness writes every command it runs into the conversation as a row and shows the text the command
// returned; no plugin can switch that off. A panel that asked the host for its data with a command would put that
// data in the conversation, however it was dressed. So the panel does not: the host writes the data into a small file,
// and the panel reads the file through DeepSeek Harness's workspace-file service, which writes nothing anywhere. The
// only thing a `/awr panel` command leaves in the conversation is one sentence (lib/panel-text.js).
//
//   <home>/.local/state/dsh-awr/panel/<conversation>.json   { version, updatedAt, view, work }
//
// The path is worked out from the host's home directory alone, the same way here and in client.js, whatever
// DSH_AWR_STATE or XDG_STATE_HOME say about the takeover's own records: the panel cannot see the host's environment.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * @param {{ takeover?: { status(agent: any): Promise<object> }, awr: { run: Function }, bindings: { get(id: string): Promise<object> | object | undefined }, agent: any }} options
 */
export async function collectPanel({ takeover, awr, bindings, agent }) {
  const view = takeover ? await takeover.status(agent) : UNAVAILABLE
  let work
  if (view.state === 'initialized' || view.state === 'completed') {
    const conversationId = agent?.session?.id
    const binding = conversationId ? await bindings.get(conversationId) : undefined
    if (binding?.projectRoot) work = await buildStateView(awr, binding).catch(() => undefined)
  }
  return { view, work }
}

async function writeSnapshot(dir, sessionId, payload) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, snapshotFileName(sessionId))
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
 * @param {{ takeover?: object, awr: { run: Function }, bindings: object, dir?: string, intervalMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function, warn?: (message: string) => void }} options
 */
export function createPanelPublisher({ takeover, awr, bindings, dir = panelDir(), intervalMs = 2000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, warn }) {
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
        await publish(agent)
      } catch (error) {
        warn?.(`The AWR panel data could not be refreshed: ${error?.message ?? error}`)
      }
    }, intervalMs)
    timer?.unref?.()
    timers.set(id, timer)
  }

  async function publish(agent) {
    const id = idOf(agent)
    if (!id) throw new Error('The panel needs a conversation.')
    return queue(id, async () => {
      const { view, work } = await collectPanel({ takeover, awr, bindings, agent })
      if (!pruned) {
        pruned = true
        await prune(dir, now())
      }
      await writeSnapshot(dir, id, { version: SNAPSHOT_VERSION, updatedAt: now(), view, work: work ?? null })
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
