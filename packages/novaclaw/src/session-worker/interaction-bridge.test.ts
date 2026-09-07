import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionSchema } from "@novaclaw/core/session/schema"
import type { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionWorkerInteractionBridge } from "./interaction-bridge"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { SessionJoin } from "@novaclaw/core/session/join"

const joinStub: SessionJoin.Interface = {
  awaitCompletion: () => Effect.die(new Error("join is not exercised by this test")),
}

const spawnerStub: SessionSpawner.Interface = {
  spawn: () => Effect.die(new Error("spawn is not exercised by this test")),
}

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_interaction"),
  attemptID: "exe_worker_interaction",
  generation: 5,
  ownerID: "host",
}
const base = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
}
const unusedPermission = {
  ask: () => Effect.die("unused"),
  assert: () => Effect.void,
} as PermissionV2.Interface

/** Colleague hand-off is host-side; these cases exercise the OTHER requests, so it must never run. */
const colleagueStub = {
  deliver: () => Effect.die("unused"),
  deliverGroup: () => Effect.die("unused"),
  hire: () => Effect.die("unused"),
  setSuperior: () => Effect.die("unused"),
  retire: () => Effect.die("unused"),
} as ColleagueHandoff.Interface

test("permission assertions stay in host services", async () => {
  const permission = {
    ...unusedPermission,
    assert: (value: PermissionV2.AssertInput) =>
      value.sessionID === lease.sessionID ? Effect.void : Effect.die("cross-session permission"),
  }
  const allowed = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission,
      spawner: spawnerStub,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: {
        ...base,
        type: "permission-assert",
        requestID: "rpc_permission",
        input: { sessionID: lease.sessionID, action: "read", resources: ["README.md"] },
      },
    }),
  )
  expect(allowed).toMatchObject({ type: "permission-result", outcome: "allowed" })
})

test("permission denial details survive while stale and cross-session requests fail closed", async () => {
  const deniedPermission = {
    ...unusedPermission,
    assert: () =>
      Effect.fail(
        new PermissionV2.DeniedError({
          rules: [{ action: "write", resource: "outside", effect: "deny" }],
          reason: "unattended-confined",
        }),
      ),
  } as PermissionV2.Interface
  const denied = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: deniedPermission,
      spawner: spawnerStub,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: {
        ...base,
        type: "permission-assert",
        requestID: "rpc_denied",
        input: { sessionID: lease.sessionID, action: "write", resources: ["outside"] },
      },
    }),
  )
  expect(denied).toMatchObject({
    type: "permission-result",
    outcome: "denied",
    reason: "unattended-confined",
  })

  const stale = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: deniedPermission,
      spawner: spawnerStub,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: {
        ...base,
        generation: lease.generation - 1,
        type: "permission-assert",
        requestID: "rpc_stale",
        input: { sessionID: lease.sessionID, action: "read", resources: ["README.md"] },
      },
    }),
  )
  expect(stale).toMatchObject({ type: "permission-result", outcome: "rejected" })
})

// 🔴 THE regression guard for the 2026-08-04 → 2026-08-06 outage: `spawn` was dead on the live runner
// and nothing below a Spark-and-served-model smoke could see it.
//
// The cause was structural. `spawn` creates a child session record and admits the child's first input
// — two events carrying an id that is NOT the worker's lease — and `event-bridge.ts` rejects exactly
// that, by design and with its own test. So the worker now ASKS the host, like `permission-assert`,
// and these are the unit-level checks that were missing the whole time.
const spawnRequest = {
  ...base,
  type: "spawn-child" as const,
  requestID: "req_spawn",
  input: { text: "do the thing" },
}

test("🔴 the host spawns with the LEASE's session as parent — the payload cannot name one", async () => {
  // The security property, and it is structural rather than validated: `SpawnChild` has no parentID
  // field at all, so a worker can spawn children of itself and of nothing else. If this ever starts
  // reading a parent from the payload, a worker could graft a child onto any session it can name.
  let sawParent: string | undefined
  const spawner: SessionSpawner.Interface = {
    spawn: (input) => {
      sawParent = input.parentID
      return Effect.succeed({ id: SessionSchema.ID.make("ses_child"), started: true })
    },
  }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: spawnRequest,
    }),
  )
  expect(sawParent).toBe(lease.sessionID)
  expect(reply).toMatchObject({ type: "spawn-result", outcome: "spawned", child: "ses_child", started: true })
})

