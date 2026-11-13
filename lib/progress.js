// The progress file the page reads (DSH-062).
//
//   <home>/.local/state/dsh-awr/panel/<conversation>.progress.json   the view of lib/progress-view.js, or { ok: false, reason }
//
// Like the panel's data (lib/panel-snapshot.js) it is a file, not a command's text, so the page can read it without leaving
// a row in the conversation. The host writes it when the page asks (`/awr progress`) and again, if the page was ever
// opened, after a command that changes the work.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { panelDir, snapshotFileName, writeFileAtomic } from './panel-snapshot.js'
import { awrHasCommand } from './takeover-cli.js'
import { buildProgress } from './progress-view.js'

export const progressFileName = (sessionId) => snapshotFileName(sessionId).replace(/\.json$/, '.progress.json')
export const progressPath = (sessionId, home) => join(panelDir(home), progressFileName(sessionId))

/**
 * @param {{ awr: { run: Function }, takeover?: { status(agent: any): Promise<object> }, installer?: { describe(): Promise<object> }, dir?: string, now?: () => number }} options
 */
export function createProgress({ awr, takeover, installer, dir = panelDir(), now = Date.now }) {
  const inflight = new Map()
  const file = (sessionId) => join(dir, progressFileName(sessionId))

  async function compute(agent, refresh) {
    const state = takeover ? await takeover.status(agent) : undefined
    const root = state?.projectRoot
    if (!root || (state.state !== 'initialized' && state.state !== 'completed')) return { ok: false, reason: 'not_managed', updatedAt: now() }
    const command = refresh ? 'overview snapshot --refresh' : 'overview snapshot'
    if (!(await awrHasCommand(awr, root, command))) {
      // The machine's awr is too old for the page: the bundled awr the plugin can install or bind is the offer
      // the page makes instead of stopping here (DSH-067).
      const runtime = installer ? await installer.describe().catch(() => undefined) : undefined
      return { ok: false, reason: 'unsupported', updatedAt: now(), ...(runtime ? { installer: runtime } : {}) }
    }
    try {
      const snapshot = await awr.run(root, ['overview', 'snapshot', ...(refresh ? ['--refresh'] : [])])
      return buildProgress(snapshot, { now: now() })
    } catch (error) {
      return { ok: false, reason: 'failed', message: String(error?.message ?? error).slice(0, 300), updatedAt: now() }
    }
  }

  return {
    file,
    /**
     * Reads AWR's snapshot of the conversation's project and writes the page's data. `refresh` has AWR synchronize the
     * project's source files first; `onlyIfWatched` does nothing unless the page has asked before.
     */
    async publish(agent, { refresh = false, onlyIfWatched = false } = {}) {
      const id = agent?.session?.id
      if (typeof id !== 'string' || !id) throw new Error('The page needs a conversation.')
      if (onlyIfWatched && !(await access(file(id)).then(() => true, () => false))) return undefined
      const key = `${id}:${refresh}`
      if (inflight.has(key)) return inflight.get(key)
      const run = (async () => {
        const view = await compute(agent, refresh)
        await writeFileAtomic(dir, progressFileName(id), view)
        return view
      })().finally(() => inflight.delete(key))
      inflight.set(key, run)
      return run
    },
  }
}
