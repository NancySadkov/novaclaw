import { describe, expect, test } from "bun:test"
import { MessengerPipeline } from "@novaclaw/core/messenger/pipeline"
import { SessionOrigin } from "@novaclaw/core/session/origin"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"

// P1/P6 gate (notes/messenger-plan.md §8): the structured-origin constructor (a driver event → a
// kernel Prompt.origin) and the /sessions↔/use index contract. The MODEL-facing rendering (header +
// untrusted framing) now lives in the kernel renderer session/origin.ts (tested there); the pipeline
// only builds the structured value.

const msg = (text: string, kind: "dm" | "group" = "dm"): Extract<InboundEvent, { kind: "message" }> => ({
  kind: "message",
  chat: { chatID: "c1", kind, title: "Support" },
  messageID: "7",
  sender: { id: "42", name: "Alice", isSelf: false },
  text,
  at: 1000,
})

describe("MessengerPipeline.origin (P6 structured provenance)", () => {
  test("maps a driver event to a kernel messenger origin (ids + trust for downstream rendering)", () => {
    const origin = MessengerPipeline.origin(msg("deploy now"), "telegram", "msa_1", "operator")
    expect(origin).toEqual({
      via: "messenger",
      driver: "telegram",
      accountID: "msa_1",
      chatID: "c1",
      chatKind: "dm",
      chatTitle: "Support",
      senderID: "42",
      senderName: "Alice",
      messageID: "7",
      trust: "operator",
      at: 1000,
    })
  })

  test("carries trust and reply-to through so the renderer can frame + thread", () => {
    const origin = MessengerPipeline.origin({ ...msg("fix", "group"), replyTo: "5" }, "discord", "msa_2", "client")
    expect(origin.via === "messenger" && origin.trust).toBe("client")
    expect(origin.via === "messenger" && origin.replyTo).toBe("5")
    // The kernel renderer turns THIS into the model header + untrusted framing (the injection guard).
    const header = SessionOrigin.modelHeader(origin)
    expect(header).toContain("[via discord")
    expect(header).toContain("external CLIENT")
  })
})

describe("MessengerPipeline.renderSessions", () => {
  test("numbers sessions and returns the ids in the same order (the /use contract)", () => {
    const { text, ids } = MessengerPipeline.renderSessions([
      { id: "ses_a", title: "Fix bug", agent: "build" },
      { id: "ses_b", title: "Logo" },
    ])
    expect(text).toContain("1. Fix bug · build")
    expect(text).toContain("2. Logo")
    expect(ids).toEqual(["ses_a", "ses_b"])
  })

  test("empty list guides the operator, no ids", () => {
    const { text, ids } = MessengerPipeline.renderSessions([])
    expect(text).toContain("No sessions yet")
    expect(ids).toEqual([])
  })

  test("falls back to the id when a session has no title", () => {
    const { text } = MessengerPipeline.renderSessions([{ id: "ses_x" }])
    expect(text).toContain("1. ses_x")
  })
})

describe("MessengerPipeline.chatKey", () => {
  test("is stable and account-scoped", () => {
    expect(MessengerPipeline.chatKey("msa_1" as never, "42")).toBe("msa_1:42")
    expect(MessengerPipeline.chatKey("msa_1" as never, "42")).not.toBe(MessengerPipeline.chatKey("msa_2" as never, "42"))
  })
})

describe("MessengerPipeline.addressed (SS0.1.5 self-chat gate)", () => {
  test("routes only messages addressed to the agent, stripping the address", () => {
    expect(MessengerPipeline.addressed("Nova, list my chats", "Nova")).toBe("list my chats")
    expect(MessengerPipeline.addressed("nova: do it", "Nova")).toBe("do it")
    expect(MessengerPipeline.addressed("  NOVA ,   spaced  ", "Nova")).toBe("spaced")
  })

  test("ignores the user's own notes (unaddressed, or address mid-sentence)", () => {
    expect(MessengerPipeline.addressed("buy milk", "Nova")).toBeUndefined()
    expect(MessengerPipeline.addressed("tell Nova, later", "Nova")).toBeUndefined()
    expect(MessengerPipeline.addressed("Novato, hi", "Nova")).toBeUndefined()
    expect(MessengerPipeline.addressed("Nova,", "Nova")).toBeUndefined() // address with no prompt
  })

  test("honors a custom agent name and escapes regex metacharacters", () => {
    expect(MessengerPipeline.addressed("Jarvis: status", "Jarvis")).toBe("status")
    expect(MessengerPipeline.addressed("Nova, hi", "Jarvis")).toBeUndefined()
    expect(MessengerPipeline.addressed("R2.D2, beep", "R2.D2")).toBe("beep")
    expect(MessengerPipeline.addressed("R2xD2, beep", "R2.D2")).toBeUndefined()
  })

  test("an empty/blank configured address falls back to the default", () => {
    expect(MessengerPipeline.addressed("Nova, hello", "  ")).toBe("hello")
  })
})

