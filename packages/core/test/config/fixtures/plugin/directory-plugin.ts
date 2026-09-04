import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "directory-plugin",
  setup: async (ctx) => {
    await ctx.agent.declare([
      { id: "directory", set: { description: "Loaded from plugin directory", mode: "subagent" } },
    ])
  },
})

export default plugin
