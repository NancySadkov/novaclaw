import type { ToolDefinition } from "../../tool.js"
import type { Registration } from "./registration.js"

export interface ToolHooks {
  /**
   * Register a model-facing tool for the lifetime of the plugin: unloading the
   * plugin (or disposing the registration) removes it. The definition is the same
   * shape as a config-dir `{tool,tools}/*.{js,ts}` tool (`tool()` from
   * `@novaclaw/plugin`) — Zod or raw-JSON-Schema args plus an async `execute`.
   */
  readonly register: (name: string, definition: ToolDefinition) => Promise<Registration>
}