test("a stale lease is refused before the spawner is reached", async () => {
  // The generation fence: a worker whose lease was superseded must not create sessions. `spawn` is
  // the one operation where doing so would leave a durable orphan behind.
  let called = false
  const spawner: SessionSpawner.Interface = {
    spawn: () => {
      called = true
      return Effect.succeed({ id: SessionSchema.ID.make("ses_child"), started: true })
    },
  }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: { ...spawnRequest, generation: lease.generation - 1 },
    }),
  )
  expect(called).toBe(false)
  expect(reply).toMatchObject({ type: "spawn-result", outcome: "rejected" })
})

test("🔴 a quota refusal arrives as `limit`, not as a transport rejection", async () => {
  // These are different facts and the model acts on them differently: "you have hit the child limit"
  // is something it can reason about, "rejected" means its worker is stale and nothing it does helps.
  // Collapsing them would tell a model it hit a quota when the truth was a stale lease.
  const spawner: SessionSpawner.Interface = {
    spawn: () => Effect.fail(new SessionSpawner.SpawnLimitError({ reason: "children", depth: 4, limit: 4 })),
  }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: spawnRequest,
    }),
  )
  expect(reply).toMatchObject({ type: "spawn-result", outcome: "limit", reason: "children", depth: 4, limit: 4 })
})

test("the optional fields ride through, and absent ones stay absent", async () => {
  let saw: Record<string, unknown> | undefined
  const spawner: SessionSpawner.Interface = {
    spawn: (input) => {
      saw = input as unknown as Record<string, unknown>
      return Effect.succeed({ id: SessionSchema.ID.make("ses_child"), started: false })
    },
  }
  await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner,
      join: joinStub,
      colleague: colleagueStub,
      lease,
      message: {
        ...spawnRequest,
        input: { text: "t", agent: "plan", controlBinding: ":100", permissionMode: "ask" },
      },
    }),
  )
  expect(saw?.agent).toBe("plan")
  expect(saw?.permissionMode).toBe("ask")
  expect(saw?.controlBinding).toBe(":100")
  // An absent option must not become an explicit `undefined` — `resolveConfig` narrows against the
  // parent chain, and a present-but-undefined field is not the same as inheriting.
  expect("model" in (saw ?? {})).toBe(false)
})

// 🔴 `wait`'s half of the same outage. It joined a child through `events.durable(...)`, and the
// worker's EventV2 replacement dies on the durable stream — so `wait` failed inside every session
// worker with "only works in host-only contexts". It stayed invisible until `spawn` was fixed,
// because the live smoke exits at its first failure and spawn failed earlier.
const awaitRequest = {
  ...base,
  type: "await-child" as const,
  requestID: "req_await",
  input: { childID: SessionSchema.ID.make("ses_child"), timeoutMs: 5_000 },
}

test("a completed child returns its result", async () => {
  const join: SessionJoin.Interface = {
    awaitCompletion: () => Effect.succeed({ completed: true, result: "EXIT-MARKER-42" }),
  }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner: spawnerStub,
      join,
      colleague: colleagueStub,
      lease,
      message: awaitRequest,
    }),
  )
  expect(reply).toMatchObject({ type: "await-child-result", outcome: "completed", result: "EXIT-MARKER-42" })
})

test("🔴 a timeout is a normal ANSWER, not a rejection", async () => {
  // The child may simply still be working. Reporting "rejected" would tell the model its worker is
  // stale — a different fact entirely, and one it would act on differently.
  const join: SessionJoin.Interface = { awaitCompletion: () => Effect.succeed({ completed: false }) }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner: spawnerStub,
      join,
      colleague: colleagueStub,
      lease,
      message: awaitRequest,
    }),
  )
  expect(reply).toMatchObject({ type: "await-child-result", outcome: "timeout" })
  expect((reply as { result?: string }).result).toBeUndefined()
})

test("a stale lease is refused before the join is attempted", async () => {
  let called = false
  const join: SessionJoin.Interface = {
    awaitCompletion: () => {
      called = true
      return Effect.succeed({ completed: true, result: "x" })
    },
  }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner: spawnerStub,
      join,
      colleague: colleagueStub,
      lease,
      message: { ...awaitRequest, generation: lease.generation - 1 },
    }),
  )
  expect(called).toBe(false)
  expect(reply).toMatchObject({ type: "await-child-result", outcome: "rejected" })
})

test("a completed child with no result still reports completion", async () => {
  // `exit()` with no payload is legitimate — the join succeeded and there is simply nothing to show.
  const join: SessionJoin.Interface = { awaitCompletion: () => Effect.succeed({ completed: true }) }
  const reply = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: unusedPermission,
      spawner: spawnerStub,
      join,
      colleague: colleagueStub,
      lease,
      message: awaitRequest,
    }),
  )
  expect(reply).toMatchObject({ type: "await-child-result", outcome: "completed" })
})
