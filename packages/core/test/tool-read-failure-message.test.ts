import { describe, expect, test } from "bun:test"
import { ReadTool } from "@novaclaw/core/tool/read"

/**
 * What a failed `read` tells the model to do next.
 *
 * 🔴 Every one of these used to render as `Unable to read <path>` — a sentence equally true of a name
 * the model invented, a file it may not open, and a file another process holds. Measured 2026-08-20
 * on the 400-icon run: the model invented `icon_400_r20_c17.png` (the real file at that cell is
 * `icon_397_r20_c17.png`), read the message as "this file is broken", and guessed four more names.
 *
 * Owner ruling the same day: the failure must steer the caller — list the folder if it has not
 * already, or check whether it may read the file. So each cause is asserted on the ACTION it names,
 * not on its phrasing.
 */

const message = ReadTool.readFailureMessage
const PATH = "C:/glyphs/icon_400_r20_c17.png"

// The three shapes a cause can arrive in: Effect's PlatformError `reason`, a raw node `code`, and a
// bare message. All three are real — the classifier must not depend on which layer wrapped it.
const byReason = (reason: string) => ({ reason })
const byCode = (code: string) => ({ code })
const byText = (text: string) => new Error(text)

describe("a MISSING file — the only cause the model itself can create", () => {
  test("says it does not exist and sends the model to list the folder", () => {
    for (const error of [byReason("NotFound"), byCode("ENOENT"), byText("ENOENT: no such file")]) {
      const text = message(error, PATH)
      expect(text).toContain(PATH)
      expect(text).toContain("does not exist")
      // ⭐ The half that converts: an action, conditional on not having listed yet.
      expect(text).toContain("list it")
      // …and the rule it shares with `perceptionSection`, restated where the mistake happened.
      expect(text).toContain("do not guess or invent a filename")
    }
  })
})

describe("a REFUSED file — real, but not openable", () => {
  test("names permission and says re-reading will not help", () => {
    for (const error of [byReason("PermissionDenied"), byCode("EACCES"), byCode("EPERM")]) {
      const text = message(error, PATH)
      expect(text).toContain("permission denied")
      // ⚠️ It must NOT tell the model to list the folder: the path is fine, listing proves nothing.
      expect(text).not.toContain("do not guess or invent a filename")
      expect(text).toContain("allowed to read")
    }
  })
})

describe("a LOCKED file — the one case where retrying is genuinely right", () => {
  test("says to wait and try again, or move on", () => {
    for (const error of [
      byCode("EBUSY"),
      byText("The process cannot access the file: being used by another process"),
    ]) {
      const text = message(error, PATH)
      expect(text).toContain("locked by another process")
      expect(text).toContain("read it again")
    }
  })
})

describe("a DIRECTORY handed to a file read", () => {
  test("says what it is and what to do instead", () => {
    const text = message(byCode("EISDIR"), "C:/glyphs")
    expect(text).toContain("is a directory")
    expect(text).toContain("List it instead")
  })
})

describe("an UNRECOGNISED cause — the branch that must not pretend", () => {
  test("says the cause is unknown and offers BOTH checks", () => {
    // 🔴 This is where every errno nobody anticipated lands. Dressing it in the wording of a cause we
    // merely suspect is how a wrong steer becomes a confident one, so it commits to neither.
    const text = message(byCode("EIO"), PATH)
    expect(text).toContain("not one this tool recognises")
    expect(text).toContain("listing its folder")
    expect(text).toContain("may read that location")
    // It must not claim the file is missing — that is precisely what it does not know.
    expect(text).not.toContain("does not exist")
  })

  test("carries the underlying text through, so a human can still diagnose it", () => {
    // The model gets a next action; whoever reads the transcript afterwards still needs the errno.
    expect(message(byText("EIO: i/o error"), PATH)).toContain("EIO: i/o error")
  })
})
