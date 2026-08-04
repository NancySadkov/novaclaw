import { describe, expect, test } from "bun:test"
import { Identifier } from "@/utils/id"
import {
  BEFORE_ALL,
  commitBoundaryID,
  nextMessageID,
  selectRolledMessages,
  selectVisibleMessages,
  undoTargetID,
} from "./revert-view"

/**
 * ⚠️ Every id here comes from the app's REAL generator (`@/utils/id`, the same call
 * `session.tsx` makes), so they look like `msg_fab7060160010s31FhIt13gZGs` and are monotonically
 * ascending. Hand-written ids (`msg_probe1`, `msg_1`) sort ABOVE every generated id, which silently
 * turns any ordering assertion into a tautology — that is exactly how one diagnosis of this bug was
 * invalidated (todo/session-ui.md, 2026-07-29). Do not replace these with literals.
 */
const id = () => Identifier.ascending("message")

type Row = { id: string; type: "user" | "assistant" }
const user = (): Row => ({ id: id(), type: "user" })
const assistant = (): Row => ({ id: id(), type: "assistant" })

/** Two complete turns: prompt → reply, prompt → reply. */
const conversation = () => {
  const u1 = user()
  const a1 = assistant()
  const u2 = user()
  const a2 = assistant()
  return { all: [u1, a1, u2, a2], u1, a1, u2, a2 }
}

