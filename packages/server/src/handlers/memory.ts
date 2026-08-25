import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Log } from "@novaclaw/schema/log"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { MemoryApi, handlerLayer } from "../handler-api"

/** A store fault is a 400 with the store's own reason, never a 500 — the caller can act on it. */
const asBadRequest = <A, R>(effect: Effect.Effect<A, MemoryClient.MemoryError, R>) =>
  effect.pipe(
    Effect.catchTag("MemoryClient.MemoryError", (error) => Effect.fail(new InvalidRequestError({ message: error.reason }))),
  )

/**
 * Erase every memory in every scope, for every agent — Nova included.
 *
 * 🔴 Owner, 2026-08-22: *"erases all RAGs from all agents, including Nova — that will simplify running
 * tabula rasa tests, without resetting entire Novaclaw install."* Deliberately total: an "everything
 * except the governing agent" arm would leave a clean-slate run standing on Nova's leftovers, which is
 * the one thing this exists to prevent. The charter protects Nova's IDENTITY — its profile is fixed in
 * code and returns on the next boot — not its filing cabinet, which is data like anyone else's.
 *
 * ⚠️ **The confirmation lives in the CLIENT.** A route that refused without a magic flag would read as
 * safety and would not be one: whatever can call this once can call it twice. What makes it safe is
 * that the only surface offering it asks first (Settings → Health), and that the COUNT comes back so
 * the answer is auditable afterwards — "erased 0" and "erased 1,412" are different facts.
 */
export const MemoryHandler = handlerLayer(
  HttpApiBuilder.group(MemoryApi, "server.memory", (handlers) =>
    handlers
      .handle(
        "memory.erase",
        Effect.fn(function* () {
          const memory = Memory.client(yield* Memory.node.service)
          const erased = yield* memory.eraseAll().pipe(Effect.orElseSucceed(() => 0))
          yield* Log.event("kb.memory.erased", { "memory.rows": erased })
          return erased
        }),
      )
      /**
       * 🔴 ARCHIVE / RESTORE. The engine, the client and the `memory.claim.status` event all shipped
       * together and this was the missing link — the Memory app's button was rendered DISABLED with
       * a sentence naming exactly this gap.
       *
       * ⚠️ `MemoryAccess.owner()`, like every other endpoint on the Memory app's surface: this is
       * the human at their own instance, and confining "stop remembering that" to one chat would be
       * a different product. A model never reaches this — it goes through the `kb` tool, whose
       * access is built from the session it runs in.
       *
       * ⚠️ The publish is the STORE's, not this handler's. `MemoryObserved` wraps the client the
       * layer provides, so the overlay updates whoever moved the claim; announcing it from here as
       * well would double every archive in the feed and make the event mean "an HTTP caller did
       * this" rather than "the store did this".
       */
      .handle(
        "memory.claim.status",
        Effect.fn(function* (ctx) {
          const memory = Memory.client(yield* Memory.node.service)
          const changed = yield* asBadRequest(
            memory.setClaimStatus(ctx.payload.id, ctx.payload.status, MemoryAccess.owner()),
          )
          return changed
        }),
      )
      /**
       * 🔴 RECORD A GOVERNED CLAIM — the first HTTP path in the instance that reaches `addClaim`.
       *
       * `POST /memory/remember` writes a plain node through `addMemory`: no subject, no predicate,
       * no conflict key, so nothing it creates can ever be corrected and nothing outside a model turn
       * could cause a supersession. That is why the P2 gate had never been met: a correction was not
       * merely unobserved, it was unreachable.
       */
      .handle(
        "memory.claim.add",
        Effect.fn(function* (ctx) {
          const memory = Memory.client(yield* Memory.node.service)
          const result = yield* asBadRequest(
            memory.addClaim(
              {
                scope: ctx.payload.scope ?? "global",
                statement: ctx.payload.statement,
                ...(ctx.payload.subject === undefined ? {} : { subject: ctx.payload.subject }),
                ...(ctx.payload.predicate === undefined ? {} : { predicate: ctx.payload.predicate }),
                ...(ctx.payload.confidence === undefined ? {} : { confidence: ctx.payload.confidence }),
                ...(ctx.payload.source === undefined ? {} : { source: ctx.payload.source }),
                ...(ctx.payload.agent === undefined ? {} : { agent: ctx.payload.agent }),
                ...(ctx.payload.validFrom === undefined ? {} : { validFrom: ctx.payload.validFrom }),
                ...(ctx.payload.evidence === undefined
                  ? {}
                  : {
                      evidence: ctx.payload.evidence.map((item) => ({
                        kind: item.kind,
                        locator: item.locator,
                        ...(item.label === undefined ? {} : { label: item.label }),
                      })),
                    }),
                relation: "staged" as const,
              },
              MemoryAccess.owner(),
            ),
          )
          return {
            ok: result.ok,
            ...(result.id === undefined ? {} : { id: result.id }),
            ...(result.status === undefined ? {} : { status: result.status }),
            ...(result.identified === undefined ? {} : { identified: result.identified }),
            ...(result.deduped === undefined ? {} : { deduped: result.deduped }),
            superseded: result.superseded,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          }
        }),
      ),
  ),
)
