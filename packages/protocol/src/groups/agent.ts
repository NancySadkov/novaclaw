import { Agent } from "@novaclaw/schema/agent"
import { Location } from "@novaclaw/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const AgentGroup = HttpApiGroup.make("server.agent")
  .add(
    HttpApiEndpoint.get("agent.list", "/api/agent", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.list",
          summary: "List agents",
          description: "Retrieve currently registered agents.",
        }),
      ),
  )
  .add(
    // Self-healing (AGENTS.md): a config-borne agent had NO delete path at all — `PATCH /config`
    // routes `agents` through `mergePatch`, which has no null-deletion, so an entry could be added
    // and merged but never removed. Idempotent by design (DELETE on a name with no stored row is a
    // 204), because the row is the only thing this owns: markdown agents are filesystem-walked
    // (decision D2) and are not reachable from here.
    HttpApiEndpoint.delete("agent.remove", "/api/agent/:agentID", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.remove",
          summary: "Remove agent",
          description:
            "Delete a config-defined agent from the instance agent store, and clear `default_agent` when it pointed at that agent. Takes effect fully on the next serve boot.",
        }),
      ),
  )
