import type { ServerConnection } from "@/context/server"
import { instanceFetchList } from "@/utils/instance-fetch"

/**
 * A plugin currently loaded in this instance, and what it SAYS it needs.
 *
 * ⚠️ `capabilities` is a claim and never a grant. Principle 13: the plugin contract is not a gate,
 * because `import()` runs a module's scope before anything is validated. This exists for 12(d) —
 * showing a person what the code in their instance declares — and the surface must say so rather
 * than letting a list of neat labels read as a permission set.
 *
 * `undefined` means the plugin declared NOTHING, which is a different statement from declaring an
 * empty set, and the two are kept apart all the way from the loader to the screen.
 */
export interface LoadedPlugin {
  readonly id: string
  readonly capabilities?: readonly string[]
  readonly source: "internal" | "external"
}

export function loadedPlugins(server: ServerConnection.HttpBase, directory: string) {
  return instanceFetchList<LoadedPlugin>(server, { route: "api/plugin", directory }, "loaded plugins")
}
