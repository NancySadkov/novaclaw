import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { SessionWorkerMemoryBridge } from "./memory-bridge"
import { SessionWorkerRunnerLayer } from "./runner-layer"
import { SessionWorkerServices } from "./services"
import type { SessionWorkerCapabilities } from "./capabilities"

/**
 * ─── ONE WRITER ON THE MEMORY GRAPH ──────────────────────────────────────────────────────────────
 *
 * 🔴 `session-worker/services.ts` replaced seven host-owned services and not `Memory.node`, so a
 * session worker built a REAL second WASM engine on `<instance data>/memory/graph`. The host's engine
 * is lazy, so the two only coexisted when something host-side touched memory during a live turn —
 * which is exactly what the Memory app does, and exactly the case nothing tested. With generation
 * snapshots in the store that stopped being merely redundant: `publish()` picks `max(existing) + 1`,
 * so two writers can choose the SAME index and each prunes to KEEP=2 knowing nothing about the
 * other's generations.
 *
 * The tests below hold the two halves of the fix: the worker asks (its graph can no longer reach the
 * real engine layer) and the host answers (the bridge dispatches onto the ONE observed store).
 */

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_memory"),
  attemptID: "exe_worker_memory",
  generation: 3,
  ownerID: "host",
}
const base = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
}
const request = (op: string, args: readonly unknown[], overrides: Record<string, unknown> = {}) =>
  ({ ...base, type: "memory-request", store: "kb", requestID: "rpc_mem_1", op, args, ...overrides }) as never

const run = (memory: MemoryClient.Interface, message: ReturnType<typeof request>) =>
  Effect.runPromise(SessionWorkerMemoryBridge.handle({ memory, lease, message }))

// ─── the worker's side: its graph cannot reach the real engine ───────────────────────────────────

test("🔴 the worker's compiled graph declares a memory capability that is NOT the real engine layer", () => {
  const capabilities = SessionWorkerServices.replacements({} as SessionWorkerCapabilities.Capabilities)
  const declared = LayerNode.capabilities(SessionWorkerRunnerLayer.root, capabilities)
  const memory = declared.find((node) => node.capabilityName === "memory")
  // Present: a worker that could not reach memory at all would break auto-recall, the `kb` tool and
  // auto-extraction, which is a different bug wearing this one's fix.
  expect(memory).toBeDefined()
  // 🔴 And it is not `Memory.serviceNode`, which is the node whose layer calls `WasmMemory.open`.
  // This is the whole property, stated against the graph the worker actually compiles rather than
  // against the source of `replacements()`.
  expect(memory?.inner).not.toBe(Memory.serviceNode)
})

test("the check can still see the defect it exists for — a control, so the green above means something", () => {
  // The same computation WITHOUT the memory replacement must find the real engine layer. Without
  // this, a `capabilities()` that silently returned nothing would leave the test above green forever.
  const withoutMemory = SessionWorkerServices.replacements({} as SessionWorkerCapabilities.Capabilities).filter(
    ([source]) => source !== Memory.node,
  )
  const declared = LayerNode.capabilities(SessionWorkerRunnerLayer.root, withoutMemory)
  expect(declared.find((node) => node.capabilityName === "memory")?.inner).toBe(Memory.serviceNode)
})

