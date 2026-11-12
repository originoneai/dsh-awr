// What the three surfaces share: the host's theme tokens, the state light, a few controls, and the way to reach the host.
//
// The plugin is part of DeepSeek Harness's interface, so every colour is one of the host's `--dsw-alias-*` tokens (the
// value after the comma is only what shows if a token is ever renamed), the type and radius steps are the host's, and
// the controls are written here to look and behave like the host's own.

const STEPS = ['preflight', 'preview', 'review', 'accept', 'organize', 'receipt']

const C = {
  text: 'var(--dsw-alias-label-primary, #17191c)',
  text2: 'var(--dsw-alias-label-secondary, #4d535c)',
  text3: 'var(--dsw-alias-label-tertiary, #6b727d)',
  faint: 'var(--dsw-alias-label-caption, #a0a6b0)',
  surface: 'var(--dsw-alias-bg-base, #fff)',
  raised: 'var(--dsw-alias-card-fill, #fafafa)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))',
  active: 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  line2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
  line3: 'var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
  selected: 'var(--dsw-alias-border-selected, #8b93a1)',
  ink: 'var(--dsw-alias-button-primary-fill, #17191c)',
  inkHover: 'var(--dsw-alias-button-primary-hover, #3a3f47)',
  onInk: 'var(--dsw-alias-label-primary-inverted, #fff)',
  live: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  liveSoft: 'var(--dsw-alias-state-business-tertiary, #e8ecff)',
  good: 'var(--dsw-alias-state-success-primary, #1fa35c)',
  warn: 'var(--dsw-alias-state-warn-primary, #e0940a)',
  bad: 'var(--dsw-alias-state-error-primary, #d93025)',
  idle: 'var(--dsw-alias-state-idle-primary, #c7cbd1)',
  menu: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
  code: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.03))',
  mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
  ease: 'var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1))',
}

/** The colour of a work state. One meaning everywhere: the header light, the rows, the cards, the gauge. */
const STATE_COLOR = { active: C.live, blocked: C.bad, waiting: C.warn, ready: C.text3, planned: C.idle, done: C.text, cancelled: C.faint, good: C.good }
/** The order a person looks at work in: what moves, what is stuck, what could start, what waits, what is not begun. */
const STATE_ORDER = ['active', 'blocked', 'ready', 'waiting', 'planned', 'done', 'cancelled']

