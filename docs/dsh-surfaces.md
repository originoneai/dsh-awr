# DeepSeek Harness surfaces the plugin relies on (DSH-002)

Checked on 2026-11-11 against DeepSeek Harness desktop `0.2.2-rc.1`.

## Sources, in order of weight

1. **Live inspection.** A DSH conversation answered `cordis_inspect_list` / `cordis_inspect_query`
   (host platform) for each item and wrote the raw results to
   [`evidence/DSH-002/dsh-inspect.json`](evidence/DSH-002/dsh-inspect.json) (events and services) and
   [`evidence/DSH-002/dsh-inspect-2.json`](evidence/DSH-002/dsh-inspect-2.json) (subagent and
   permission services, client slots). This is what the running Harness reports, so it decides
   conflicts.
2. **Bundled package documentation.** The READMEs and the `cordis-plugin-development` skill that
   ship inside the app (`app.asar`), for example `@deepseek-ai/dsh-commands`, `dsh-agent`,
   `dsh-tools`, `dsh-system-prompt`, `dsh-session`, `dsh-compaction`, `dsh-skill` and
   `dsh-mcp-client`.

Third-party web pages read earlier are not used for any row below.

## Result per surface

| Plugin need | Surface | Status | Evidence and notes |
| --- | --- | --- | --- |
| Mount `awr-mcp` | `@deepseek-ai/dsh-mcp-client` row in a bundle's `cordis.patch.yml` | **Changed** | `ctx.mcpManager` is **absent** in 0.2.2-rc.1 (inspection: `service:mcpManager`, absent). The documented route is a configuration-only bundle that inserts one `dsh-mcp-client` row per server (`serverName`, `transport: stdio`, `command`, `args`, `env`, `cwd`). Tools appear as `mcp__<serverName>__<tool>`; observed `mcp__awr__awr_query`. DSH scrubs the ambient environment, so use the native binary. |
| Bind a conversation to AWR | event `agent/created` | **Changed** | Serial and awaited, payload `{ agent, source: SessionStartSource, signal? }`; the agent loop holds queued input until every listener finishes. `session/created` exists but is a synchronous, read-only `emit` that a throw vetoes, so it is the wrong place for a slow `awr` call. |
| Inject AWR context | `ctx.systemPrompt.context(PromptContext)`, `ctx.systemPrompt.section(...)`, `agent.inject(...)` | **Confirmed** | `context()` and `section()` both exist (inspection). Per the bundled practices guide, prompt text uses `section()` and per-agent context uses `agent.inject()` (logged as `agent/inbox/spliced`, enters the next admitted step, does not wake the agent). Fields of `PromptContext` are not in the receipt; read the installed package's `.d.ts` in DSH-010. |
| Slash commands | `ctx.commands.register(definition)` | **Confirmed** | Handler gets `{ agent, rawInput }` and returns `{ kind: 'success' \| 'error', text? }`; no model message is created; every run is logged as `command/run` and `command/done`; name is lowercase letters, digits, `_`, `-`. Global or agent-scoped. |
| Checkpoint at turn end | event `agent/turn-stopping` | **Changed** | Serial, awaited before the turn closes. A listener that objects calls `agent.steer(...)` and the loop runs another step. This is the supported way to ask the model for an AWR checkpoint before a turn ends. It replaces the earlier idea of listening to a persisted `turn/end`. |
| Block or gate a tool call | event `tools/pre-execute`, `ctx.tools.guard(...)` | **Confirmed (was open)** | `tools/pre-execute` is a waterfall that can allow, deny, cancel or ask; `guard` is a synchronous deny-only check that holds regardless of listener order. Answers the open question about a blockable pre-tool-call hook. The plugin does not need it for P0. |
| Observe tool outcomes | event `tools/result` | **Confirmed** | `emit` of the frozen `(exec, result)`; listener failures are contained. |
| Before-compaction hook | none | **Absent** | The only compaction Cordis event is the `compaction/summary-error` waterfall, a recovery hook for a failed summary. `compaction/start`, `compaction/summary` and `compaction/end` are log-only session events written to the session log, so they can be observed afterwards but not intercepted. Save checkpoints before compaction, at turn boundaries. |
| Compaction measurements | session events `compaction/*` | **Partly** | No before/after token counts or window size in the documented payloads. AWR observations from DSH would have to be `estimated`, so AWR's 50% hand-off advice does not apply. Unverified against a real compaction. |
| Parent of a forked conversation | none (`inheritedEventCount`, `ctx.sessionQuery`) | **Absent, worked around** | A fork's header has no `parentSession` (subagents only) and `agent/created` says `source: startup`; `traceSession` does not see forks. The parent is found by the inherited events (docs/binding.md, DSH-016). |
| Persist the AWR session mapping | none needed | **Changed** | `appendPluginRecord()` and new session event types are reserved for DSH's own experimental packages (a Session that holds an unknown non-ignorable event refuses to reopen). AWR already stores the native-to-AWR mapping (`awr client bind`, external session `dsh:<id>`), so the plugin re-reads it from AWR. |
| Workflow skill | `ctx.skills.register(skill)` | **Confirmed** | Embedded in-memory skill with an invocation policy (`modelInvocable`, `userInvocable`). |
| Plugin configuration | `Config` export, `ctx.configEditor.edit(entry, change)` | **Confirmed** | Plugin code must not rewrite `cordis.patch.yml`; `configEditor` is the supported writer. Secrets go to `ctx.credentials`, not config. |
| Per-session derived state | `ctx.sessionProjections.register(...)` | **Confirmed** | Pure, synchronous `apply`; replaces subscribing to `session/event` and rescanning the log. |
| Plugin entry | `export function apply(ctx, config)` in a bundle package | **Confirmed in the bundled guide, loaded in DSH by DSH-010** | Form and `package.json` `dsh.bundle.patch` manifest are in `cordis-plugin-development` (`host-plugin.md`). `ctx.logger` is used in the bundled Cordis README. |
| Takeover button | client slots `conversation.session.header.actions`, `conversation.input.right`, `sidebar.workspaces.session.menu.item`, `settings.section`, `sidebar.footer.action`, `plugins.add.actions` | **Confirmed to exist** | Inspected with `Slots.listSubTree` on the client platform (`dsh-inspect-2.json`, B1 to B7). The session-scoped list slots take `{ id, order?, label? }` and render a component; overlays must portal. There is no command palette (B8, absent). The host-side operation is the `commands` service, whose `list` and `execute` are `@Remote`, so a client button can run a registered `/awr` command (C1). Rendering was not exercised. |
| Background subagent | host services `subagents`, `workflowEngine`, `permissionPresets`, `approval`; `ctx.tools.restrict` | **Confirmed to exist, not exercised** | `subagents.startActivation(spec)`, `waitForChildren`, `listChildren`, `interrupt`, `registerProvider`; `workflowEngine.start(request)`; `permissionPresets.set(session, name)`; `approval.setPolicy(agent, policy)` (A2 to A8). The receipt shows method names, not the fields of `SubagentActivationSpec`, so whether a child can be limited to reading, calling `awr` and writing under `.awr/` is still to be shown in DSH-021. The two mechanisms available are `tools.restrict` on the child's agent context and a permission preset. |
| Install | `plugin_manager install_bundle` (agent tool), the Plugins page, `dsh plugin --profile <name> add link:/path` | **Confirmed in docs, not yet run** | The desktop profile is managed by the Electron app (`dsh desktop --dump-config` is refused), so DSH-010 installs through the app or a non-desktop profile. |
| Plugin UI | `dsh.client` entry, slots, React | **Documented, not exercised** | Needs DSH-051. Do not embed an iframe; use the host theme tokens. |