describe("staged-revert view", () => {
  test("the ids the rest of this file relies on really are ascending", () => {
    const ids = [id(), id(), id(), id()]
    expect([...ids].sort()).toEqual(ids)
    expect(ids.every((value) => /^msg_[0-9a-f]{12}.{14}$/.test(value))).toBe(true)
  })

  test("staging on a user message hides that message AND its assistant reply", () => {
    const { all, u1, a1, u2, a2 } = conversation()

    // This is the state `/undo` produces: the boundary is the USER message (live-captured
    // 2026-07-29 — `revert.messageID` pointed at the prompt, not the reply).
    const visible = selectVisibleMessages(all, u2.id)

    expect(visible.map((m) => m.id)).toEqual([u1.id, a1.id])
    expect(visible).not.toContain(u2)
    expect(visible).not.toContain(a2)
  })

  test("visible and rolled are exact complements at every boundary", () => {
    const { all } = conversation()
    for (const message of all) {
      const visible = selectVisibleMessages(all, message.id)
      const rolled = selectRolledMessages(all, message.id)
      expect([...visible, ...rolled]).toEqual(all)
      // Nothing may be BOTH drawn in the transcript and named by the dock.
      expect(visible.filter((m) => rolled.includes(m))).toEqual([])
    }
  })

  test("no boundary means nothing is hidden, and the input array is passed through", () => {
    const { all } = conversation()
    expect(selectVisibleMessages(all, undefined)).toBe(all)
    expect(selectRolledMessages(all, undefined)).toEqual([])
  })

  test("the revert dock has something to render for the state /undo produces", () => {
    const { all, u2, a2 } = conversation()
    const users = all.filter((m) => m.type === "user")

    // `session.tsx` builds the dock from the ROLLED USER messages and renders it only when that
    // list is non-empty (`rolled().length > 0` → `revert?.items.length`). Staging `/undo` on the
    // last prompt must satisfy that condition, or the Discard button cannot be pressed.
    const items = selectRolledMessages(users, u2.id)
    expect(items.map((m) => m.id)).toEqual([u2.id])
    expect(items.length > 0).toBe(true)

    // ...and the transcript must have dropped the reply that goes with it.
    expect(selectVisibleMessages(all, u2.id).map((m) => m.id)).not.toContain(a2.id)
  })

  test("the commit boundary is the previous MESSAGE, not the previous prompt", () => {
    const { all, a1, u1, u2 } = conversation()

    // `revert.commit` deletes every row with `seq > boundary.seq`. To discard u2's turn the anchor
    // must be a1 — the message immediately before it.
    expect(commitBoundaryID(all, u2.id)).toBe(a1.id)

    // Negative control on the shipped off-by-one: anchoring on the previous USER message (u1) would
    // also delete a1, the reply to a prompt the user never asked to discard.
    const users = all.filter((m) => m.type === "user")
    expect(commitBoundaryID(users, u2.id)).toBe(u1.id)
    expect(commitBoundaryID(all, u2.id)).not.toBe(commitBoundaryID(users, u2.id))
  })

  test("the first message commits against the before-everything sentinel", () => {
    const { all, u1 } = conversation()
    expect(commitBoundaryID(all, u1.id)).toBe(BEFORE_ALL)
    expect(BEFORE_ALL < u1.id).toBe(true)
  })

  test("initial agent/model setup records do not become a phantom first message", () => {
    const { all, u1 } = conversation()
    const setup = [
      { id: id(), type: "agent-switched" },
      { id: id(), type: "model-switched" },
    ]

    // The first VISIBLE prompt still means before everything. Keeping the model-switch row as the
    // boundary is the reported regression: the prompt disappears from storage, but one chat row
    // survives and looks like the first message was preserved.
    expect(commitBoundaryID([...setup, ...all], u1.id)).toBe(BEFORE_ALL)
  })

  test("a mid-conversation model switch remains a real commit boundary", () => {
    const { u1, a1, u2 } = conversation()
    const switched = { id: id(), type: "model-switched" }
    expect(commitBoundaryID([u1, a1, switched, u2], u2.id)).toBe(switched.id)
  })

  test("an unknown target yields no boundary rather than a wrong one", () => {
    const { all } = conversation()
    expect(commitBoundaryID(all, id())).toBeUndefined()
  })

  test("/undo walks the boundary back one prompt at a time and then stops", () => {
    const { all, u1, u2 } = conversation()
    const users = all.filter((m) => m.type === "user")

    const first = undoTargetID(users, undefined)
    expect(first).toBe(u2.id)
    const second = undoTargetID(users, first)
    expect(second).toBe(u1.id)
    expect(undoTargetID(users, second)).toBeUndefined()
  })

  test("/redo walks it forward and then clears", () => {
    const { all, u1, u2 } = conversation()
    const users = all.filter((m) => m.type === "user")

    expect(nextMessageID(users, u1.id)).toBe(u2.id)
    expect(nextMessageID(users, u2.id)).toBeUndefined()
  })

  test("boundaries are located by POSITION, so an out-of-order id set still partitions correctly", () => {
    // The trap in one test: `msg_probe1` sorts above every generated id, so a `<`/`>=` compare
    // would call the whole list visible and the dock empty. Index-first gets it right anyway.
    const rows = [{ id: "msg_probe1" }, { id: id() }, { id: id() }]
    expect(selectVisibleMessages(rows, rows[1]!.id).map((m) => m.id)).toEqual(["msg_probe1"])
    expect(selectRolledMessages(rows, rows[1]!.id)).toHaveLength(2)
    expect(commitBoundaryID(rows, rows[1]!.id)).toBe("msg_probe1")

    // A pure id compare would have produced the opposite answer — that is the assertion that
    // distinguishes this implementation from the one that shipped.
    expect(rows.filter((m) => m.id < rows[1]!.id)).toEqual([])
  })

  test("a boundary outside the loaded page falls back to the id compare", () => {
    // Only reachable when history has not loaded the boundary's page: position is unknown, so the
    // ordering of app-generated ids is the only signal left.
    const older = [{ id: id() }, { id: id() }]
    const boundary = id()
    const newer = [{ id: id() }]
    const loaded = [...older, ...newer]
    expect(selectVisibleMessages(loaded, boundary).map((m) => m.id)).toEqual(older.map((m) => m.id))
    expect(selectRolledMessages(loaded, boundary).map((m) => m.id)).toEqual(newer.map((m) => m.id))
  })
})
