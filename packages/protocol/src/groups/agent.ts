import { Agent } from "@novaclaw/schema/agent"
import { InvalidRequestError } from "../errors"
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
    // The roster's work column (owner, 2026-08-21): what this colleague PRODUCED, minute by minute.
    //
    // ⚠️ **The window is fixed at 24 hours and there are no query parameters**, matching the house
    // rule that no `/api/*` group declares `urlParams` (see `groups/log.ts`). It costs nothing to
    // return: the series is SPARSE — only minutes in which the colleague actually produced tokens
    // exist — so a day is at most 1440 rows and typically a handful. A caller showing a five-minute
    // rate slices what it needs; a caller showing a day already has it.
    HttpApiEndpoint.get("agent.usage", "/api/agent/:agentID/usage", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.UsageMinute)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.usage",
          summary: "An agent's per-minute output",
          description:
            "Tokens this agent GENERATED (output + reasoning), bucketed by minute, newest first, for " +
            "the last 24 hours. Sparse on purpose: a minute in which the agent produced nothing has " +
            "no row at all, so an absent minute means nothing happened rather than 'measured, and it " +
            "was zero'. A sub-agent's output is attributed to the agent that owns it.",
        }),
      ),
  )
  .add(
    // Self-healing (AGENTS.md): a config-borne agent had NO delete path at all — `PATCH /config`
    // routes `agents` through `mergePatch`, which has no null-deletion, so an entry could be added
    // and merged but never removed. Idempotent by design (DELETE on a name with no stored row is a
    // 204), because the instance store is the sole configurable source of agent identity and
    // authority; there is no project-file definition left to remove separately.
    HttpApiEndpoint.delete("agent.remove", "/api/agent/:agentID", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      // 🔴 400 for the GOVERNING agent. This endpoint writes the store DIRECTLY, so the refusal in
      // `ConfigStoreWrite` does not cover it — one rule with two doors is one rule enforced at one
      // door. AGENTS.md, the structural metaphor: *"the charter is not editable from inside."*
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.remove",
          summary: "Remove agent",
          description:
            "Delete a config-defined agent from the instance agent store, and clear `default_agent` when it pointed at that agent. Takes effect fully on the next serve boot. The instance's governing agent (`nova`) cannot be removed and returns 400.",
        }),
      ),
  )
