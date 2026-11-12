// What the plugin adds to DeepSeek Harness: the light in the conversation header, the progress tab, the `/awr` rows.
return {
  inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.workspaceFiles'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register('awr', { en, zh }), 'dsh-awr: dictionaries')
    ctx.effect(() => installStyles(), 'dsh-awr: styles')
    const t = translator(ctx)
    // The plugin manager installs an update. A profile without it still gets everything else, without the Update button.
    const host = { manager: undefined }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['remote.pluginManager'], (scope) => {
        host.manager = scope?.remote?.pluginManager ?? ctx.remote.pluginManager
        return () => { host.manager = undefined }
      })
    }
    const Chip = (props) => h(AwrChip, { ...props, __ctx: ctx, __host: host })
    const Page = (props) => h(ProgressPage, { ...props, __ctx: ctx })
    const Row = (props) => h(AwrRow, { ...props, __ctx: ctx })
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'awr-takeover', order: 30 }, Chip))
    ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'awr-progress', order: 20, label: () => t('view.label'), inject: (sessionId) => ({ sessionId }) }, Page))
    ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'awr' }, Row))
  },
}
