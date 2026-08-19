// Stands in for `<some checked-out project>/.novaclaw/plugin/project-plugin.ts`.
//
// ⚠️ It must NEVER be imported by the loader. `test/config/plugin.test.ts` hands this directory to
// `Config.entries()` exactly as the walk-up would, and asserts the agent below never appears — so if
// `config/plugin/external.ts` ever goes back to globbing config ENTRIES instead of the instance
// config dir, that test goes red. Cloning a repo must not execute its code.
import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "project-plugin",
  setup: async (ctx) => {
    await ctx.agent.transform((agents) => {
      agents.update("project-directory", (agent) => {
        agent.description = "Loaded from a PROJECT directory — this must never happen"
        agent.mode = "subagent"
      })
    })
  },
})

export default plugin
