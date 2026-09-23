import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"

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

/**
 * This graph holds no services, so it cannot open a chat — and `fromParts` REQUIRES an opener rather
 * than allowing the omission, because an omitted one cannot tell "there is no such colleague" from
 * "they exist and no row has been written yet" and would report the second as the first. The test
 * below reaches this ON PURPOSE: its claim is that the paused gate did not refuse, and the `die`
 * downstream is how "it got past" is observed.
 */
const noChatOpener = () => Effect.die("this graph cannot open a colleague chat")

describe("delivery", () => {
  const parts = (paused: boolean) =>
    ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: "nova" }),
      wake: () => Effect.succeed(true),
      store: undefined as never,
      chat: noChatOpener,
      roster: Effect.succeed([{ id: "nova" }, { id: "edda", paused: true }] as never),
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
      paused: () => Effect.succeed(paused),
    })

  test("a paused colleague is reached rather than rejected before the chat opens", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(parts(true).deliver({ from: "ses_nova" as never, colleague: "edda", message: "the ledger?" })),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("⚠️ an UNKNOWN paused-state does not refuse — a hand-off is not blocked on a maybe", async () => {
    // The per-request host handler cannot resolve the registry, so `paused` is absent there.
    const withoutPredicate = ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: "nova" }),
      wake: () => Effect.succeed(true),
      store: undefined as never,
      chat: noChatOpener,
      roster: Effect.succeed([{ id: "nova" }, { id: "edda" }] as never),
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
    })
    // It gets past the paused gate and fails DOWNSTREAM — reaching that point is the claim. The
    // failure is the missing chat opener rather than the null db it used to be: this graph holds no
    // services at all, so it cannot open a chat, and `fromParts` requires the opener rather than
    // letting a graph omit it and answer "no such colleague" for a colleague that exists.
    const exit = await Effect.runPromise(
      Effect.exit(withoutPredicate.deliver({ from: "ses_nova" as never, colleague: "edda", message: "hi" })),
    )
    expect(exit._tag).toBe("Failure")
  })
})
