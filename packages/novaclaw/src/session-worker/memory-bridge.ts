export * as SessionWorkerMemoryBridge from "./memory-bridge"

import { Effect } from "effect"
import type * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "memory-request" }>
export type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "memory-result" }>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
  store: message.store,
})

const ok = (message: Request, value: unknown): Reply => ({
  ...identity(message),
  type: "memory-result",
  outcome: "ok",
  ...(value === undefined ? {} : { value }),
})

const failed = (message: Request, reason: string): Reply => ({
  ...identity(message),
  type: "memory-result",
  outcome: "failed",
  reason,
})

const rejected = (message: Request, reason: string): Reply => ({
  ...identity(message),
  type: "memory-result",
  outcome: "rejected",
  reason,
})

/**
 * 🔴 **THE ONE ARGUMENT THAT IS DECODED, and why only this one.**
 *
 * `MemoryAccess.scopes === undefined` means EVERY SCOPE. That is deliberate and named at its
 * definition (`memory-access.ts`), and it is also exactly the mechanism NC-SEC-016 was: an absent
 * scope set is not an error, it is a WIDER query. Across a JSON boundary an absent field and a
 * deliberately unrestricted one look identical, so a truncated or reshaped payload would arrive as
 * owner-level reach with nothing to notice it.
 *
 * So the bridge refuses anything it cannot read as a whole access: `as` must be present and known,
 * and a `session` access must carry an array — `undefined` is reachable only through the two levels
 * that say out loud that they are unrestricted.
 *
 * ⚠️ **This is not a confinement gate and must not be described as one.** A worker runs our own
 * runner, and before this change it opened the engine directly with no restriction whatsoever; what
 * the boundary buys is that there is now ONE WRITER, not that the worker asks for less. The check
 * here buys exactly one thing: a malformed access fails loudly instead of widening silently.
 */
const decodeAccess = (raw: unknown): MemoryAccess.MemoryAccess | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const as = (raw as { readonly as?: unknown }).as
  if (as !== "owner" && as !== "session" && as !== "system") return undefined
  const scopes = (raw as { readonly scopes?: unknown }).scopes
  if (scopes === undefined || scopes === null) return as === "session" ? undefined : { scopes: undefined, as }
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) return undefined
  return { scopes: scopes as readonly string[], as }
}

/**
 * Run ONE memory operation on the host's engine and answer the worker.
 *
 * 🔴 **This is what makes `memory.ts`'s single-writer header true.** The worker's `Memory.node`
 * replacement turns every op into a `memory-request`; this is the other end. The store it reaches is
 * the one `layerFromConfig` provides, which means the OBSERVED one — so a claim written from inside
 * a turn publishes its `memory.*` event and writes its access-ledger row on the host, through the
 * same wrapper the Memory app and the HTTP routes go through. A second engine in the worker
 * published to the worker's own bus, which nothing outside that process was listening to.
 *
 * ⚠️ **The switch is exhaustive over `MEMORY_OPS` on purpose.** `op satisfies never` in the default
 * arm is what turns "somebody added a method to `MemoryClient.Interface`" into a compile error here
 * rather than a runtime hole that only shows up on the one path nobody tests.
 */
