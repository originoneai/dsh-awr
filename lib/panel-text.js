// What the panel's own queries put in the conversation (DSH-056): one readable sentence.
//
// DeepSeek Harness records every command run as a row in the conversation and shows the text the command
// returned; no plugin can switch that off. The panel's refresh is such a command, so what it returns is all
// that is written there, and it is one sentence a person can read:
//
//   Taking the project over · reviewing the draft (step 3 of 6)
//
// The data the panel draws from does not travel in that text at all: it is in a file (lib/panel-snapshot.js).
import { STEPS } from './takeover.js'

const TEXT = {
  en: {
    unavailable: 'AWR cannot work on this conversation',
    notInitialized: 'This project has no AWR work state yet',
    managed: ({ progress, ready, blocked }) => `AWR project · ${progress} in progress, ${ready} ready, ${blocked} blocked`,
    running: ({ step, index, total }) => `Taking the project over · ${step} (step ${index} of ${total})`,
    completed: ({ goals, gaps }) => `Takeover done · ${goals} goal(s), ${gaps} open gap(s)`,
    stopped: ({ step, reason }) => `Takeover stopped at ${step} · ${reason}`,
    failed: ({ step }) => `Takeover failed at ${step}`,
    interrupted: ({ step }) => `Takeover interrupted at ${step}; it can continue`,
    steps: { preflight: 'checking the project', preview: 'reading the project', review: 'reviewing the draft', accept: 'applying', organize: 'checking what is left', receipt: 'writing the receipt' },
  },
  zh: {
    unavailable: 'AWR 无法处理这个会话',
    notInitialized: '这个项目还没有 AWR 工作状态',
    managed: ({ progress, ready, blocked }) => `AWR 项目 · ${progress} 项进行中，${ready} 项就绪，${blocked} 项阻塞`,
    running: ({ step, index, total }) => `正在接管项目 · ${step}（第 ${index}/${total} 步）`,
    completed: ({ goals, gaps }) => `接管完成 · ${goals} 个目标，${gaps} 个未决缺口`,
    stopped: ({ step, reason }) => `接管在「${step}」停下 · ${reason}`,
    failed: ({ step }) => `接管在「${step}」失败`,
    interrupted: ({ step }) => `接管在「${step}」被中断，可以继续`,
    steps: { preflight: '检查项目', preview: '读取项目', review: '审阅草稿', accept: '应用', organize: '检查剩余事项', receipt: '写入回执' },
  },
}

/** The step a run is at: the first one that is not finished (or the one that stopped). */
function currentStep(view) {
  const stopped = view.stop?.step
  if (stopped) return stopped
  return STEPS.find((name) => !['done', 'skipped'].includes(view.steps?.find((step) => step.name === name)?.status)) ?? STEPS.at(-1)
}

/**
 * One readable sentence for the state of a conversation's project.
 *
 * @param {object} view the takeover view (`takeover.status`)
 * @param {object | undefined} work the state view of a project AWR manages
 * @param {string} [language] `zh` or `en`
 */
export function panelSentence(view, work, language = 'en') {
  const t = TEXT[language] ?? TEXT.en
  const stepName = (name) => t.steps[name] ?? name
  const managed = work && (view.state === 'initialized' || view.state === 'completed')
  if (managed) return t.managed({ progress: work.in_progress?.length ?? 0, ready: work.ready?.length ?? 0, blocked: work.blocked?.length ?? 0 })
  switch (view.state) {
    case 'unavailable': return t.unavailable
    case 'not_initialized': return t.notInitialized
    case 'running': {
      const step = currentStep(view)
      return t.running({ step: stepName(step), index: STEPS.indexOf(step) + 1, total: STEPS.length })
    }
    case 'completed': return t.completed({ goals: view.receipt?.organization?.goalTotal ?? 0, gaps: view.receipt?.organization?.gapTotal ?? 0 })
    case 'stopped': return t.stopped({ step: stepName(view.stop?.step ?? currentStep(view)), reason: view.stop?.reason ?? '' })
    case 'failed': return t.failed({ step: stepName(view.stop?.step ?? currentStep(view)) })
    case 'interrupted': return t.interrupted({ step: stepName(currentStep(view)) })
    default: return t.notInitialized
  }
}