## Corrections this makes to the design

- Client UI is exercised (DSH-021): a plugin's `client.js` (`window.__ModuleLoader__.load`, `dsh.client` in
  `package.json`) registers into `conversation.session.header.actions` and receives `sessionId` and the
  session hooks as props; `ctx.remote.commands.execute(sessionId, line, [])` runs a host command and
  returns `{ ok, value: { result: { kind, text } } }` (or `{ ok: false, error }`). Every command run is a
  line in the conversation's timeline and an entry in its log. The `web` profile serves the same client and
  can be opened in a browser: `dsh <profile> --no-open --host 127.0.0.1 --port N`. The web client's "add
  workspace" needs a native folder dialog.
- Subagents (DSH-021): `ctx.subagents.startActivation({ provider: 'spawn', label, request: { cwd, prompt,
  parent }, signal, delivery: 'caller' })` starts a child whose `agent/created` carries `parentSession` and
  `origin` in the header; its header `cwd` is the parent's until DSH moves it to `request.cwd`. Its tools are
  restricted with `agent.ctx.tools.restrict({ allow })` (needs the agent's own context) in that listener, and
  `ctx.tools.guard((exec) => reason)` sees `exec.agent`, `exec.name` and `exec.arguments`.

- DSH-012 no longer mounts `awr-mcp`: a static `dsh-mcp-client` row serves one project for every
  conversation, and `tools/pre-execute` cannot rewrite arguments, so the plugin registers its own tools
  (`ctx.tools.register(definition, { when })`, project taken from the binding). `defineTool` is not
  importable from a plugin outside DSH; a definition is a plain object with a JSON Schema `parameters`
  and `output.render` (see [tools.md](tools.md)).
- The README capability table is updated: no `ctx.mcpManager`, no `appendPluginRecord`, binding and
  checkpoint prompts move to `agent/created` and `agent/turn-stopping`.
- DSH-013 (binding) and DSH-030 (checkpoint prompts) change their next actions accordingly.
- A takeover run that must be unattended cannot rely on an approval prompt: plugin-registered tools
  and commands run under the session's permission preset, which is `workspace-write` with approval
  `ask` by default. DSH-021 must check that before promising a one-click flow.

## Still open

- **Subagent limits.** The services and the two restriction mechanisms exist (see the table). That a
  takeover child can be held to reading files, calling `awr` and writing under `.awr/` with no
  approval prompt is not shown yet; DSH-021 has to prove it.
- **Fields of `PromptContext`, `CommandDefinition`, `SessionStartSource` values and the `Agent`
  type.** The receipt gives method signatures, not the types they reference. Read the installed
  packages' `lib/types/**/*.d.ts` when DSH-010 starts.
- **Undo for a takeover.** An AWR question, not a DSH one.
