import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "config-promise-plugin",
  setup: async (ctx) => {
    await ctx.agent.transform((agents) => {
      agents.update("configured", (agent) => {
        agent.description = ctx.options.description
        agent.mode = "subagent"
      })
    })
  },
})

export default plugin