export const handle = Effect.fn("SessionWorkerMemoryBridge.handle")(function* (input: {
  readonly memory: MemoryClient.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  const message = input.message
  if (!SessionWorkerProtocol.owns(input.lease, message)) return rejected(message, "execution ownership changed")
  const memory = input.memory
  const args = message.args
  const access = (index: number) => decodeAccess(args[index])

  // Every arm below either returns a Reply directly (a refusal) or runs the op. The failure
  // translation and the transport bound are written once, here.
  //
  // ⚠️ **A result too large for the logical protocol is a REJECTION, not a truncation.** The worker
  // transport caps a logical message (`MAX_MESSAGE_BYTES`) and a decoder on the far side would fail the
  // whole worker rather than the call. None of the ops a worker actually makes returns anything near
  // that — `search` is `k` rows, `byIds` is a handful — but "none of them today" is not a bound, and
  // a graph slice of a real document would be. So it is answered as an ordinary memory failure, which
  // every caller already degrades on, instead of killing the turn.
  //
  // 🔴 **The guard is measured in BYTES, because that is the unit the far side enforces.** It used to
  // read `encodeLine(reply).length`, i.e. UTF-16 code units, against a byte budget,
  // so the guard was TOO PERMISSIVE by exactly the string's bytes-per-unit ratio — 2 for Cyrillic or
  // an astral-plane emoji, 3 for CJK. A ~400 KB Cyrillic passage set counts ~400 000 units (passes)
  // and ~1.2 MB (the decoder fails the whole worker). A guard whose whole job is to keep a decoder
  // from killing the worker must therefore compute the decoder's own number and nothing else — see
  // `decodeLine` in `core/session/execution/worker-protocol.ts`, which is where the answer is
  // adjudicated. Physical pipe framing is a separate, smaller bound and reassembles before this one.
  const withinTransportBound = (line: string) =>
    new TextEncoder().encode(line).byteLength <= SessionWorkerProtocol.MAX_MESSAGE_BYTES
  const run = (effect: Effect.Effect<unknown, MemoryClient.MemoryError>) =>
    effect.pipe(
      Effect.match({
        onFailure: (error: MemoryClient.MemoryError) => failed(message, error.reason),
        onSuccess: (value: unknown) => {
          const reply = ok(message, value)
          return withinTransportBound(SessionWorkerProtocol.encodeLine(reply))
            ? reply
            : failed(message, `memory ${message.op} result is too large for the worker transport`)
        },
      }),
    )
  const malformedAccess = () => rejected(message, `memory op ${message.op} carried a malformed access set`)

  switch (message.op) {
    case "health":
      return yield* memory.health().pipe(Effect.map((value) => ok(message, value)))
    case "addMemory":
      return yield* run(memory.addMemory(args[0] as MemoryClient.MemoryInput))
    case "addEdge": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.addEdge(args[0] as MemoryClient.EdgeInput, a))
    }
    case "search":
      return yield* run(memory.search(args[0] as MemoryClient.SearchInput))
    case "neighbors": {
      const a = access(1)
      return a === undefined
        ? malformedAccess()
        : yield* run(memory.neighbors(String(args[0]), a, args[2] as { k?: number } | undefined))
    }
    case "get": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.get(String(args[0]), a))
    }
    case "path": {
      const a = access(2)
      return a === undefined
        ? malformedAccess()
        : yield* run(memory.path(String(args[0]), String(args[1]), a, args[3] as number | undefined))
    }
    case "invalidate": {
      const a = access(1)
      return a === undefined
        ? malformedAccess()
        : yield* run(memory.invalidate(String(args[0]), a, args[2] as string | undefined))
    }
    case "purge": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.purge(String(args[0]), a))
    }
    case "addClaim": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.addClaim(args[0] as MemoryClient.ClaimInput, a))
    }
    case "claimHistory": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.claimHistory(String(args[0]), a))
    }
    case "reviewEvidence": {
      const a = access(1)
      return a === undefined ? malformedAccess() : yield* run(memory.reviewEvidence(String(args[0]), a))
    }
    case "setClaimStatus": {
      const a = access(2)
      const status = args[1]
      if (status !== "active" && status !== "archived" && status !== "needs_review")
        return rejected(message, "setClaimStatus carried an unknown status")
      return a === undefined ? malformedAccess() : yield* run(memory.setClaimStatus(String(args[0]), status, a))
    }
    case "moveScope":
      return yield* run(memory.moveScope(String(args[0]), String(args[1])))
    case "clearScope":
      return yield* run(memory.clearScope(String(args[0])))
    case "eraseAll":
      return yield* run(memory.eraseAll())
    case "discardLegacyGlobalExtracts":
      return yield* run(memory.discardLegacyGlobalExtracts())
    case "stats":
      return yield* run(memory.stats())
    case "list":
      return yield* run(memory.list(args[0] as MemoryClient.ListInput | undefined))
    case "candidates":
      return yield* run(memory.candidates(args[0] as MemoryClient.CandidateInput | undefined))
    case "byIds":
      return yield* run(memory.byIds((args[0] as readonly string[] | undefined) ?? []))
    case "graph":
      return yield* run(memory.graph(args[0] as MemoryClient.GraphInput | undefined))
    default:
      return rejected(message, `unknown memory op ${message.op satisfies never}`)
  }
})
