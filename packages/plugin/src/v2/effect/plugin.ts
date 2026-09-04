import type { Effect, Scope } from "effect"
import type { PluginContext } from "./context.js"

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  /**
   * What this plugin needs, named — `"config"`, `"location"`, `"fsUtil"` and so on. The host logs
   * it when the plugin loads, so a person can see what a plugin asked for before trusting it.
   *
   * ⚠️ **A CLAIM, not a gate, and the distinction is the contract.** `import()` runs a plugin's
   * module scope before anything here is read (AGENTS.md principle 13), so this cannot restrain a
   * plugin and must never be described as if it could. It exists so the answer to *what does this
   * thing want* has a source other than reading the code. Omitting it is legitimate and means
   * exactly "declared nothing", which the host reports as such rather than as "needs nothing".
   *
   * ⚠️ Typed as `string[]` rather than a union on purpose: the vocabulary lives in the host
   * (`core`'s `CAPABILITIES`), and this package sits BELOW it — `core` imports this, never the
   * reverse. The host validates the names and reports any it does not recognise.
   */
  readonly capabilities?: readonly string[]
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}

export interface PluginDomain {
  readonly add: (plugin: Plugin) => Effect.Effect<void>
  readonly remove: (id: string) => Effect.Effect<void>
}
