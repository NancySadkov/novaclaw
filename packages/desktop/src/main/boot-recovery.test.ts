import { expect, test } from "bun:test"
import { movedAsideNotice, movedAsidePath, recoveryChoices } from "./boot-recovery"

/**
 * 🔴 NC-REL-024 — a boot failure that only logged itself.
 *
 * The database layer classifies its own faults and writes a sentence for a person plus a repair
 * list; `describeSidecarFailure` picks all of it up; the consumer logged it and returned. So a user
 * whose database came from a newer NovaClaw got a window that never appeared.
 */
test("🔴 a known database offers the repair, not just a description of it", () => {
  const choices = recoveryChoices("/home/me/.novaclaw/novaclaw.db")
  expect(choices.map((choice) => choice.action)).toEqual(["move-aside", "open-folder", "export-logs", "quit"])
  expect(choices[0]?.label).toContain("Move database aside")
})

test("🔴 no path means no button that would have to name one", () => {
  // ⚠️ The failure direction that matters. A "move the database aside" button on a failure with no
  // database — or one raised before the file was resolved — either does nothing or moves the wrong
  // file, and "Open containing folder" would send the user to a folder that is not the one they
  // need, which is worse than an absent button because they then believe they have looked.
  const choices = recoveryChoices(undefined)
  expect(choices.map((choice) => choice.action)).toEqual(["export-logs", "quit"])
})

test("quit is always available and always last", () => {
  for (const path of ["/db/novaclaw.db", undefined]) {
    const choices = recoveryChoices(path)
    expect(choices.at(-1)?.action).toBe("quit")
  }
})

/**
 * 🔴 The rename must be legal on the platform this app mainly ships to.
 *
 * A bare ISO timestamp carries colons, which Windows filenames cannot. Used verbatim, the rename
 * fails — at exactly the moment the user is already stuck and being told the fix worked.
 *
 * A/B: drop the `replace` in `movedAsidePath` and this fails.
 */
test("🔴 the moved-aside name contains no character Windows refuses", () => {
  const moved = movedAsidePath("C:\\Users\\me\\AppData\\novaclaw.db", "2026-08-28T06:15:42.123Z")
  expect(moved).toBe("C:\\Users\\me\\AppData\\novaclaw.db.unusable-2026-08-28T06-15-42-123Z")
  // Everything after the drive letter must be free of the characters Windows reserves.
  expect(moved.slice(2)).not.toContain(":")
  expect(moved).not.toContain("*")
  expect(moved).not.toContain("?")
})

test("the original path is a prefix, so the file sorts beside its replacement", () => {
  // Not cosmetic: the user looking for their data finds it next to the new database rather than in
  // whatever place an alphabetised listing would otherwise put it.
  const path = "/home/me/.novaclaw/novaclaw.db"
  expect(movedAsidePath(path, "2026-08-28T06:15:42.123Z").startsWith(`${path}.`)).toBe(true)
})

test("distinct timestamps never collide, so a second attempt cannot overwrite the first", () => {
  const path = "/home/me/.novaclaw/novaclaw.db"
  const first = movedAsidePath(path, "2026-08-28T06:15:42.123Z")
  const second = movedAsidePath(path, "2026-08-28T06:15:43.000Z")
  expect(first).not.toBe(second)
})

test("the notice names the file and says nothing was deleted", () => {
  // A rename the user cannot find reads exactly like a deletion, and this is the only place they
  // are told where it went.
  const notice = movedAsideNotice("/home/me/.novaclaw/novaclaw.db.unusable-2026-08-28T06-15-42-123Z")
  expect(notice).toContain("/home/me/.novaclaw/novaclaw.db.unusable-2026-08-28T06-15-42-123Z")
  expect(notice).toContain("Nothing was deleted")
})
