import { expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionWorkerDeviceBridge } from "./device-bridge"

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_device"),
  attemptID: "exe_worker_device",
  generation: 3,
  ownerID: "host",
}
const request = (
  type:
    | "device-admit"
    | "device-release"
    | "device-report"
    | "device-maintenance-admit"
    | "device-maintenance-release"
    | "device-maintenance-await-preemption",
  extra: Record<string, unknown> = {},
) =>
  ({
    version: 1,
    type,
    sessionID: lease.sessionID,
    attemptID: lease.attemptID,
    generation: lease.generation,
    requestID: `rpc_${type}`,
    deviceKey: "provider/model",
    ...extra,
  }) as SessionWorkerDeviceBridge.Request

test("worker device admission remains globally visible and exit reclaim frees it", async () => {
  const scheduler = SessionScheduler.make()
  const admitted = await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-admit", { sessionClass: "interactive" }),
    }),
  )
  expect(admitted.type).toBe("device-admitted")
  expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightInteractive).toEqual([lease.sessionID])
  await Effect.runPromise(SessionWorkerDeviceBridge.reclaim(scheduler, lease))
  expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightInteractive).toEqual([])
})

test("host scheduler receives the device's declared capacity and locality", async () => {
  const scheduler = SessionScheduler.make()
  await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-admit", {
        sessionClass: "auto-prompting",
        concurrency: 5,
        locality: "local",
      }),
    }),
  )
  expect((await Effect.runPromise(scheduler.snapshot()))[0]).toMatchObject({ concurrency: 5, locality: "local" })
})

test("maintenance admission crosses the worker boundary as a host-owned unique lease", async () => {
  const scheduler = SessionScheduler.make()
  const admitted = await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-maintenance-admit", {
        task: "session-title",
        concurrency: 3,
        locality: "lan",
      }),
    }),
  )
  expect(admitted.type).toBe("device-maintenance-admitted")
  if (admitted.type !== "device-maintenance-admitted") throw new Error("maintenance admission failed")
  expect(admitted.maintenanceID).toContain("session-title")
  expect(admitted.maintenanceID).toContain(lease.sessionID)
  expect((await Effect.runPromise(scheduler.snapshot()))[0]).toMatchObject({
    concurrency: 3,
    locality: "lan",
    inFlightMaintenance: [admitted.maintenanceID],
  })

  const released = await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-maintenance-release", { maintenanceID: admitted.maintenanceID }),
    }),
  )
  expect(released.type).toBe("device-maintenance-released")
  expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightMaintenance).toEqual([])
})

test("an interactive arrival preempts worker-owned maintenance", async () => {
  const scheduler = SessionScheduler.make()
  const admitted = await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-maintenance-admit", { task: "session-compaction" }),
    }),
  )
  expect(admitted.type).toBe("device-maintenance-admitted")
  if (admitted.type !== "device-maintenance-admitted") throw new Error("maintenance admission failed")

  const preempted = Effect.runFork(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-maintenance-await-preemption", { maintenanceID: admitted.maintenanceID }),
    }),
  )
  await Effect.runPromise(
    scheduler.admit({ sessionID: "foreground", deviceKey: "provider/model", sessionClass: "interactive" }),
  )
  expect((await Effect.runPromise(Fiber.join(preempted))).type).toBe("device-maintenance-preempted")
})

test("worker-exit reclaim releases an acquired maintenance lease", async () => {
  const scheduler = SessionScheduler.make()
  const admitted = await Effect.runPromise(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-maintenance-admit", { task: "memory-extract" }),
    }),
  )
  expect(admitted.type).toBe("device-maintenance-admitted")
  expect((await Effect.runPromise(scheduler.snapshot()))[0]!.inFlightMaintenance).toHaveLength(1)

  await Effect.runPromise(SessionWorkerDeviceBridge.reclaim(scheduler, lease))
  expect((await Effect.runPromise(scheduler.snapshot()))[0]!.inFlightMaintenance).toEqual([])
})

test("release/report are host-owned and invalid or stale requests fail closed", async () => {
  const scheduler = SessionScheduler.make()
  expect(
    (
      await Effect.runPromise(
        SessionWorkerDeviceBridge.handle({
          scheduler,
          lease,
          message: request("device-report", { costTokens: -1 }),
        }),
      )
    ).type,
  ).toBe("device-rejected")
  expect(
    (
      await Effect.runPromise(
        SessionWorkerDeviceBridge.handle({
          scheduler,
          lease,
          message: { ...request("device-release"), generation: lease.generation - 1 },
        }),
      )
    ).type,
  ).toBe("device-rejected")
})

test("evicting a queued worker admission produces no admitted reply", async () => {
  const scheduler = SessionScheduler.make()
  await Effect.runPromise(
    scheduler.admit({ sessionID: "ses_blocker", deviceKey: "provider/model", sessionClass: "interactive" }),
  )
  let reply: SessionWorkerDeviceBridge.Reply | undefined
  const pending = Effect.runFork(
    SessionWorkerDeviceBridge.handle({
      scheduler,
      lease,
      message: request("device-admit", { sessionClass: "auto-prompting" }),
    }).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          reply = value
        }),
      ),
    ),
  )
  await Bun.sleep(20)

  await Effect.runPromise(scheduler.evict(lease.sessionID))

  const exit = await Effect.runPromise(Fiber.await(pending))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(reply).toBeUndefined()
  expect((await Effect.runPromise(scheduler.snapshot()))[0]?.waiting).toEqual([])
})
