import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { FileObservation } from "@novaclaw/core/file-observation"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionV2 } from "@novaclaw/core/session"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_file_observation")
const current = (attemptID: string, generation = 1): SessionExecutionAttempt.CurrentInterface => ({
  fence: { attemptID, generation },
  advance: () => Effect.void,
  toolDispatched: () => Effect.void,
  toolSettled: () => Effect.void,
  providerStarted: () => Effect.void,
  providerToolProtocol: () => Effect.void,
  providerSettled: () => Effect.void,
  servedBy: () => Effect.void,
  providerRecovery: () => Effect.succeed(undefined),
})

const it = testEffect(AppNodeBuilder.build(FileObservation.node))

describe("FileObservation", () => {
  it.live("binds a full observation to one attempt, session, path, and digest", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = { canonical: path.join(tmp.path, "observed.txt"), resource: "observed.txt" }
          yield* Effect.promise(() => fs.writeFile(target.canonical, "seen bytes"))
          const service = yield* FileObservation.Service
          const version = yield* service.snapshot(target)
          const token = yield* service.record({
            sessionID,
            target,
            version,
            coverage: { start: 0, end: version.totalLength, total: version.totalLength, full: true },
          })
          expect(token).toMatchObject({ coverage: "full" })
          expect(yield* service.validate({ token: token?.token, sessionID, target })).toBe(version.digest)

          const wrongPath = yield* service
            .validate({ token: token?.token, sessionID, target: { ...target, canonical: `${target.canonical}.other` } })
            .pipe(Effect.flip)
          expect(wrongPath).toMatchObject({ reason: "wrong-path" })
        }).pipe(Effect.provideService(SessionExecutionAttempt.Current, current("exe_current"))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accumulates lossless pages only for one version and rejects another attempt", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = { canonical: path.join(tmp.path, "paged.txt"), resource: "paged.txt" }
          yield* Effect.promise(() => fs.writeFile(target.canonical, "one\ntwo\nthree"))
          const service = yield* FileObservation.Service
          const version = yield* service.snapshot(target)
          const first = yield* service.record({
            sessionID,
            target,
            version,
            coverage: { start: 0, end: 1, total: 3, full: false },
          })
          expect(first).toMatchObject({ coverage: "partial" })
          expect(yield* service.validate({ token: first?.token, sessionID, target }).pipe(Effect.flip)).toMatchObject({
            reason: "partial",
          })
          const complete = yield* service.record({
            sessionID,
            target,
            version,
            coverage: { start: 1, end: 3, total: 3, full: false },
          })
          expect(complete?.token).toBe(first?.token)
          expect(complete?.coverage).toBe("full")
          expect(
            yield* service
              .validate({ token: complete?.token, sessionID, target })
              .pipe(Effect.provideService(SessionExecutionAttempt.Current, current("exe_other")), Effect.flip),
          ).toMatchObject({ reason: "wrong-attempt" })
          yield* Effect.promise(() => fs.writeFile(target.canonical, "one\nchanged\nthree"))
          const changedVersion = yield* service.snapshot(target)
          const changed = yield* service.record({
            sessionID,
            target,
            version: changedVersion,
            coverage: { start: 1, end: 3, total: 3, full: false },
          })
          expect(changed?.token).not.toBe(complete?.token)
          expect(changed?.coverage).toBe("partial")
        }).pipe(Effect.provideService(SessionExecutionAttempt.Current, current("exe_pages"))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
