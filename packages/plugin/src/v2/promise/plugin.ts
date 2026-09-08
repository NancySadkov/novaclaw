import type { PluginContext } from "./context.js"

export interface Plugin {
  readonly id: string
  /** What this plugin needs, named. See the effect-style `Plugin` for what it is and is not. */
  readonly capabilities?: readonly string[]
  readonly setup: (context: PluginContext) => Promise<void> | void
}

export function define(plugin: Plugin) {
  return plugin
}

export interface PluginDomain {
  readonly add: (plugin: Plugin) => Promise<void>
  readonly remove: (id: string) => Promise<void>
}
