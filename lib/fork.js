// Finds the conversation a DSH fork was made from (DSH-016).
//
// DSH does not say. A fork is made by the session controller's `fork` command: it copies the events of the source up to
// a cut, adds an end-of-seed marker and the closers of an open turn, and creates an ordinary session with the same
// `cwd`, `isSeeded: true` and `inheritedEventCount` set to the length of the copy. The child's header has no
// `parentSession` (that field is for subagents; `sessionQuery.traceSession` follows only it) and the host client says
// "the fork has no durable source relationship". The `agent/created` source is no help either: it names how the agent
// came to be (a new session or a resumed one), not where its history came from. `appendPluginRecord` would let a plugin
// write a link into the log, but it is reserved for DSH's own packages (docs/dsh-surfaces.md).
//
// What a fork does keep is the history itself: its first `inheritedEventCount` events are the very events of the source,
// with their times, ids and data. So the parent is found by content: among the other sessions of the same working
// directory, the one whose own events are that prefix. The match is by deep equality of every inherited event, never by
// a guess from names, times or order, and it must be unique, or no parent is named and the fork is bound as a new
// conversation like any other.
import { isDeepStrictEqual } from 'node:util'

/** How many of the newest sessions of the same working directory are read for a match (plus the one the prefix starts in). */
export const MAX_CANDIDATES = 10

/**
 * The length of the history a session inherited from a fork parent, or `undefined` when the session is not a fork
 * (a new or resumed conversation, or a subagent, whose header names its parent).
 *
 * @param {{ header?: { isSeeded?: boolean, parentSession?: unknown }, inheritedEventCount?: number }} session
 */
export function inheritedLength(session) {
  const header = session?.header
  if (!header || header.parentSession !== undefined || header.isSeeded !== true) return undefined
  const cut = session.inheritedEventCount
  return Number.isInteger(cut) && cut > 0 ? cut : undefined
}

const release = (lease) => {
  try {
    lease?.[Symbol.dispose]?.()
  } catch {
    // releasing a read must never fail the binding
  }
}

/**
 * The session a fork was made from, when exactly one other session of the same working directory holds the fork's
 * inherited events as its own. The parent's own history is read from `sessionQuery`, which prefers live sessions.
 *
 * Returns `{ conversationId, inherited, examined }`, or `undefined` for a session that is not a fork, a parent that is
 * not among the candidates, or a prefix that more than one candidate holds as its own. Errors from `sessionQuery`
 * are the caller's to handle (the binding treats them as "no parent found").
 *
 * @param {{ listSessions(): Promise<Array<{ header: { id: string, cwd?: string, createdAt: number } }>>, observeSession(id: string): Promise<{ events: readonly object[], inheritedEventCount: number, [Symbol.dispose]?: () => void }> }} sessionQuery
 * @param {{ id?: string, header?: object, inheritedEventCount?: number }} session
 * @param {{ maxCandidates?: number }} [options]
 */
export async function findForkParent(sessionQuery, session, { maxCandidates = MAX_CANDIDATES } = {}) {
  const inherited = inheritedLength(session)
  if (!inherited || typeof session.id !== 'string') return undefined

  const child = await sessionQuery.observeSession(session.id)
  let prefix
  try {
    prefix = child.events.slice(0, inherited)
  } finally {
    release(child)
  }
  if (prefix.length < inherited || !Number.isFinite(prefix[0]?.time)) return undefined

  const records = (await sessionQuery.listSessions())
    .filter((record) => record?.header?.id !== session.id && record.header.cwd === session.header.cwd && record.header.createdAt <= session.header.createdAt)
    .sort((a, b) => b.header.createdAt - a.header.createdAt)
  // The newest sessions are where a fork of recent work comes from. The session the prefix begins in is the newest one
  // created before the prefix's first event, which finds an old parent however many sessions came after it.
  const candidates = records.slice(0, maxCandidates)
  const origin = records.find((record) => record.header.createdAt <= prefix[0].time)
  if (origin && !candidates.includes(origin)) candidates.push(origin)

  const holders = []
  for (const record of candidates) {
    const lease = await sessionQuery.observeSession(record.header.id).catch(() => undefined)
    if (!lease) continue
    try {
      const events = lease.events
      if (events.length < inherited) continue
      // Its own: the last inherited event belongs to this session, not to an ancestor it was itself forked from.
      if (!(lease.inheritedEventCount < inherited)) continue
      if (prefix.every((event, index) => isDeepStrictEqual(event, events[index]))) holders.push(record.header.id)
    } finally {
      release(lease)
    }
  }
  if (holders.length !== 1) return undefined
  return { conversationId: holders[0], inherited, examined: candidates.length }
}

/** What the binding of a fork did, in words, for `/awr status` and the prompt. */
export function describeFork(fork) {
  if (!fork?.parentConversation) return undefined
  const parent = `DSH conversation ${fork.parentConversation}`
  switch (fork.mode) {
    case 'continued':
      return `This conversation is a fork of ${parent}. That conversation's AWR session ${fork.parentSession} had ended, so this one continues it (AWR carried its recorded context over).`
    case 'parent_active':
      return `This conversation is a fork of ${parent}, whose AWR session ${fork.parentSession} is still active. This conversation has its own AWR session and the parent's was left as it is: its progress and claims are not carried over.`
    case 'continuation_failed':
      return `This conversation is a fork of ${parent}. Continuing its ended AWR session ${fork.parentSession} failed${fork.reason ? ` (${fork.reason})` : ''}, so this conversation has its own AWR session.`
    case 'lookup_failed':
      return `This conversation is a fork of ${parent}. Reading that conversation's AWR binding failed${fork.reason ? ` (${fork.reason})` : ''}, so this conversation is bound as a new one.`
    case 'parent_unbound':
      return `This conversation is a fork of ${parent}, which was never bound to AWR, so it is bound as a new conversation.`
    default:
      return undefined
  }
}
