import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { SessionSchema } from "@novaclaw/core/session/schema"
import type { LocalModel } from "@novaclaw/schema/local-model"
import { LocalModelRuntime } from "../local-model/runtime"
import { ServerLocationServiceMap } from "../location-service-map"
import { SessionWorkerLocalModelBridge } from "./local-model-bridge"
import { SessionWorkerRunnerLayer } from "./runner-layer"
import { SessionWorkerServices } from "./services"
import type { SessionWorkerCapabilities } from "./capabilities"

/**
 * ─── ONE LLAMA.CPP CHILD PER INSTANCE, INSIDE A TURN TOO ─────────────────────────────────────────
 *
 * 🔴 `ServerLocationServiceMap.replacements` points `LocalModelManager.node` at the real runtime, and
 * `runner-layer.ts` compiles that list into every session worker. So each worker built its OWN
 * `LocalModelRuntime` — own `state`, own `child` — and `ensure()`, which every provider turn calls,
 * could never find the host's engine "already ready" in a fresh process: it spawned a second
 * `llama-server` on the same fixed port, or owned the only one and had it tree-killed with the
 * worker at the end of the turn.
 *
 * The tests below hold the two halves of the fix: the worker's compiled graph cannot reach the
 * runtime (it asks), and the host's bridge dispatches onto the ONE runtime (it answers).
 */

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_local_model"),
  attemptID: "exe_worker_local_model",
  generation: 3,
  ownerID: "host",
}
const base = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
}
const managed = {
  providerID: "novaclaw-local",
  modelID: "qwen",
  apiModelID: "qwen3-30b",
  baseURL: "http://127.0.0.1:8081/v1",
  context: 32_768,
}
const request = (args: readonly unknown[], overrides: Record<string, unknown> = {}) =>
  ({ ...base, type: "local-model-request", requestID: "rpc_lm_1", op: "ensure", args, ...overrides }) as never
const status: LocalModel.Status = {
  supported: true,
  platform: "test",
  profiles: [],
  stage: "ready",
  recommendedContext: 32_768,
}
const manager = (ensure: LocalModelManager.Interface["ensure"]): LocalModelManager.Interface => ({
  status: () => Effect.succeed(status),
  install: () => Effect.succeed(status),
  ensure,
  stop: () => Effect.succeed(status),
})
const run = (impl: LocalModelManager.Interface, message: ReturnType<typeof request>) =>
  Effect.runPromise(SessionWorkerLocalModelBridge.handle({ manager: impl, lease, message }))

/** What `runner-layer.ts` compiles: the server's location replacements, then the worker's. */
const workerReplacements = (
  worker = SessionWorkerServices.replacements({} as SessionWorkerCapabilities.Capabilities),
) => ServerLocationServiceMap.replacements.concat(worker)

// ─── the worker's side: its graph cannot reach the runtime ───────────────────────────────────────

test("🔴 the worker's compiled graph declares NO local-model capability — the runtime is unreachable", () => {
  const declared = LayerNode.capabilities(SessionWorkerRunnerLayer.root, workerReplacements())
  // The real runtime enters the graph as the `local-model` capability (`LocalModelRuntime.node`).
  // With the worker's replacement in place the manager is a plain RPC client and the capability,
  // with the runtime behind it, is not in the graph at all.
  expect(declared.find((node) => node.capabilityName === "local-model")).toBeUndefined()
})

test("the check can still see the defect it exists for — a control, so the green above means something", () => {
  // The same computation WITHOUT the worker's `LocalModelManager` replacement must find the runtime:
  // that is the graph every worker compiled before this fix.
  const withoutLocalModel = SessionWorkerServices.replacements({} as SessionWorkerCapabilities.Capabilities).filter(
    ([source]) => source !== LocalModelManager.node,
  )
  const declared = LayerNode.capabilities(SessionWorkerRunnerLayer.root, workerReplacements(withoutLocalModel))
  expect(declared.find((node) => node.capabilityName === "local-model")?.inner).toBe(LocalModelRuntime.serviceNode)
})

test("a worker ensure becomes one RPC, and the host's refusal comes back as the resolver's UnavailableError", async () => {
  const asked: Array<{ op: string; args: readonly unknown[] }> = []
  const services = SessionWorkerServices.make({
    localModel: async (op: string, args: readonly unknown[]) => {
      asked.push({ op, args })
      return {
        ...base,
        type: "local-model-result",
        requestID: "rpc_lm_1",
        outcome: "failed",
        reason: "llama-server could not bind its port",
      }
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)

  const failure = await Effect.runPromiseExit(services.localModel.ensure(managed))
  expect(Exit.isFailure(failure)).toBe(true)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.op).toBe("ensure")
  expect((asked[0]?.args[0] as { apiModelID: string }).apiModelID).toBe("qwen3-30b")
  if (Exit.isFailure(failure)) {
    const error = Cause.squash(failure.cause) as LocalModelManager.UnavailableError
    expect(error._tag).toBe("LocalModelManager.UnavailableError")
    expect(error.message).toBe("llama-server could not bind its port")
  }
})

test("a worker ensure that the host accepts succeeds with nothing to say", async () => {
  const services = SessionWorkerServices.make({
    localModel: async () => ({ ...base, type: "local-model-result", requestID: "rpc_lm_1", outcome: "ok" }),
  } as unknown as SessionWorkerCapabilities.Capabilities)
  expect(await Effect.runPromise(services.localModel.ensure(managed))).toBeUndefined()
})

test("🔴 the status-shaped ops never cross the boundary: a worker cannot stop the host's engine", async () => {
  let crossed = 0
  const services = SessionWorkerServices.make({
    localModel: async () => {
      crossed += 1
      return { ...base, type: "local-model-result", requestID: "rpc_lm_1", outcome: "ok" }
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)
  const stopped = await Effect.runPromise(services.localModel.stop())
  const seen = await Effect.runPromise(services.localModel.status())
  await Effect.runPromise(services.localModel.install("qwen"))
  expect(crossed).toBe(0)
  // Their contract never fails, so the answer is a status that names the boundary, not a throw.
  expect(stopped.supported).toBe(false)
  expect(seen.message).toContain("host process")
})

// ─── the host's side: the bridge dispatches onto the one runtime ─────────────────────────────────

test("an ensure inside a turn lands on the HOST's runtime with the request intact", async () => {
  let seen: LocalModelManager.ModelRequest | undefined
  const reply = await run(
    manager((req) => {
      seen = req
      return Effect.void
    }),
    request([managed]),
  )
  expect(reply.outcome).toBe("ok")
  expect(seen).toEqual(managed)
})

test("the host's UnavailableError comes back as `failed`, carrying its message", async () => {
  const reply = await run(
    manager(() => Effect.fail(new LocalModelManager.UnavailableError({ message: "not enough memory to load" }))),
    request([managed]),
  )
  expect(reply.outcome).toBe("failed")
  expect(reply.reason).toBe("not enough memory to load")
})

test("🔴 a request that lost its model id in transit is refused, never answered ok", async () => {
  let reached = false
  const reply = await run(
    manager(() => {
      reached = true
      return Effect.void
    }),
    request([{ providerID: "novaclaw-local", modelID: "qwen" }]),
  )
  expect(reply.outcome).toBe("rejected")
  expect(reached).toBe(false)
})

test("a request from a superseded attempt is rejected before it reaches the runtime", async () => {
  let reached = false
  const reply = await run(
    manager(() => {
      reached = true
      return Effect.void
    }),
    request([managed], { generation: lease.generation + 1 }),
  )
  expect(reply.outcome).toBe("rejected")
  expect(reached).toBe(false)
})
