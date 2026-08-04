import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { fromRow } from "@novaclaw/core/session/info"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import type { SessionTable } from "@novaclaw/core/session/sql"
import { EventV2 } from "@novaclaw/core/event"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionMessage } from "@novaclaw/core/session/message"

/**
 * `sessionRow` calls itself "fromRow's inverse". From the V1 nuke until 2026-07-29 that was FALSE:
 * it omitted `thinking_budget`, `surgical_edits` and `ask_before_changes`, so a `SessionRecordEvent`
 * carrying them projected a row with all three NULL. Two of the three are RESTRICTIONS, so a create
 * path that meant to restrict a session silently produced an unrestricted one — and because the only
 * writer was `FeatureSwitched`, the fork fix had to route four fields through switch events as a
 * workaround.
 *
 * It stayed false because it was a COMMENT. Ruling 1: an invariant whose violation compiles green
 * ships with a mechanical check, or the invariant does not exist. This is that check.
 *
 * ⚠️ It deliberately round-trips through the REAL pair rather than asserting a hand-written column
 * list. A list here would be a second copy of the thing under test — the exact defect that produced
 * the bug — and would have to be edited by the same person who forgot the column.
 */

const NOW = DateTime.makeUnsafe(1_700_000_000_000)

/** Every optional field set to a NON-DEFAULT value, so a dropped one cannot coincide with its default. */
function populatedInfo(): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_rowinverse0000000000000"),
    parentID: SessionSchema.ID.make("ses_rowinverseparent000000"),
    slug: "row-inverse",
    version: "0.0.0-test",
    title: "Row inverse fixture",
    location: { directory: "C:/tmp/row-inverse" } as SessionSchema.Info["location"],
    metadata: { probe: true },
    agent: "build" as SessionSchema.Info["agent"],
    systemPromptOverride: "ROW-INVERSE-OVERRIDE",
    type: "goal-oriented",
    priority: 7,
    responder: "operator",
    permissionMode: "plan",
    strict: { enabled: true, attempts: 3, wallMinutes: 9 },
    introspection: true,
    quality: true,
    affective: true,
    thinkingBudget: true,
    surgicalEdits: true,
    askBeforeChanges: true,
    contextBudget: true,
    providerRecovery: {
      attemptID: EventV2.ID.make("evt_rowinverse0000000000000"),
      assistantMessageID: SessionMessage.ID.make("msg_rowinverse0000000000000"),
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      startedAt: NOW,
      toolProtocol: true,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: NOW, updated: NOW },
  })
}

/**
 * `sessionRow` produces an INSERT shape; `fromRow` consumes a SELECT shape. They differ only in
 * nullability, so a projected insert is a faithful stand-in for the row SQLite would hand back —
 * with one honest exception: a key `sessionRow` OMITS becomes `undefined` here, where SQLite would
 * return `null`. Both read as "absent" through `fromRow`'s `?? undefined`, which is precisely the
 * failure this test is looking for.
 */
const asRow = (insert: typeof SessionTable.$inferInsert) => insert as unknown as typeof SessionTable.$inferSelect

describe("sessionRow is fromRow's inverse", () => {
  test("every configured field survives the round trip", () => {
    const info = populatedInfo()
    const back = fromRow(asRow(SessionProjector.sessionRow(info)))

    // The three that were actually dropped, named individually so a regression says WHICH one.
    expect(back.thinkingBudget, "thinkingBudget did not survive sessionRow → fromRow").toBe(info.thinkingBudget)
    expect(back.surgicalEdits, "surgicalEdits did not survive — a RESTRICTION was lost").toBe(info.surgicalEdits)
    expect(back.askBeforeChanges, "askBeforeChanges did not survive — a RESTRICTION was lost").toBe(
      info.askBeforeChanges,
    )
    expect(back.responder, "responder did not survive").toBe(info.responder)
    expect(back.contextBudget, "contextBudget did not survive").toBe(info.contextBudget)
    expect(back.providerRecovery, "providerRecovery did not survive").toEqual(info.providerRecovery)
  })

  test("no field of a fully-populated Info is silently dropped", () => {
    const info = populatedInfo()
    const back = fromRow(asRow(SessionProjector.sessionRow(info)))

    // Derived/computed fields are excluded WITH REASONS rather than by omission, so the exclusion
    // list is itself reviewable and a new field defaults to being checked.
    const derived = new Set([
      "subpath", // computed from the project root at create; `location.directory` carries the truth
      "time", // DateTime instances; equality is by epoch and both are asserted below
      "summary", // written by the Completed projector, never by a record event
      "result", // written by exit.ts
      "revert", // exercised by the revert suites; a nested struct with its own branded id
    ])

    const dropped = Object.keys(info).filter((key) => {
      if (derived.has(key)) return false
      const before = (info as unknown as Record<string, unknown>)[key]
      if (before === undefined) return false
      const after = (back as unknown as Record<string, unknown>)[key]
      return after === undefined
    })

    expect(dropped, `sessionRow drops ${dropped.join(", ")} — it is not fromRow's inverse`).toEqual([])
    expect(DateTime.toEpochMillis(back.time.created)).toBe(DateTime.toEpochMillis(info.time.created))
  })

  test("an absent field stays absent rather than becoming a value", () => {
    // The mirror of the above: the round trip must not INVENT restrictions either. A bare session
    // that never opted into `surgicalEdits` must not come back with it set.
    const bare = SessionSchema.Info.make({
      id: SessionSchema.ID.make("ses_rowinversebare00000000"),
      slug: "bare",
      version: "0.0.0-test",
      title: "New session",
      location: { directory: "C:/tmp/row-inverse" } as SessionSchema.Info["location"],
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: NOW, updated: NOW },
    })
    const back = fromRow(asRow(SessionProjector.sessionRow(bare)))
    expect(back.surgicalEdits).toBeUndefined()
    expect(back.askBeforeChanges).toBeUndefined()
    expect(back.thinkingBudget).toBeUndefined()
    expect(back.responder).toBeUndefined()
    expect(back.contextBudget).toBeUndefined()
    expect(back.providerRecovery).toBeUndefined()
    expect(back.systemPromptOverride).toBeUndefined()
  })

  test("changes recording boundaries and completeness survive persistence", () => {
    const info = SessionSchema.Info.make({
      ...populatedInfo(),
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [
          {
            file: "assets/logo.png",
            additions: 0,
            deletions: 0,
            status: "modified",
            patchUnavailableReason: "binary",
          },
        ],
        from: "tree_before",
        to: "tree_after",
        complete: false,
      },
    })
    const back = fromRow(asRow(SessionProjector.sessionRow(info)))
    expect(back.summary).toEqual(info.summary)
  })
})
