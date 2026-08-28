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
const request = (type: "device-admit" | "device-release" | "device-report", extra: Record<string, unknown> = {}) =>
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
