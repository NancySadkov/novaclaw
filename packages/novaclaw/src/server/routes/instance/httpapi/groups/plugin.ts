import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * 🔴 **What a loaded plugin SAYS it needs — disclosure, never enforcement.**
 *
 * Principle 13 is explicit that the plugin contract is not a gate: `import()` runs a module's scope
 * before anything is validated, so a declaration from third-party code is a CLAIM. Its worth is
 * 12(d) — a person can be shown what the code running inside their instance says it requires, which
 * until now existed only as a log line nothing rendered.
 *
 * ⚠️ `capabilities` is OPTIONAL and the absence is meaningful: a plugin that declared nothing is a
 * different statement from one that declared an empty set, and collapsing them would make the field
 * a confident description of the wrong thing. The two stay distinct from the loader to the screen.
 */
export const LoadedPlugin = Schema.Struct({
  id: Schema.String,
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.Literals(["internal", "external"]),
})

export const PluginApi = HttpApi.make("plugin").add(
  HttpApiGroup.make("plugin")
    .add(
      HttpApiEndpoint.get("list", "/api/plugin", {
        query: WorkspaceRoutingQuery,
        success: described(
          Schema.Array(LoadedPlugin),
          "Every plugin currently loaded, with the capabilities it declared — a claim, not a grant",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "plugin.list",
          summary: "List loaded plugins",
          description:
            "What is loaded and what each one declared it needs. Declarations from external plugins are unverified claims: the plugin contract is not a gate.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "plugin",
        description: "Loaded plugins and their declared capabilities, for the Developer-mode Debug app.",
      }),
    )
    .middleware(Authorization),
)
