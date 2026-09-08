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
import type { Declarative } from "./declaration.js"
import type { CommandV2Info } from "./command.js"
import type { AgentV2Info } from "@novaclaw/sdk/v2/types"
import type { AppHooks } from "./app.js"

/**
 * 🔴 **What an EXTERNAL plugin is handed. The five CONTRIBUTABLE facets are declarative only.**
 *
 * A plugin contributes by DECLARING data, never by handing the host a mutation callback. That is
 * what lets a plugin host move behind a process or sandbox boundary later: a declaration can be sent
 * over a transport and a closure cannot. Every external plugin in the tree was one such closure
 * until 2026-09-04, which is what made the deferred confinement in AGENTS.md unbuildable rather than
 * merely unbuilt.
 *
 * ⚠️ **`event`, `integration` and `tool` keep their full shape, and that is not an oversight.**
 * They are BEHAVIOURAL — an OAuth `authorize`, a tool's async `execute`, an event handler — and no
 * rearrangement turns behaviour into data. Ruling 5 already named the out-of-process seam for
 * behaviour: it is MCP. A plugin needing to run code out of process is describing an MCP server,
 * not a declaration, so these three stay in-process capabilities and nothing pretends otherwise.
 *
 * ⚠️ **A contract, not a gate.** `import()` runs a module's scope before anything here is
 * consulted, so nothing in this type constrains hostile code in-process (principle 13). What it buys
 * is that a plugin WRITTEN against it keeps working when the host moves out of process, and that the
 * door hands out no callback API for a third party to depend on meanwhile.
 *
 * The richer in-process view is {@link HostPluginContext}; core's first-party plugins take that one.
 */
export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: Declarative<AgentV2Info> & Reload
  readonly app: AppHooks
  readonly catalog: Pick<CatalogHooks, "declare"> & Reload
  readonly command: Declarative<CommandV2Info> & Reload
  readonly event: EventHooks
  readonly integration: IntegrationHooks & Reload
  readonly plugin: PluginDomain
  readonly reference: Pick<ReferenceHooks, "declare"> & Reload
  readonly skill: Pick<SkillHooks, "declare"> & Reload
  readonly tool: ToolHooks
}

/**
 * **The in-process view: everything above, plus the callback registration API.**
 *
 * First-party plugins are compiled into this build and run in the same process by definition, and
 * some of them must use the callback: `config/plugin/agent.ts` enumerates `draft.list()` and appends
 * permissions to every agent OTHER plugins contributed, which no contribution payload expresses.
 * Narrowing it to declarations would delete a capability rather than confine anything.
 *
 * ⚠️ Two contracts is not a shim. A trusted API and an untrusted one differing is the same split
 * the permission evaluator makes everywhere else; what would be a shim is one contract with a flag.
 */
export interface HostPluginContext extends PluginContext {
  readonly agent: AgentHooks & Reload
  readonly catalog: CatalogHooks & Reload
  readonly command: CommandHooks & Reload
  readonly reference: ReferenceHooks & Reload
  readonly skill: SkillHooks & Reload
}
