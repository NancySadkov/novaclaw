import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionDriveState } from "./drive-state"

/**
 * The store behind the runner's cross-drain facts. What matters is the LIFETIME: a snapshot must
 * survive the end of a run (that is the whole reason it exists) and must not survive forever.
 */
describe("SessionDriveState", () => {
  test("a snapshot written in one run is read back in the next", async () => {
    const state = SessionDriveState.make()
    const run = <A>(body: Effect.Effect<A>) => Effect.runPromise(state.withSession("ses_a", body))
    await run(state.save("ses_a", { ...SessionDriveState.empty, barren: { barren: 2, lastOpened: 199 } }))
    // A second run — a second drain, a second worker in production — sees the first run's facts.
    const seen = await run(state.load("ses_a"))
    expect(seen.barren).toEqual({ barren: 2, lastOpened: 199 })
  })

  test("recovery latches survive a worker drain", async () => {
    const state = SessionDriveState.make()
    const snapshot = {
      ...SessionDriveState.empty,
      runawayNudgedAtCalls: 75,
      compactionRetryAt: 123_456,
    }
    await Effect.runPromise(state.withSession("ses_recovery", state.save("ses_recovery", snapshot)))
    expect(await Effect.runPromise(state.withSession("ses_recovery", state.load("ses_recovery")))).toEqual(snapshot)
  })

  test("a session nobody has written answers `empty`, never undefined", async () => {
    const state = SessionDriveState.make()
    expect(await Effect.runPromise(state.load("ses_unknown"))).toEqual(SessionDriveState.empty)
  })

  test("an older controller snapshot keeps its state and defaults the new recovery latch", () => {
    expect(
      SessionDriveState.decode({ opened: ["README.md"], attempted: [], joined: ["child"], restartRounds: 2 }),
    ).toEqual({
      opened: ["README.md"],
      attempted: [],
      joined: ["child"],
      spawned: [],
      restartRounds: 2,
      runawayNudgedAtCalls: 0,
    })
  })

  test("retains the user-task boundary and its spawned children across worker drains", () => {
    expect(
      SessionDriveState.decode({
        ...SessionDriveState.empty,
        childTask: "msg_user_2",
        spawned: ["ses_child_1", "ses_child_2"],
      }),
    ).toMatchObject({ childTask: "msg_user_2", spawned: ["ses_child_1", "ses_child_2"] })
  })

  test("🔴 an idle session is swept after the forgiveness window, and a live one is pinned", async () => {
    let now = 1_000
    const state = SessionDriveState.make({ now: () => now, forgivenessMs: 100 })
    const snapshot = { ...SessionDriveState.empty, restartRounds: 1 }
    await Effect.runPromise(state.withSession("ses_idle", state.save("ses_idle", snapshot)))
    // Still inside the window: a returning session keeps its facts.
    now += 50
    expect((await Effect.runPromise(state.withSession("ses_idle", state.load("ses_idle")))).restartRounds).toBe(1)
    // Past the window while another session enters: swept, so the session starts fresh — which may
    // repeat visible steering but can never silently mark unfinished work done.
    now += 200
    await Effect.runPromise(state.withSession("ses_other", Effect.void))
    expect(await Effect.runPromise(state.load("ses_idle"))).toEqual(SessionDriveState.empty)
  })

  test("a session pinned by a live run is not swept, however long the run takes", async () => {
    let now = 1_000
    const state = SessionDriveState.make({ now: () => now, forgivenessMs: 100 })
    const snapshot = { ...SessionDriveState.empty, opened: ["icon_001.svg"] }
    const seen = await Effect.runPromise(
      state.withSession(
        "ses_live",
        Effect.gen(function* () {
          yield* state.save("ses_live", snapshot)
          now += 10_000
          // Another session's run entering triggers the sweep; the live one must be untouched.
          yield* state.withSession("ses_other", Effect.void)
          return yield* state.load("ses_live")
        }),
      ),
    )
    expect(seen.opened).toEqual(["icon_001.svg"])
  })
})
