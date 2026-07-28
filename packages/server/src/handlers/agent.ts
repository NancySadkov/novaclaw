import { AgentV2 } from "@novaclaw/core/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () =>
      Effect.gen(function* () {
        return yield* response(AgentV2.Service.use((agent) => agent.all()))
      }),
    )
    .handle(
      "agent.remove",
      Effect.fn(function* (ctx) {
        // The store row goes away instance-wide (self-healing: `PATCH /config` merges `agents`
        // and can never delete one). The live per-location AgentV2 snapshot still holds the agent
        // until the next boot; the store is the durable truth. Follows `provider.remove`.
        const store = yield* AgentConfigStore.Service
        yield* store.removeAgent(ctx.params.agentID)
        // ...and the dangling default is pruned WITH it, in the same request. This is the part
        // that matters: `default_agent` is settable but not clearable through `PATCH /config`, so
        // a default left pointing at a deleted agent could never be repaired by an agent. It also
        // reads as configured while resolving to nothing — V2 silently falls back to `build`
        // (`core/src/agent.ts:69-79`) and the novaclaw agent state THROWS
        // `default agent "…" not found` (`novaclaw/src/agent/agent.ts:425`).
        //
        // Conditional, never blanket: removing some OTHER agent must leave the default alone.
        const fallback = yield* store.getDefault()
        if (fallback === ctx.params.agentID) yield* store.clearDefault()
      }),
    ),
)
