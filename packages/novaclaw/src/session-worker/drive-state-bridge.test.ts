import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionDriveState } from "@novaclaw/core/session/runner/drive-state"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerDriveStateBridge } from "./drive-state-bridge"
import { SessionWorkerServices } from "./services"
import type { SessionWorkerCapabilities } from "./capabilities"

/**
 * ─── THE RUNNER'S CROSS-DRAIN FACTS SURVIVE A DRAIN ──────────────────────────────────────────────
 *
 * 🔴 Six maps in `runner/llm.ts` were documented "session-scoped, must outlive a drain" and were
 * drain-scoped under the shipped executor: one worker is one drain, and the runner layer holding
 * the maps was built inside it and disposed with it. Every steer started a fresh worker, so the
 * barren-round stop never reached its bound, the coverage ledger restarted at the first file, and
 * the child-restart ceiling never counted — the three measured defects the maps were built to fix.
 *
 * The test that matters here is the one the finding asked for: state written by ONE drain's
 * worker is read by the NEXT drain's worker, through the boundary production actually uses. Two
 * `SessionWorkerServices.make()` clients stand in for two workers; one host store and the bridge
 * stand in for the host.
 */

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_drive_state"),
  attemptID: "exe_worker_drive_state",
  generation: 3,
  ownerID: "host",
}
const base = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
}

/** A worker whose `driveState` capability is wired straight into a host bridge over `store`. */
const worker = (store: SessionDriveState.Interface, requests: string[] = []) =>
  SessionWorkerServices.make({
    driveState: async (op: string, args: readonly unknown[]) => {
      requests.push(op)
      return Effect.runPromise(
        SessionWorkerDriveStateBridge.handle({
          store,
          lease,
          message: { ...base, type: "drive-state-request", requestID: `rpc_ds_${requests.length}`, op, args } as never,
        }),
      )
    },
  } as unknown as SessionWorkerCapabilities.Capabilities).driveState

test("🔴 facts saved by one drain's worker are loaded by the next drain's worker", async () => {
  const host = SessionDriveState.make()
  const requests: string[] = []
  const first = worker(host, requests)
  const second = worker(host, requests)

  // Drain 1: the set drive latched the request, opened files, and counted a barren round.
  await Effect.runPromise(
    first.save(lease.sessionID, {
      request: { asked: true, limit: 400, named: ["icons"] },
      opened: ["icon_001.svg", "icon_002.svg"],
      attempted: ["icon_001.svg", "icon_002.svg", "icon_003.svg"],
      barren: { barren: 1, lastOpened: 2 },
      joined: ["ses_child"],
      restartRounds: 1,
      runawayNudgedAtCalls: 75,
      compactionRetryAt: 123_456,
    }),
  )
  // Drain 2: a NEW worker hydrates — and sees drain 1's facts instead of six empty maps.
  const seen = await Effect.runPromise(second.load(lease.sessionID))
  expect(seen.request).toEqual({ asked: true, limit: 400, named: ["icons"] })
  expect(seen.opened).toEqual(["icon_001.svg", "icon_002.svg"])
  expect(seen.barren).toEqual({ barren: 1, lastOpened: 2 })
  expect(seen.joined).toEqual(["ses_child"])
  expect(seen.restartRounds).toBe(1)
  expect(seen.runawayNudgedAtCalls).toBe(75)
  expect(seen.compactionRetryAt).toBe(123_456)
  expect(requests).toEqual(["save", "load"])
})

test("a session the host has never seen hydrates as `empty`, not as an error", async () => {
  const seen = await Effect.runPromise(worker(SessionDriveState.make()).load(lease.sessionID))
  expect(seen).toEqual(SessionDriveState.empty)
})

test("a host that cannot be reached answers `empty` on load and drops the save — a fresh drain, never a dead one", async () => {
  const services = SessionWorkerServices.make({
    driveState: async () => {
      throw new Error("transport closed")
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)
  expect(await Effect.runPromise(services.driveState.load(lease.sessionID))).toEqual(SessionDriveState.empty)
  expect(await Effect.runPromise(services.driveState.save(lease.sessionID, SessionDriveState.empty))).toBeUndefined()
})

test("🔴 the store is keyed by the LEASE's session, whatever the message claims", async () => {
  const host = SessionDriveState.make()
  const reply = await Effect.runPromise(
    SessionWorkerDriveStateBridge.handle({
      store: host,
      lease,
      message: {
        ...base,
        sessionID: SessionSchema.ID.make("ses_somebody_else"),
        type: "drive-state-request",
        requestID: "rpc_ds_x",
        op: "save",
        args: [{ ...SessionDriveState.empty, restartRounds: 9 }],
      } as never,
    }),
  )
  expect(reply.outcome).toBe("rejected")
  expect(await Effect.runPromise(host.load("ses_somebody_else"))).toEqual(SessionDriveState.empty)
})

test("🔴 a snapshot that lost a field in transit is refused, never stored", async () => {
  const host = SessionDriveState.make()
  await Effect.runPromise(host.save(lease.sessionID, { ...SessionDriveState.empty, opened: ["kept.svg"] }))
  const reply = await Effect.runPromise(
    SessionWorkerDriveStateBridge.handle({
      store: host,
      lease,
      message: {
        ...base,
        type: "drive-state-request",
        requestID: "rpc_ds_y",
        op: "save",
        args: [{ opened: ["x"] }],
      } as never,
    }),
  )
  expect(reply.outcome).toBe("rejected")
  expect((await Effect.runPromise(host.load(lease.sessionID))).opened).toEqual(["kept.svg"])
})

test("a request from a superseded attempt is rejected before the store is touched", async () => {
  const host = SessionDriveState.make()
  const reply = await Effect.runPromise(
    SessionWorkerDriveStateBridge.handle({
      store: host,
      lease,
      message: {
        ...base,
        generation: lease.generation + 1,
        type: "drive-state-request",
        requestID: "rpc_ds_z",
        op: "save",
        args: [{ ...SessionDriveState.empty, restartRounds: 4 }],
      } as never,
    }),
  )
  expect(reply.outcome).toBe("rejected")
  expect(await Effect.runPromise(host.load(lease.sessionID))).toEqual(SessionDriveState.empty)
})