// Pseudo-classes, keyframes and the one `:has()` rule cannot be inline styles. The plugin installs this once.
// The last rule takes the 4px a conversation item keeps above itself away from an item whose row is not drawn
// (60-rows.js), so that rows which are not shown leave no gap. If the host renames the attribute, a small gap is all
// that comes back.
const CSS = `
.awr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:32px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,8px);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;outline-offset:2px;transition:background-color .12s ${C.ease},color .12s ${C.ease},opacity .12s ${C.ease},transform .12s ${C.ease}}
.awr-btn:active{transform:scale(.98)}
.awr-btn:disabled{opacity:.5;cursor:default;transform:none}
.awr-btn-primary{background:${C.ink};color:${C.onInk}}
.awr-btn-primary:hover:not(:disabled){background:${C.inkHover}}
.awr-btn-soft{background:${C.hover};color:${C.text}}
.awr-btn-soft:hover:not(:disabled){background:${C.active}}
.awr-btn-quiet{height:28px;padding:0 8px;background:transparent;color:${C.text2};font-weight:400}
.awr-btn-quiet:hover:not(:disabled){background:${C.hover};color:${C.text}}
.awr-btn-icon{width:28px;height:28px;padding:0;background:transparent;color:${C.text3}}
.awr-btn-icon:hover:not(:disabled){background:${C.hover};color:${C.text}}
.awr-btn-on{background:${C.hover};color:${C.text}}
.awr-chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:${C.text3};font:inherit;font-size:12px;line-height:18px;cursor:pointer;outline-offset:1px;transition:background-color .12s ${C.ease},color .12s ${C.ease}}
.awr-chip:hover,.awr-chip[aria-expanded="true"]{background:${C.hover};color:${C.text}}
.awr-link{padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;outline-offset:2px;border-radius:4px}
.awr-link:hover{color:${C.text}}
.awr-card{display:flex;flex-direction:column;gap:2px;box-sizing:border-box;width:100%;min-height:64px;padding:10px 12px;border:.5px solid ${C.line2};border-radius:var(--dsw-radius-sm,8px);background:${C.surface};color:${C.text};font:inherit;text-align:left;cursor:pointer;outline-offset:2px;transition:background-color .12s ${C.ease},border-color .12s ${C.ease},opacity .16s ${C.ease}}
.awr-card:hover{background:${C.raised};border-color:${C.line3}}
.awr-card[aria-pressed="true"]{background:${C.hover};border-color:${C.selected}}
.awr-card[data-state="done"]{background:transparent}
.awr-card[data-dim="true"]{opacity:.32}
.awr-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.awr-clamp1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.awr-input{box-sizing:border-box;width:100%;height:28px;padding:0 8px 0 28px;border:.5px solid ${C.line2};border-radius:var(--dsw-radius-sm,8px);background:transparent;color:${C.text};font:inherit;font-size:13px;outline-offset:0}
.awr-input::placeholder{color:${C.faint}}
.awr-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:${C.hover}}
.awr-seg button{height:24px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:${C.text2};font:inherit;font-size:13px;line-height:20px;cursor:pointer;outline-offset:1px;transition:background-color .12s ${C.ease},color .12s ${C.ease}}
.awr-seg button:hover{color:${C.text}}
.awr-seg button[aria-selected="true"]{background:${C.surface};color:${C.text};font-weight:500;box-shadow:0 0 0 .5px ${C.line2},0 1px 2px rgba(0,0,0,.05)}
.awr-rowline{display:flex;align-items:center;gap:0;width:100%;min-height:24px;padding:0;border:0;background:none;color:${C.text3};font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-align:left;outline-offset:2px;border-radius:6px}
.awr-rowline[data-open]{cursor:pointer}
.awr-rowline[data-open]:hover{color:${C.text2}}
.awr-rowline .awr-chev{opacity:0;transition:opacity .12s ${C.ease},transform .16s ${C.ease}}
.awr-rowline:hover .awr-chev,.awr-rowline[data-open="true"] .awr-chev,.awr-rowline:focus-visible .awr-chev{opacity:1}
.awr-rowline[data-open="true"] .awr-chev{transform:rotate(90deg)}
.awr-fold>button .awr-chev{transition:transform .16s ${C.ease}}
.awr-fold[data-open="true"]>button .awr-chev{transform:rotate(90deg)}
.awr-legend{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:${C.text2};font:inherit;font-size:12px;line-height:16px;cursor:pointer;outline-offset:1px;transition:background-color .12s ${C.ease},opacity .12s ${C.ease}}
.awr-legend:hover{background:${C.hover}}
.awr-legend[aria-pressed="true"]{background:${C.active};color:${C.text}}
.awr-legend[data-off="true"]{opacity:.45}
.awr-edge{fill:none;stroke:${C.line3};stroke-width:1;transition:stroke .16s ${C.ease},opacity .16s ${C.ease}}
.awr-edge[data-hot="true"]{stroke:${C.text2};stroke-width:1.5}
.awr-edge[data-dim="true"]{opacity:.25}
.awr-edge[data-soft="true"]{stroke-dasharray:3 3}
.awr-pop{animation:awr-rise .18s ${C.ease} both}
.awr-drawer{animation:awr-slide .22s ${C.ease} both}
.awr-spin{animation:awr-spin .9s linear infinite}
.awr-pulse{animation:awr-pulse 1.6s ${C.ease} infinite}
@keyframes awr-rise{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes awr-slide{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
@keyframes awr-spin{to{transform:rotate(360deg)}}
@keyframes awr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.awr-pop,.awr-drawer,.awr-spin,.awr-pulse{animation:none}}
[data-chat-flow-key]:has([data-awr-row="hidden"]){margin:0!important}
`
/** Puts the stylesheet in the page once, for as long as the plugin is loaded. Returns what takes it out again. */
function installStyles() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !document.head) return () => {}
  const style = document.createElement('style')
  style.setAttribute('data-awr', 'styles')
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

// Line icons in one size and one stroke, in the colour of the text they sit in (lucide's shapes).
const ICONS = {
  chevron: ['m9 18 6-6-6-6'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  fit: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  node: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3 12h6', 'M15 12h6'],
}
function Icon({ name, size = 16, className, style }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className, style: { flex: 'none', ...style } },
    ...ICONS[name].map((d, index) => h('path', { key: index, d })))
}

/**
 * The state light: one small mark whose colour and shape mean the same thing wherever it appears. Colour is never the
 * only signal: ready is a ring, done is a check, the rest are filled.
 */
