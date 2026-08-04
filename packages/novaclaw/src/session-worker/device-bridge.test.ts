import { expect, test } from "bun:test"
import { Effect } from "effect"
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
