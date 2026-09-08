import type { PluginOptions } from "../options.js"
import type { AgentHooks } from "./agent.js"
import type { CatalogHooks } from "./catalog.js"
import type { CommandHooks } from "./command.js"
import type { EventHooks } from "./event.js"
import type { IntegrationHooks } from "./integration.js"
import type { PluginDomain } from "./plugin.js"
import type { ReferenceHooks } from "./reference.js"
import type { SkillHooks } from "./skill.js"
import type { ToolHooks } from "./tool.js"
import type { Reload } from "./registration.js"
import type { AppHooks } from "./app.js"

/**
 * The promise-shaped external contract. Mirrors the effect SDK's `PluginContext` exactly: the five
 * CONTRIBUTABLE facets are declarative only, because a declaration crosses a process boundary and a
 * mutation callback does not; `event`, `integration` and `tool` keep their full shape because they
 * are behavioural, and behaviour's out-of-process seam is MCP (ruling 5) rather than a data shape
 * that would silently drop the code.
 *
 * ⚠️ The two SDKs must stay in step. A promise plugin that could still hand over a callback would
 * make the whole property false for anyone who chose that shape, and the two contexts drifting is
 * exactly the kind of second answer this codebase keeps finding.
 */
export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: Pick<AgentHooks, "declare"> & Reload
  readonly app: AppHooks
  readonly catalog: Pick<CatalogHooks, "declare"> & Reload
  readonly command: Pick<CommandHooks, "declare"> & Reload
  readonly event: EventHooks
  readonly integration: IntegrationHooks & Reload
  readonly plugin: PluginDomain
  readonly reference: Pick<ReferenceHooks, "declare"> & Reload
  readonly skill: Pick<SkillHooks, "declare"> & Reload
  readonly tool: ToolHooks
}
