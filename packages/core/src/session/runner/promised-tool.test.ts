import { describe, expect, test } from "bun:test"
import { detect, recoveryMessage } from "./textual-call"

// The `promised-tool` tell: a turn that NARRATES the call it is about to make and then ends, with no
// structured call and no fenced pseudo-call. The other tells look for syntax; this one reads prose,
// which is why it is checked last and why its false positives cost only a nudge.
//
// Ported from NancySadkov/novaclaw#7 by @DassaultFalconKing, whose live local-model run ended on
// exactly "I'll start by calling write...".

const TOOLS = ["read", "write", "edit", "bash"]
const tell = (text: string) => detect(text, TOOLS)?.tell

describe("promised-tool — the live failure", () => {
  test("the exact reported form", () => {
    expect(tell("I'll start by calling write to create the file.")).toBe("promised-tool")
  })

  test("the common English variants", () => {
    expect(tell("I will now run the build.")).toBe("promised-tool")
    expect(tell("Let me read the config first.")).toBe("promised-tool")
    expect(tell("I'm going to use bash to check.")).toBe("promised-tool")
    expect(tell("I'll proceed to edit the file.")).toBe("promised-tool")
  })

  test("a curly apostrophe still counts — models emit both", () => {
    expect(tell("I’ll call read now.")).toBe("promised-tool")
  })
})

describe("promised-tool — NEGATIVE CONTROLS (a genuine answer must not be steered)", () => {
  test("PAST tense is a completion report, not a promise", () => {
    expect(tell("I called write and the file now exists.")).toBeUndefined()
    expect(tell("I read the config and it looks correct.")).toBeUndefined()
  })

  test("instructions addressed to the USER are not the model promising", () => {
    expect(tell("You should run the build yourself, then tell me the output.")).toBeUndefined()
    expect(tell("To fix this, edit the config and restart.")).toBeUndefined()
  })

  test("an ordinary answer with no action language is untouched", () => {
    expect(tell("The config sets the port to 4096 and enables WAL mode.")).toBeUndefined()
    expect(tell("")).toBeUndefined()
  })

  test("syntax beats prose: a fenced call reports its OWN tell even when it also narrates", () => {
    // This is the real ordering risk — a turn that BOTH promises and shows a fenced block. The more
    // precise diagnosis has to win, or the steer tells the model the wrong thing about its mistake.
    const text = ["I'll begin by calling bash.", "", "```bash", `bash -c "echo hi"`, "```"].join("\n")
    expect(tell(text)).toBe("fenced-tool")
  })
})

describe("the steer distinguishes a promise from a written-out call", () => {
  test("a promise is told that SAYING is not CALLING", () => {
    const found = detect("I'll start by calling write to create it.", TOOLS)!
    const message = recoveryMessage(found)
    expect(message).toContain("announced one you were about to make")
    expect(message.toLowerCase()).toContain("does not call it")
  })

  test("NEGATIVE CONTROL: a fenced call gets the original wording, not the promise wording", () => {
    const message = recoveryMessage({ tell: "fenced-tool", detail: "fenced `bash` block" })
    expect(message).toContain("written as text")
    expect(message).not.toContain("announced one you were about to make")
  })
})