describe("MessengerPipeline dispatch helpers (SS0.1.5 rule 3 — spawn, don't inline)", () => {
  test("dispatch metadata round-trips through the session-metadata key", () => {
    const metadata = MessengerPipeline.dispatchMetadata({ accountID: "msa_1", chatID: "self" })
    expect(MessengerPipeline.dispatchTarget(metadata)).toEqual({ accountID: "msa_1", chatID: "self" })
  })

  test("dispatchTarget rejects absent or malformed metadata", () => {
    expect(MessengerPipeline.dispatchTarget(undefined)).toBeUndefined()
    expect(MessengerPipeline.dispatchTarget({})).toBeUndefined()
    expect(MessengerPipeline.dispatchTarget({ [MessengerPipeline.DISPATCH_KEY]: "junk" })).toBeUndefined()
    expect(MessengerPipeline.dispatchTarget({ [MessengerPipeline.DISPATCH_KEY]: { accountID: 5, chatID: "c" } })).toBeUndefined()
    expect(MessengerPipeline.dispatchTarget({ other: { accountID: "a", chatID: "c" } })).toBeUndefined()
  })

  test("dispatchTitle flattens whitespace and truncates with an ellipsis", () => {
    expect(MessengerPipeline.dispatchTitle("  fix   the\nflaky test  ")).toBe("fix the flaky test")
    const long = "a".repeat(100)
    const title = MessengerPipeline.dispatchTitle(long)
    expect(title.length).toBeLessThanOrEqual(64)
    expect(title.endsWith("…")).toBe(true)
    expect(MessengerPipeline.dispatchTitle("a".repeat(64))).toBe("a".repeat(64))
  })

  test("renderDispatchDone names the task and carries the result; degrades honestly", () => {
    expect(MessengerPipeline.renderDispatchDone("fix the test", "All green.")).toBe("✅ fix the test\nAll green.")
    expect(MessengerPipeline.renderDispatchDone("fix the test", "  ")).toBe("✅ fix the test")
    expect(MessengerPipeline.renderDispatchDone(undefined, "done")).toBe("✅ Task finished\ndone")
    expect(MessengerPipeline.renderDispatchDone("", "")).toBe("✅ Task finished")
  })

  test("dispatchDoneNeeded suppresses a completion report that only repeats the narration", () => {
    // The live complaint: "Nova, what time is it?" cost four messages. A question's answer and its
    // exit(result) are the same sentence, so the ✅ report is that sentence twice.
    const answer = "It's currently 10:45 AM UTC."
    const talked = false // no tool call but exit — the task only answered
    const worked = true // it ran commands / edited files, so its result summarizes real work
    expect(MessengerPipeline.dispatchDoneNeeded(answer, answer, worked)).toBe(false)
    expect(MessengerPipeline.dispatchDoneNeeded("  It's currently   10:45 AM UTC.\n", answer, worked)).toBe(false) // whitespace-insensitive
    expect(MessengerPipeline.dispatchDoneNeeded("10:45 AM UTC", "The time is 10:45 AM UTC right now", worked)).toBe(false) // a restated slice

    // The live case wording alone could NOT catch — a paraphrase of the answer it already sent.
    // `didWork: false` is what makes it suppressible.
    expect(
      MessengerPipeline.dispatchDoneNeeded(
        "Answered user's question about current time: Thursday, July 23, 2026.",
        "It's **Thursday, July 23, 2026**. I don't have your timezone.",
        talked,
      ),
    ).toBe(false)

    // Real work: the result says something the narration did not.
    expect(MessengerPipeline.dispatchDoneNeeded("All 42 tests pass.", "Running the suite…", worked)).toBe(true)
    // Silence is worse than repetition: a task that never narrated still reports, even bare.
    expect(MessengerPipeline.dispatchDoneNeeded("", undefined, worked)).toBe(true)
    expect(MessengerPipeline.dispatchDoneNeeded("done", undefined, talked)).toBe(true)
    // …but a bare exit after narrating adds nothing.
    expect(MessengerPipeline.dispatchDoneNeeded("", "I finished the refactor.", worked)).toBe(false)
  })
})

describe("MessengerPipeline.bypassBindRefusal (§3.4 bypass-bind warning)", () => {
  test("refuses an untrusted client/audience bind to a bypass/yolo session", () => {
    const client = MessengerPipeline.bypassBindRefusal({ trust: "client", permissionMode: "bypass", force: false })
    expect(client).toContain("bypass")
    expect(client).toContain("no consent gate")
    expect(client).toContain("force:true")
    expect(MessengerPipeline.bypassBindRefusal({ trust: "audience", permissionMode: "yolo", force: false })).toContain("yolo")
  })

  test("operator is exempt, force overrides, and safe modes pass", () => {
    // The owner/family through their own chat is trusted — never warned.
    expect(MessengerPipeline.bypassBindRefusal({ trust: "operator", permissionMode: "bypass", force: false })).toBeUndefined()
    // Explicit confirmation.
    expect(MessengerPipeline.bypassBindRefusal({ trust: "client", permissionMode: "bypass", force: true })).toBeUndefined()
    // A gated mode has a consent gate — no warning needed.
    expect(MessengerPipeline.bypassBindRefusal({ trust: "client", permissionMode: "ask", force: false })).toBeUndefined()
    expect(MessengerPipeline.bypassBindRefusal({ trust: "audience", permissionMode: "surgical", force: false })).toBeUndefined()
  })
})
