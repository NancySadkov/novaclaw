import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { CalendarScheduler } from "@novaclaw/core/schedule/scheduler"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { AgentV2 } from "@novaclaw/core/agent"

/**
 * A PAUSED COLLEAGUE IS NOT GIVEN WORK — at either door that hands work out.
 *
 * Pausing already stops a colleague ACTING (`permission.ts` answers deny-`*`). What it did not stop
 * was work being handed TO one, and the two doors failed differently:
 *   · `deliver` accepted the hand-off, so the sender waited for a reply that could not come and
 *     `colleague-stall.ts` reported the silence half an hour later — a stall the instance made.
 *   · the scheduler fired the task as the paused colleague, so an unattended run landed in a chat
 *     where every turn is denied and nothing said why.
 */

describe("the model-facing roster", () => {
  test("🔴 MARKS a paused colleague rather than hiding one", () => {
    const roster = ColleagueTool.formatRoster(
      [
        { id: "wren", name: "Wren", title: "Writer" },
        { id: "edda", name: "Edda", title: "Editor", paused: true },
      ],
      "nova",
    )
    expect(roster).toContain("PAUSED")
    // Hiding it would read as "no such colleague" and the model would hire a DUPLICATE, handing the
    // new hire the paused one's name and cabinet — the collateral pausing replaced removal to avoid.
    expect(roster).toContain("edda")
    expect(roster).toContain("wren")
  })

  test("an active colleague carries no marking", () => {
    // The control: a mark on everyone is a mark on no one.
    expect(ColleagueTool.formatRoster([{ id: "wren", name: "Wren" }], "nova")).not.toContain("PAUSED")
  })
})

describe("delivery", () => {
  const parts = (paused: boolean) =>
    ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: "nova" }),
      wake: () => Effect.succeed(true),
      store: undefined as never,
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
      paused: () => Effect.succeed(paused),
    })

  test("🔴 an ask to a PAUSED colleague is refused, and the sender is told", async () => {
    const result = await Effect.runPromise(
      parts(true).deliver({ from: "ses_nova" as never, colleague: "edda", message: "the ledger?" }),
    )
    expect(result.delivered).toBe(false)
    expect(result.refused).toContain("NOT SENT")
    expect(result.refused).toContain("PAUSED")
    // Names the remedy, and it is the USER's — telling a model to wait would be telling it to wait
    // for something no colleague can change.
    expect(result.refused).toMatch(/resume/i)
  })

  test("⚠️ an UNKNOWN paused-state does not refuse — a hand-off is not blocked on a maybe", async () => {
    // The per-request host handler cannot resolve the registry, so `paused` is absent there.
    const withoutPredicate = ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: "nova" }),
      wake: () => Effect.succeed(true),
      store: undefined as never,
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
    })
    // It gets past the paused gate and fails later on the null db — reaching that point is the claim.
    const exit = await Effect.runPromise(
      Effect.exit(withoutPredicate.deliver({ from: "ses_nova" as never, colleague: "edda", message: "hi" })),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("the scheduler", () => {
  const spawnedAs = async (input: { paused: boolean; agent?: string }) => {
    const calls: { agent: string; text: string }[] = []
    const launch = CalendarScheduler.makeLaunch(
      {
        spawn: (spawn: never) => {
          const s = spawn as unknown as { agent: string; text: string }
          calls.push({ agent: String(s.agent), text: String(s.text) })
          return Effect.succeed({ id: "ses_new", started: true }) as never
        },
      } as never,
      "C:/home",
      () => Effect.succeed(undefined),
      () => Effect.succeed(!input.paused),
    )
    await Effect.runPromise(
      launch({
        schedule: { id: "sch_1", prompt: "file the ledger", title: "Ledger", agent: input.agent } as never,
      } as never) as never,
    )
    return calls[0]!
  }

  test("🔴 a PAUSED colleague's task is handed to Nova, and the run SAYS SO", async () => {
    const call = await spawnedAs({ paused: true, agent: "edda" })
    expect(call.agent).toBe(AgentV2.NOVA_ID)
    // A silent reassignment is a skip's twin: the task looks like it ran normally as somebody else.
    expect(call.text).toContain("edda")
    expect(call.text).toContain("PAUSED")
    expect(call.text).toContain("file the ledger")
  })

  test("an ACTIVE colleague keeps its own task, unannotated", async () => {
    // The control. Without it, a launch that always reassigned would pass the test above.
    const call = await spawnedAs({ paused: false, agent: "edda" })
    expect(call.agent).toBe("edda")
    expect(call.text).toBe("file the ledger")
  })

  test("an unowned task is still Nova's, and is NOT announced as a reassignment", async () => {
    // Nova owning an unowned task is the normal case, not an exception worth narrating.
    const call = await spawnedAs({ paused: true })
    expect(call.agent).toBe(AgentV2.NOVA_ID)
    expect(call.text).toBe("file the ledger")
  })
})
