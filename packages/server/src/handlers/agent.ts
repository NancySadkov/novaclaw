import { AgentStatus } from "@novaclaw/core/agent-status"
import { AgentV2 } from "@novaclaw/core/agent"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Scratch } from "@novaclaw/core/scratch"
import { AgentRetire } from "@novaclaw/core/agent/retire"
import { AgentUsage } from "@novaclaw/core/agent/usage"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { Database } from "@novaclaw/core/database/database"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
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
          // ⚠️ `workspace` is stamped HERE rather than stored: it is derived from the id, so keeping
          // it in the record would be a second copy to keep true, and a stale one the day the scratch
          // root moves. The app cannot compute it — the root is under the instance's data directory,
          // which the client does not know and must not guess.
          const roster = yield* AgentV2.Service.use((agent) => agent.all())
          /**
           * ⚠️ ONE query for the whole roster, not one per colleague. The list is the Contacts
           * screen's only call, and a per-agent lookup would turn opening it into N round trips
           * against a table whose whole point is being cheap to read.
           */
          const lines = yield* AgentStatus.Service.use((status) => status.all())
          const byAgent = new Map(lines.map((line) => [line.agent, { task: line.task, observed: line.observed }]))
          return yield* response(
            Effect.succeed(
              roster.map((item) => ({
                ...item,
                workspace: Scratch.forAgent(String(item.id)),
                // Absent, not empty, when the colleague has no line yet — see `Agent.Info.status`.
                ...(byAgent.has(String(item.id)) ? { status: byAgent.get(String(item.id)) } : {}),
              })),
            ),
          )
        }),
      )
      .handle("agent.usage", (ctx) =>
        // The roster's work column. `Database.Service` rather than a per-location store: spend
        // belongs to the COLLEAGUE, not to whichever folder a chat happened to run in — a rate that
        // changed when you switched directories would be describing the directory, not the agent.
        response(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            // A fixed 24-hour window (see the endpoint's note). `Date.now()` here rather than a
            // stored "latest" so an idle colleague's window still slides — otherwise a series that
            // stopped growing would keep answering with its last busy day forever.
            const since = AgentUsage.minuteOf(Date.now()) - 24 * 60
            return yield* AgentUsage.since(db, { agent: ctx.params.agentID, minute: since })
          }),
        ),
      )
      .handle("agent.usageMany", (ctx) =>
        response(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            const since = AgentUsage.minuteOf(Date.now()) - 24 * 60
            return yield* AgentUsage.sinceMany(db, { agents: ctx.payload.agentIDs, minute: since })
          }),
        ),
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
          // Everything keyed on the id goes with it — the per-minute series AND the private cabinet.
          // ONE rule, shared with Nova's `colleague retire` (`agent/retire.ts` holds the why): a
          // retired name returns to the pool, and a future colleague drawing it must not open with
          // the old one's rate on its row, let alone the old one's memories in its head.
          const { db } = yield* Database.Service
          yield* AgentRetire.everything({
            db,
            events: yield* EventV2.Service,
            memory: Memory.client(yield* Memory.node.service),
            agent: ctx.params.agentID,
            at: Date.now(),
          })
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
