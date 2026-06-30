import { describe, expect, test } from "bun:test"
import { accumDeltaKey, readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, "msg_1", { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, "msg_1", { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(
      readPartText({ [accumDeltaKey("msg_1", "part_1")]: "  from accum  " }, "msg_1", { id: "part_1", text: "from part" }),
    ).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(
      readPartText({ [accumDeltaKey("msg_1", "other_part")]: "ignored" }, "msg_1", {
        id: "part_1",
        text: "  from part  ",
      }),
    ).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, "msg_1", { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, "msg_1", { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })

  // Regression: V2 reuses the part id "text-0" across messages. A delta accumulated for
  // the active message's "text-0" must NOT leak into a prior message's "text-0" part —
  // that was the "response replicated under each user message" ghost.
  test("isolates same partID across different messages (V2 ghost regression)", () => {
    const accum = { [accumDeltaKey("msg_active", "text-0")]: "streaming response" }
    // The prior message's own text-0 part keeps its own text, not the streaming delta.
    expect(readPartText(accum, "msg_prior", { id: "text-0", text: "prior answer" })).toBe("prior answer")
    // The active message's text-0 part reads the accumulated streaming delta.
    expect(readPartText(accum, "msg_active", { id: "text-0", text: "" })).toBe("streaming response")
  })
})
