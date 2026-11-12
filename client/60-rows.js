// The rows of `/awr` commands in the conversation.
//
// DeepSeek Harness draws a row for every command and shows the text it returned. The plugin draws its own rows instead
// (the `conversation.chat.commandview` slot, keyed by the command's name), so that the conversation holds what a person
// can read and nothing else:
//
// - What the plugin's own interface ran is not drawn at all, whether it succeeded or not: its questions (`/awr panel`,
//   `/awr progress`, anything asked with `--json`) and the commands behind its buttons (`--ui`). The light, the card and
//   the progress page show what happened; the conversation does not need a second copy. Rows of that kind from before
//   this version disappear the same way.
// - A command a person typed is one quiet line: the first line of the answer, which the host writes for people. The lines
//   after it (identifiers, revisions, AWR's own messages) are folded under it until someone opens them.
// - An answer written by an earlier version of the plugin, which started with identifiers, gets a plain sentence in
//   front of it and is folded whole.

/** Whether a command came from the plugin's own interface, not from something a person typed. */
function isInternal(args, text) {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = words[0] ?? 'status'
  if (sub === 'panel' || sub === 'progress') return true
  if (words.includes('--ui') || words.includes('--json')) return true
  // Answers of earlier versions: raw JSON, or a sentence with the panel's data in a comment after it.
  const answer = String(text ?? '').trimStart()
  return answer.startsWith('{') || answer.includes('<!--awr-panel:')
}

const LEGACY = [
  [/^Started the takeover of /, 'legacy.takeover.started'],
  [/^Resumed the takeover of /, 'legacy.takeover.resumed'],
  [/^Claimed \S+ for AWR session /, 'legacy.claimed'],
  [/^Checkpoint saved for AWR session /, 'legacy.checkpoint'],
  [/^Ended AWR session /, 'legacy.ended'],
]
const LEGACY_FAILURE = /^(AWR for |Name the work to claim|The takeover could not be started: |AWR command failed: |This conversation has no AWR session|awr returned no context hash)/

/** The plain sentence for an answer an earlier version wrote, or undefined for an answer of this version. */
function legacySentence(first, failed, t) {
  const known = LEGACY.find(([pattern]) => pattern.test(first))
  if (known) return t(known[1])
  return failed && LEGACY_FAILURE.test(first) ? t('legacy.failed') : undefined
}

function AwrRow(props) {
  const ctx = props.__ctx
  const node = props.node ?? {}
  const t = React.useMemo(() => translator(ctx), [ctx])
  const [open, setOpen] = React.useState(false)
  const outcome = node.outcome ?? null
  const text = String(outcome?.text ?? '')
  const failed = outcome?.kind === 'error'
  if (isInternal(node.args, text)) return h('span', { 'data-awr-row': 'hidden', hidden: true })
  const raw = text.split('\n')
  // `/awr status` of earlier versions started with the project's identifier and revision; its second line is the one
  // a person reads.
  const lines = raw.length > 1 && /^Project \S+, revision \d+$/.test(raw[0].trim()) ? [raw[1], ...raw] : raw
  const legacy = legacySentence(lines[0].trim(), failed, t)
  const first = legacy ?? lines[0].trim()
  const rest = (legacy ? text : lines.slice(1).join('\n')).trim()
  const summary = outcome === null ? t('row.running') : first || (failed ? t('row.failed') : t('row.done'))
  const foldable = rest.length > 0
  return h('div', { 'data-awr-row': failed ? 'error' : 'line', style: { display: 'flex', flexDirection: 'column' } },
    h(foldable ? 'button' : 'div', {
      ...(foldable ? { type: 'button', 'aria-expanded': open, 'data-open': String(open), onClick: () => setOpen(!open) } : {}),
      className: 'awr-rowline',
      'data-testid': 'awr-row',
    },
    h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', color: C.text3 } },
      h(Icon, { name: 'node', size: 14, className: outcome === null ? 'awr-pulse' : undefined }), t('row.label')),
    h('span', { 'aria-hidden': true, style: { flex: 'none', width: 2, height: 2, margin: '0 8px', borderRadius: 1, background: C.faint } }),
    h('span', { className: 'awr-clamp1', 'data-testid': 'awr-row-summary', style: { minWidth: 0, flex: '0 1 auto', color: failed ? C.bad : C.text2 } }, summary),
    foldable ? h(Icon, { name: 'chevron', size: 12, className: 'awr-chev', style: { marginLeft: 4, color: C.text3 } }) : null),
    open && foldable ? h('pre', { 'data-testid': 'awr-row-details', 'aria-label': t('row.details'), style: { maxHeight: 260, margin: '4px 0 4px 4px', padding: '12px 16px', overflow: 'auto', border: `.5px solid ${C.line}`, borderRadius: 'var(--dsw-radius-lg, 16px)', background: C.code, color: failed ? C.bad : C.text, font: 'var(--dsw-font-markdown-code-block-small, 12px/18px ui-monospace, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, rest) : null)
}
