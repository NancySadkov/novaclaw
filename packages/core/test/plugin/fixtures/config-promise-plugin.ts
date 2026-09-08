import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "config-promise-plugin",
  setup: async (ctx) => {
    // Declarative, like its effect-shaped sibling: an external plugin's contribution is DATA.
    await ctx.agent.declare([
      { id: "configured", set: { description: ctx.options.description, mode: "subagent" } },
    ])
  },
})

export default plugin