test("a worker memory op becomes one RPC, and the host's refusal comes back as an ordinary MemoryError", async () => {
  const asked: Array<{ op: string; args: readonly unknown[] }> = []
  const services = SessionWorkerServices.make({
    memory: async (op: string, args: readonly unknown[]) => {
      asked.push({ op, args })
      return {
        ...base,
        type: "memory-result",
        store: "kb",
        requestID: "rpc_mem_1",
        outcome: "failed",
        reason: "engine is closed",
      }
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)

  const failure = await Effect.runPromiseExit(services.memory.search({ query: "mittens", scopes: ["global"] }))
  expect(Exit.isFailure(failure)).toBe(true)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.op).toBe("search")
  expect((asked[0]?.args[0] as { query: string }).query).toBe("mittens")
  // Degrades, never dies: every consumer already handles `MemoryError`, and a turn must not end
  // because the store said no.
  if (Exit.isFailure(failure))
    expect((Cause.squash(failure.cause) as MemoryClient.MemoryError).reason).toBe("engine is closed")
})

test("health answers false when the RPC itself cannot be made, rather than failing the turn", async () => {
  const services = SessionWorkerServices.make({
    memory: async () => {
      throw new Error("transport closed")
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)
  expect(await Effect.runPromise(services.memory.health())).toBe(false)
})

// ─── the host's side: the bridge dispatches onto the one store ───────────────────────────────────

test("a claim written inside a turn lands in the HOST's store, with the session's own access", async () => {
  let seen: MemoryAccess.MemoryAccess | undefined
  const store: MemoryClient.Interface = {
    ...MemoryClient.stub(),
    addClaim: (_input, access) => {
      seen = access
      return Effect.succeed({ ok: true, id: "mem_1", status: "active" as const, superseded: [] })
    },
  }
  const reply = await run(
    store,
    request("addClaim", [
      { scope: "session:x", statement: "the probe cat is called Mittens" },
      MemoryAccess.of(["session:x"]),
    ]),
  )
  expect(reply.outcome).toBe("ok")
  expect((reply.value as { id: string }).id).toBe("mem_1")
  expect(seen?.as).toBe("session")
  expect(seen?.scopes).toEqual(["session:x"])
})

test("🔴 an access whose scope set was LOST in transit is refused, never widened", async () => {
  let reached = false
  const store: MemoryClient.Interface = {
    ...MemoryClient.stub(),
    purge: () => {
      reached = true
      return Effect.void
    },
  }
  // `{ as: "session" }` with no `scopes` is what a truncated or reshaped payload looks like — and
  // `scopes: undefined` means EVERY SCOPE at the other end. That is the NC-SEC-016 mechanism exactly:
  // an absent field is not an error, it is a wider query.
  const reply = await run(store, request("purge", ["mem_secret", { as: "session" }]))
  expect(reply.outcome).toBe("rejected")
  expect(reached).toBe(false)
  // The two levels that are unrestricted ON PURPOSE still work — they say so in the payload.
  expect((await run(store, request("purge", ["mem_secret", MemoryAccess.system()]))).outcome).toBe("ok")
  expect(reached).toBe(true)
})

test("a stale lease is rejected before the store is touched", async () => {
  let reached = false
  const store: MemoryClient.Interface = {
    ...MemoryClient.stub(),
    stats: () => {
      reached = true
      return Effect.succeed({ total: 0, valid: 0 })
    },
  }
  const reply = await run(store, request("stats", [], { generation: lease.generation + 1 }))
  expect(reply.outcome).toBe("rejected")
  expect(reached).toBe(false)
})

test("a result too large for the logical protocol is a failure, not a corrupted stream", async () => {
  const huge = [
    {
      id: "mem_huge",
      kind: "passage" as const,
      text: "x".repeat(SessionWorkerProtocol.MAX_MESSAGE_BYTES + 1),
      name: null,
      scope: "global",
      source: null,
      confidence: null,
      relation: "staged" as const,
      status: "active" as const,
      subject: null,
      predicate: null,
      conflictKey: null,
      supersededBy: null,
      evidence: null,
      evidenceKind: null,
    },
  ]
  const store: MemoryClient.Interface = { ...MemoryClient.stub(), list: () => Effect.succeed(huge) }
  const reply = await run(store, request("list", [{ limit: 1 }]))
  expect(reply.outcome).toBe("failed")
  expect(reply.reason).toContain("too large")
})

test("the store's own failure crosses as a failure carrying its reason", async () => {
  const store: MemoryClient.Interface = {
    ...MemoryClient.stub(),
    stats: () => Effect.fail(new MemoryClient.MemoryError({ reason: "graph directory is unreadable" })),
  }
  const reply = await run(store, request("stats", []))
  expect(reply.outcome).toBe("failed")
  expect(reply.reason).toBe("graph directory is unreadable")
})
