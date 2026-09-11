import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { toLLMMessages } from "./to-llm-message"
import { SessionMessage } from "@novaclaw/core/session/message"

/**
 * 🔴 A model switch must be INAUDIBLE to the officer whose model was switched.
 *
 * The owner's instruction, 2026-09-09: *"the officer itself should not be told about the switch,
 * since that will distract it, especially if such switches occur often (e.g. later we will implement
 * using one model for reasoning and another for execution in the same officer)."*
 *
 * This is the guard for that, and it is worth a real test rather than a comment because the change
 * this session makes is precisely one that causes MORE switches: a chat that never picked a model now
 * follows its officer, so an officer re-pointed at another model moves every one of its chats, and a
 * model being switched off moves whatever was running on it. If switch notices leaked into the
 * lowered request, every one of those events would arrive in the officer's context as a sentence
 * about infrastructure — competing with the work for the same attention the owner is protecting.
 *
 * The mechanism being pinned is `to-llm-message.ts`'s `case "model-switched": return []`. Note what
 * it is NOT: the event is not hidden from anyone. It stays in the transcript and the UI, where the
 * HUMAN reads it, and it stays in the log. Lowering is where the two audiences separate, which is why
 * the assertion belongs here and not in the projector.
 *
 * A/B: delete the `case "model-switched"` arm (falling through to the default) and this test finds a
 * message where there should be none.
 */
const created = DateTime.makeUnsafe(0)
const model = { id: "qwen", providerID: "dgx-spark" } as never

const switched = (id: string, type: "model-switched" | "agent-switched"): SessionMessage.Message =>
  ({
    id: SessionMessage.ID.make(`msg_${id}`),
    type,
    ...(type === "model-switched"
      ? { model: { providerID: "dgx-spark", id: "qwen" } }
      : { agent: "umbris" }),
    time: { created },
  }) as SessionMessage.Message

const user = (text: string, id = "u1"): SessionMessage.Message =>
  ({
    id: SessionMessage.ID.make(`msg_${id}`),
    type: "user",
    text,
    time: { created },
  }) as SessionMessage.Message

describe("a switch is bookkeeping, not conversation", () => {
  test("🔴 a model switch lowers to NOTHING the officer can read", () => {
    // Assert LENGTH, not `toEqual([])`: `toLLMMessage` has no `default` arm, so a dropped `case`
    // returns `undefined`, and `toEqual` lets `[undefined]` pass as empty. A mutation check proved
    // that hole — the assertion below is the one that survives it.
    expect(toLLMMessages([switched("s1", "model-switched")], model)).toHaveLength(0)
  })

  test("🔴 and it does not survive by riding along inside a real turn", () => {
    // The realistic shape: work, a switch, more work. The transcript carries all three; the lowered
    // request carries the two turns and no trace of the middle one.
    const lowered = toLLMMessages(
      [user("do the thing"), switched("s1", "model-switched"), user("now finish it", "u2")],
      model,
    )
    expect(lowered.length).toBe(2)
    const text = JSON.stringify(lowered)
    expect(text).not.toContain("switch")
    expect(text).not.toContain("model-switched")
  })

  test("the same silence covers an officer switch, which is the same kind of bookkeeping", () => {
    expect(toLLMMessages([switched("s2", "agent-switched")], model)).toHaveLength(0)
  })
})