function Light({ state, size = 8, pulse = false }) {
  const color = STATE_COLOR[state] ?? C.idle
  const box = { display: 'inline-block', flex: 'none', width: size, height: size, boxSizing: 'border-box' }
  if (state === 'done') return h('span', { 'data-light': state, style: { ...box, color: C.text3, display: 'inline-flex' } }, h(Icon, { name: 'check', size: size + 4, style: { margin: -2 } }))
  if (state === 'ready') return h('span', { 'data-light': state, style: { ...box, borderRadius: '50%', border: `1.5px solid ${color}` } })
  return h('span', { 'data-light': state, className: pulse ? 'awr-pulse' : undefined, style: { ...box, borderRadius: '50%', background: color } })
}

/** A section that stays folded until someone opens it: where the identifiers and the raw messages live. */
function Fold({ label, children, defaultOpen = false, testId }) {
  const [open, setOpen] = React.useState(defaultOpen)
  return h('div', { className: 'awr-fold', 'data-open': open, 'data-testid': testId },
    h('button', { type: 'button', className: 'awr-link', 'aria-expanded': open, style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: C.text3, fontSize: 12, lineHeight: '16px' }, onClick: () => setOpen(!open) },
      h(Icon, { name: 'chevron', size: 12, className: 'awr-chev' }), label),
    open ? h('div', { style: { marginTop: 8 } }, children) : null)
}

/** One line of the technical details: a quiet label and its value, the value in the code face when it is an identifier. */
function Fact({ label, value, mono = true }) {
  if (value === undefined || value === null || value === '') return null
  return h('div', { style: { display: 'flex', gap: 12, fontSize: 12, lineHeight: '18px' } },
    h('span', { style: { flex: 'none', width: 72, color: C.text3 } }, label),
    h('span', { style: { minWidth: 0, color: C.text2, overflowWrap: 'anywhere', ...(mono ? { fontFamily: C.mono, fontSize: 11.5 } : {}) } }, value))
}

// ---- reaching the host --------------------------------------------------------------------------------------------

/** The language of the interface, which the host's sentences follow: the dictionary the locale service answers from. */
function languageOf(t) {
  const code = t('lang.code')
  if (code === 'zh' || code === 'en') return code
  return typeof navigator !== 'undefined' && String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Runs a `/awr` command on the host. `--ui` tells the host which language to answer in and that the plugin's own
 * interface asked. Returns the text; a refusal is thrown with its first line, the one written for people.
 */
async function runCommand(ctx, sessionId, line, language) {
  const answer = await ctx.remote.commands.execute(sessionId, `${line} --ui ${language}`, [])
  if (!answer?.ok) throw new Error(answer?.error?.code ?? 'the host refused the command')
  const result = answer.value?.result
  const text = String(result?.text ?? '')
  if (result?.kind === 'error') throw Object.assign(new Error(text.split('\n')[0] || 'failed'), { details: text })
  return text
}

/**
 * Where the host writes the plugin's data (lib/panel-snapshot.js, lib/progress.js): below its home directory, with the
 * conversation id made safe. The same path the host builds, because the browser cannot see the host's environment.
 */
function dataPath(home, sessionId, suffix = '') {
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return [home, '.local', 'state', 'dsh-awr', 'panel', `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}${suffix}.json`].join(separator)
}

/**
 * Reads one of those files. Reading adds nothing to the conversation, unlike a command, which DeepSeek Harness records
 * as a row. Throws why it cannot.
 */
async function readData(ctx, sessionId, suffix) {
  const home = ctx.remote?.hostFacts?.home
  if (typeof home !== 'string' || !home) throw new Error('the host did not say where its home directory is')
  const files = ctx.remote?.workspaceFiles
  if (!files) throw new Error('this DeepSeek Harness has no file service for the plugin')
  const answer = await files.read(sessionId, dataPath(home, sessionId, suffix), {})
  if (!answer?.ok) throw new Error(answer?.error?.code ?? 'the host could not read the data')
  if (answer.value?.eof === false) throw new Error('the data is longer than one read')
  return JSON.parse(String(answer.value?.text ?? ''))
}

const isLocal = (ctx) => ctx.remote?.hostFacts?.isLoopback === true
const short = (value, head = 12, tail = 6) => (String(value).length > head + tail + 4 ? `${String(value).slice(0, head)}…${String(value).slice(-tail)}` : String(value))
const baseName = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
const clock = (ms) => {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : ''
}
