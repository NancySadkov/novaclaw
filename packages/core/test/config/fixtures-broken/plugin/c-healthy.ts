// The healthy plugin sitting BEHIND the two broken ones. Its agent landing is the loader's own
// "every discovered file was processed" signal — without it, "no warning was lost" would be
// indistinguishable from "the loader stopped at the first fault".
import { define, type Plugin } from "@novaclaw/plugin/v2/promise"

const plugin: Plugin = define({
  id: "healthy-plugin",
  setup: async (ctx) => {
    await ctx.agent.declare([
      { id: "healthy", set: { description: "Loaded after broken plugins", mode: "subagent" } },
    ])
  },
})

export default plugin
