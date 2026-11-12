// Runs the runtime module against real awr binaries. Read-only: only `runtime binding` is run.
import { createAwr, explain } from '../../../lib/awr-runtime.js'

const lab = '/Users/mac/Documents/OriginOneAI/dsh-awr/.local/awr-lab/bin'
const cases = [
  ['bound: AWR repo, pinned build from its runtime-binding.json', '/Users/mac/Documents/originone/agent-work-running', { PATH: '/usr/bin:/bin' }],
  ['unbound: dsh-awr project, awr from PATH (lab build first)', '/Users/mac/Documents/OriginOneAI/dsh-awr', { PATH: `${lab}:/usr/bin:/bin` }],
  ['unbound: dsh-awr project, awr from PATH (released 0.7.0)', '/Users/mac/Documents/OriginOneAI/dsh-awr', { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }],
  ['missing: dsh-awr project, no awr anywhere', '/Users/mac/Documents/OriginOneAI/dsh-awr', { PATH: '/usr/bin:/bin' }],
]
for (const [label, root, env] of cases) {
  const awr = createAwr({ env })
  try {
    const found = await awr.resolve(root)
    const r = await awr.run(root, ['runtime', 'binding'])
    console.log(`${label}\n  -> ok source=${found.source} cli=${found.cli}\n     program ${r.program?.version}, schema ${r.schema_version}, revision ${r.project?.project_revision}`)
  } catch (error) {
    console.log(`${label}\n  -> ${error.kind}: ${explain(error)}`)
  }
}
