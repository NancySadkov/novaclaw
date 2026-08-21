import { AgentV2 } from "@novaclaw/core/agent"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentApi, handlerLayer } from "../handler-api"
import { response } from "../location"

/** `InvalidRequestError.kind` for a refused delete of the governing agent, so a client can branch on
 *  it without matching prose. Mirrors `handlers/config.ts`'s use of `kind`. */
export const PROTECTED_AGENT = "protected_agent"

export const AgentHandler = handlerLayer(
  HttpApiBuilder.group(AgentApi, "server.agent", (handlers) =>
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
          // and can never delete one). Follows `provider.remove` — including its refresh, see below.
          // The governing agent is not deletable through ANY door (AGENTS.md — the structural
          // metaphor). Checked before the store call rather than inside it, so the caller gets a 400
          // with a reason instead of a silent 204 for a delete that did nothing: an endpoint that
          // reports success for work it refused is how a user concludes the product is broken.
          if (AgentV2.isProtected(ctx.params.agentID))
            return yield* new InvalidRequestError({
              message:
                `"${ctx.params.agentID}" is this instance's governing agent and cannot be removed. ` +
                `Every other agent on the roster can be.`,
              kind: PROTECTED_AGENT,
              field: "agentID",
            })
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
          // 🔴 …and the LIVE snapshot is re-materialised, or the delete is durable but invisible.
          // This route writes the store directly, so it never passed through `apply`'s own
          // `refreshDomains` — the same gap `provider.remove` closed on 2026-08-06, whose handler
          // used to carry the note "the live per-location snapshot still holds it until the next
          // boot". Harmless while agents were a settings detail; under the roster it read as
          // **Retire appears to do nothing** — measured in the app on 2026-08-21: the toast said
          // retired and the colleague was still on the list. AFTER the writes, never inside them:
          // the reload re-reads the store.
          // A/B: commenting this line drops config-remove.test.ts to 8 pass / 1 fail.
          yield* ConfigStoreWrite.refreshDomain("agents")
        }),
      ),
  ),
)
