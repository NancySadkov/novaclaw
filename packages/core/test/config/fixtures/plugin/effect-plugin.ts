// The Effect-shaped half of the loader's `PluginModule` union. Its promise-shaped sibling is
// `directory-plugin.ts`; both live in the one directory the loader reads (the INSTANCE config dir)
// so a single run covers both branches.
import { define, type Plugin } from "@novaclaw/plugin/v2/effect"
import { Effect } from "effect"

const plugin: Plugin = define({
  id: "effect-directory-plugin",
  // Declares one name the host knows and one it does not — the loader must report BOTH, because a
  // typo swallowed silently is a declaration that reads as complete. The promise-shaped sibling
  // declares nothing at all, so one run covers declared, unknown and undeclared.
  capabilities: ["config", "netwrok"],
  // 🔴 DECLARATIVE, not a transform callback. This is the whole shape being proven: an external
  // plugin's contribution is DATA, so the same value could arrive over a transport from a confined
  // process. A closure could not, which is what forecloses an out-of-process plugin host.
  effect: (ctx) =>
    ctx.agent
      .declare([
        {
          id: "effect-directory",
          set: { description: "Loaded from plugin directory as an Effect plugin", mode: "subagent" },
        },
      ])
      .pipe(Effect.asVoid),
})

export default plugin
