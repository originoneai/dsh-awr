// The data of the surfaces, read from the files the host writes.
//
// A command is a row in the conversation; reading a file is not. So the surfaces read, and run a command only when a
// file cannot do it: when it is missing or old, when someone asks for a refresh, or when a takeover that should be
// moving has stopped changing its file. The plugin's own questions (`/awr panel`, `/awr progress`) are not drawn in
// the conversation at all (60-rows.js).

// The light in the header and the progress page show the same project. What one of them reads, the other shows too:
// the state of a conversation's project is kept once, for every surface of that conversation that is on screen.
const projectStates = new Map()
function projectStateOf(sessionId) {
  let store = projectStates.get(sessionId)
  if (!store) projectStates.set(sessionId, (store = { data: undefined, listeners: new Set() }))
  return store
}

/**
 * The state of the conversation's project for the header light and its popover: `{ view, work, plugin }` as the host
 * wrote them (lib/panel-snapshot.js).
 *
 * @param {boolean} watching whether a surface is showing the data (an open popover, the progress page)
 */
function useProjectState(ctx, sessionId, t, watching) {
  const language = languageOf(t)
  const [data, setData] = React.useState(() => projectStateOf(sessionId).data)
  const [error, setError] = React.useState(undefined)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const store = projectStateOf(sessionId)
    const listener = (payload) => setData(payload)
    store.listeners.add(listener)
    if (store.data) setData(store.data)
    return () => {
      store.listeners.delete(listener)
      if (store.listeners.size === 0) projectStates.delete(sessionId)
    }
  }, [sessionId])

  const apply = React.useCallback((payload) => {
    if (!payload?.view) throw new Error('the project data has no view')
    const store = projectStateOf(sessionId)
    store.data = payload
    for (const listener of [...store.listeners]) listener(payload)
    setError(undefined)
  }, [sessionId])
  // Ask the host to write the file, then read it.
  const refresh = React.useCallback(async () => {
    try {
      await runCommand(ctx, sessionId, '/awr panel', language)
      apply(await readData(ctx, sessionId, ''))
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    }
  }, [ctx, sessionId, language, apply])
  // Read the file; ask the host to write it first when it is missing, older than `since` or older than `maxAge` (the
  // two ages are only compared on this machine, where the clocks are the same one).
  const reload = React.useCallback(async ({ since, maxAge } = {}) => {
    let payload
    try {
      payload = await readData(ctx, sessionId, '')
    } catch {
      payload = undefined
    }
    const local = isLocal(ctx)
    const old = payload && ((local && since !== undefined && payload.updatedAt < since) || (local && maxAge !== undefined && Date.now() - payload.updatedAt > maxAge))
    if (!payload?.view || old) return refresh()
    apply(payload)
    return undefined
  }, [ctx, sessionId, apply, refresh])

  // The light shows what the file says as soon as the header is there, without asking the host anything.
  React.useEffect(() => {
    let live = true
    readData(ctx, sessionId, '').then((payload) => { if (live && payload?.view) apply(payload) }, () => {})
    return () => { live = false }
  }, [ctx, sessionId, apply])

  // A surface that starts showing the data takes a file written in the last 30 s as current.
  React.useEffect(() => {
    if (watching) reload({ maxAge: 30000 })
  }, [watching, reload])

  // While a surface shows a running takeover, read the file every 2.5 s: the host writes it as the steps finish. A file
  // that has not changed for 12 s means the host stopped writing, so the host is asked once and the reading goes on.
  const state = data?.view?.state
  const seen = React.useRef({ at: undefined, same: 0 })
  React.useEffect(() => {
    if (!watching || state !== 'running') return undefined
    let live = true
    let timer
    const poll = async () => {
      try {
        const payload = await readData(ctx, sessionId, '')
        if (!live) return
        seen.current.same = payload.updatedAt === seen.current.at ? seen.current.same + 1 : 0
        seen.current.at = payload.updatedAt
        if (seen.current.same >= 5) {
          seen.current.same = 0
          await refresh()
        } else {
          apply(payload)
        }
      } catch (failure) {
        if (live) setError(String(failure?.message ?? failure))
      }
      if (live) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [watching, state, ctx, sessionId, apply, refresh])

  /** Runs a command the person asked for, then reads what the host wrote with it. Returns the host's sentence. */
  const act = React.useCallback(async (line) => {
    setBusy(true)
    try {
      const since = Date.now()
      const text = await runCommand(ctx, sessionId, line, language)
      await reload({ since })
      return text
    } finally {
      setBusy(false)
    }
  }, [ctx, sessionId, language, reload])

  return { data, error, busy, refresh, reload, act, language }
}

/**
 * The project's progress for the page (lib/progress.js): the view of lib/progress-view.js, or `{ ok: false, reason }`.
 * `enabled` is false until AWR manages the project, when there is nothing to read.
 */
function useProgress(ctx, sessionId, language, enabled) {
  const [progress, setProgress] = React.useState(undefined)
  const [error, setError] = React.useState(undefined)
  const [working, setWorking] = React.useState(undefined)

  const read = React.useCallback(async () => {
    const payload = await readData(ctx, sessionId, '.progress')
    // A view written by another version of the plugin is treated as no view: the host is asked to write it again.
    if (typeof payload?.ok !== 'boolean' || (payload.ok && (payload.schema !== 1 || !Array.isArray(payload.nodes) || !Array.isArray(payload.lanes)))) throw new Error('the progress data is not a view this version reads')
    setProgress((current) => (current && current.updatedAt === payload.updatedAt ? current : payload))
    setError(undefined)
    return payload
  }, [ctx, sessionId])
  /** Asks the host to write the file again (`sync` has AWR read the project's files first), then reads it. */
  const ask = React.useCallback(async (sync = false) => {
    setWorking(sync ? 'sync' : 'refresh')
    try {
      await runCommand(ctx, sessionId, sync ? '/awr progress refresh' : '/awr progress', language)
      await read()
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally {
      setWorking(undefined)
    }
  }, [ctx, sessionId, language, read])

  React.useEffect(() => {
    if (!enabled) return undefined
    let live = true
    let timer
    let asked = Date.now()
    const start = async () => {
      let payload
      try {
        payload = await read()
      } catch {
        payload = undefined
      }
      // A view from the last minute is current. An older one, none, or a file that says why there was nothing to draw
      // (the project was not managed a moment ago, say) makes the host write it.
      if (live && (!payload?.ok || !isLocal(ctx) || Date.now() - payload.updatedAt > 60000)) await ask(false)
    }
    // Reading is silent, so it is done often; the host is asked again once a minute while the page is in view.
    const tick = async () => {
      if (!live) return
      if (typeof document === 'undefined' || !document.hidden) {
        if (Date.now() - asked > 60000) {
          asked = Date.now()
          await ask(false)
        } else {
          await read().catch(() => {})
        }
      }
      if (live) timer = setTimeout(tick, 5000)
    }
    start().finally(() => { if (live) timer = setTimeout(tick, 5000) })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled, ctx, sessionId, read, ask])

  return { progress, error, working, ask }
}
