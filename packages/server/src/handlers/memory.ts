import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Log } from "@novaclaw/schema/log"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryApi, handlerLayer } from "../handler-api"

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
    handlers.handle(
      "memory.erase",
      Effect.fn(function* () {
        const memory = Memory.client(yield* Memory.node.service)
        const erased = yield* memory.eraseAll().pipe(Effect.orElseSucceed(() => 0))
        yield* Log.event("kb.memory.erased", { "memory.rows": erased })
        return erased
      }),
    ),
  ),
)
