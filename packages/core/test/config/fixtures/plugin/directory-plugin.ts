import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "directory-plugin",
  setup: async (ctx) => {
    await ctx.agent.transform((agents) => {
      agents.update("directory", (agent) => {
        agent.description = "Loaded from plugin directory"
        agent.mode = "subagent"
      })
    })
  },
})

export default plugin
