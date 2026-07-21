import { describe, expect, it } from "bun:test"
import { DateTime } from "effect"
import { SessionTitle } from "@novaclaw/core/session/title"
import { STEER_PROVENANCE_PREFIX } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionSchema } from "@novaclaw/core/session/schema"

const sessionID = SessionSchema.ID.make("ses_title_helpers")
const now = DateTime.makeUnsafe(0)

function user(text: string): SessionMessage.Message {
  return {
    id: SessionMessage.ID.create(),
    sessionID,
    type: "user",
    text,
    files: undefined,
    agents: undefined,
    time: { created: now },
  } as SessionMessage.Message
}

describe("SessionTitle.isDefault", () => {
  it("matches the bare creation default", () => {
    expect(SessionTitle.isDefault("New session")).toBe(true)
    expect(SessionTitle.isDefault("Child session")).toBe(true)
  })

  it("matches the older ISO-suffixed core default", () => {
    expect(SessionTitle.isDefault(`New session - ${new Date(0).toISOString()}`)).toBe(true)
  })

  it("matches the legacy child default", () => {
    expect(SessionTitle.isDefault(`Child session - ${new Date(0).toISOString()}`)).toBe(true)
  })

  it("never matches a real or renamed title", () => {
    expect(SessionTitle.isDefault("Debugging production 500 errors")).toBe(false)
    expect(SessionTitle.isDefault("New session - notes")).toBe(false)
    expect(SessionTitle.isDefault(`prefix New session - ${new Date(0).toISOString()}`)).toBe(false)
    expect(SessionTitle.isDefault("New sessions")).toBe(false)
  })
})

describe("SessionTitle.firstRealUserText", () => {
  it("returns the first user message text", () => {
    expect(SessionTitle.firstRealUserText([user("fix the parser"), user("second")])).toBe("fix the parser")
  })

  it("skips harness steers (1N provenance prefix) and blank messages", () => {
    expect(
      SessionTitle.firstRealUserText([
        user(`${STEER_PROVENANCE_PREFIX}You appear stuck.`),
        user("   "),
        user("  add dark mode  "),
      ]),
    ).toBe("add dark mode")
  })

  it("returns undefined when no real user message exists", () => {
    expect(SessionTitle.firstRealUserText([user(`${STEER_PROVENANCE_PREFIX}nudge`)])).toBeUndefined()
    expect(SessionTitle.firstRealUserText([])).toBeUndefined()
  })
})

describe("SessionTitle.forked", () => {
  it("appends the first fork marker", () => {
    expect(SessionTitle.forked("Parser bug fix")).toBe("Parser bug fix (fork #1)")
  })

  it("increments an existing fork marker", () => {
    expect(SessionTitle.forked("Parser bug fix (fork #1)")).toBe("Parser bug fix (fork #2)")
    expect(SessionTitle.forked("Parser bug fix (fork #41)")).toBe("Parser bug fix (fork #42)")
  })
})

describe("SessionTitle.clean", () => {
  it("strips think blocks and takes the first non-empty line", () => {
    expect(SessionTitle.clean("<think>reasoning\nhere</think>\n\nParser bug fix\nextra")).toBe("Parser bug fix")
  })

  it("caps at 100 characters with an ellipsis", () => {
    const long = "x".repeat(150)
    const cleaned = SessionTitle.clean(long)
    expect(cleaned).toHaveLength(100)
    expect(cleaned!.endsWith("...")).toBe(true)
  })

  it("returns undefined for empty or think-only output", () => {
    expect(SessionTitle.clean("")).toBeUndefined()
    expect(SessionTitle.clean("<think>only thoughts</think>\n \n")).toBeUndefined()
  })

  it("skips code-shaped lines (the live define_tool leak) and falls through to prose", () => {
    expect(SessionTitle.clean('define_tool({"name": "greet_probe", "description": "Say hello"})')).toBeUndefined()
    expect(SessionTitle.clean('{"name": "greet_probe"}')).toBeUndefined()
    expect(SessionTitle.clean("<tool_call>write</tool_call>")).toBeUndefined()
    expect(SessionTitle.clean("<|mask_start|> something")).toBeUndefined()
    expect(SessionTitle.clean('define_tool({"x":1})\nGreet probe smoke test')).toBe("Greet probe smoke test")
  })

  it("keeps ordinary prose with parentheses", () => {
    expect(SessionTitle.clean("Fix parser (edge cases)")).toBe("Fix parser (edge cases)")
  })
})
