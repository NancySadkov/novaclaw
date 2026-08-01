import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import { applySteerProvenance, STEER_PROVENANCE_PREFIX } from "@novaclaw/core/session/steer-provenance"
import type { SessionMessage } from "@novaclaw/core/session/message"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

// ── B2 follow-up: compaction was the SEVENTH unfiltered user-role read ──────────────────────────
//
// A harness steer (doom-loop redirect, quality nudge, introspection prompt) is authored by the
// harness but rides the `user` role into the transcript; the 1N provenance prefix is the only thing
// that marks it. `serializeMessage` used to render every user-role message as `[User]: …`, so the
// harness's own instruction text was handed to the summarizer as something the USER said — and the
// summary is DURABLE, so the misattribution outlived the turn that produced it (the template even
// has a "Constraints & Preferences — user constraints" section for it to land in).
//
// The fix RELABELS rather than drops, matching the renderer (`session-ui`'s `SteerMessage`): the
// redirect is real history that explains why the assistant changed course, so the summarizer keeps
// it — under a speaker label that is unmistakably not the user.

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const steer = (text: string): SessionMessage.Message => user(applySteerProvenance(text))
const assistant = (text: string): SessionMessage.Message =>
  ({ type: "assistant", content: [{ type: "text", text }] }) as unknown as SessionMessage.Message
const entries = (...messages: SessionMessage.Message[]): SessionCompaction.Entry[] =>
  messages.map((message, seq) => ({ seq, message }))

/** The wording of a real doom-loop nudge, so the fixture cannot drift from the thing detected. */
const NUDGE = "You have called `bash` with identical arguments 3 times in a row. Stop repeating it."

describe("a steer is never attributed to the user in the compaction summary", () => {
  test("serializeMessage labels a steer as an automated check, not as [User]", () => {
    const line = SessionCompaction.serializeMessage(steer(NUDGE))
    expect(line).not.toContain("[User]:")
    expect(line).toContain("Automated")
    // The label carries the provenance, so the prefix is not repeated inside the body.
    expect(line).not.toContain(STEER_PROVENANCE_PREFIX)
    // Relabelled, NOT dropped — the redirect itself survives into the summary.
    expect(line).toContain("Stop repeating it")
  })

  test("a real user turn is still [User], and its files still ride along", () => {
    expect(SessionCompaction.serializeMessage(user("count the digits of pi"))).toBe("[User]: count the digits of pi")
    const withFile = {
      type: "user",
      text: "look at this",
      files: [{ mime: "image/png", name: "pixel.png", uri: "data:image/png;base64,AAAA" }],
    } as unknown as SessionMessage.Message
    expect(SessionCompaction.serializeMessage(withFile)).toBe("[User]: look at this\n[Attached image/png: pixel.png]")
  })

  test("the steer label is distinct from every other speaker label", () => {
    const labels = [
      SessionCompaction.serializeMessage(steer(NUDGE)),
      SessionCompaction.serializeMessage(user("hi")),
      SessionCompaction.serializeMessage(assistant("hello")),
      SessionCompaction.serializeMessage({ type: "system", text: "note" } as unknown as SessionMessage.Message),
      SessionCompaction.serializeMessage({ type: "synthetic", text: "note" } as unknown as SessionMessage.Message),
    ].map((line) => line.slice(0, line.indexOf("]:") + 2))
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain("[User]:")
    expect(labels).toContain("[System update]:")
  })

  test("neither durable half of the split — the summarized head nor the retained recent — says [User] about a steer", () => {
    // `head` feeds the summary prompt; `recent` is stored verbatim on the compaction message and is
    // re-fed as context on the NEXT compaction, so a misattribution there compounds.
    const transcript = entries(
      user("count the digits of pi"),
      assistant("Earlier answer"),
      steer(NUDGE),
      assistant("Continuing with a different approach"),
    )
    const wide = SessionCompaction.selectContext(transcript, 100_000)
    const narrow = SessionCompaction.selectContext(transcript, 1)
    for (const selected of [wide, narrow]) {
      expect(selected).toBeDefined()
      const both = `${selected!.head}\n${selected!.recent}`
      expect(both).not.toContain(`[User]: ${STEER_PROVENANCE_PREFIX}`)
      expect(both).not.toContain(STEER_PROVENANCE_PREFIX)
      expect(both).toContain("[User]: count the digits of pi")
    }
    // The whole transcript fits in the wide budget, so nothing is split off: the steer is present
    // (relabelled) and the assistant text that FOLLOWED it is still attached to this exchange.
    expect(wide!.recent).toContain("Stop repeating it")
    expect(wide!.recent).toContain("Continuing with a different approach")
    expect(wide!.head).toBe("")
  })

  test("the cut point stays on a completed assistant-turn boundary", () => {
    const transcript = entries(
      user("old question"),
      assistant("old answer"),
      user(`new question ${"detail ".repeat(200)}`),
      assistant("new answer"),
    )
    const selected = SessionCompaction.selectContext(transcript, 20)
    expect(selected).toBeDefined()
    expect(selected!.head).toContain("old question")
    expect(selected!.head).toContain("old answer")
    expect(selected!.recent).toContain("new question")
    expect(selected!.recent).toContain("new answer")
    // No message is token-sliced: both durable halves contain whole model-visible messages.
    expect(`${selected!.head}\n${selected!.recent}`.split("new question").length - 1).toBe(1)
  })

  test("a steer-only transcript contributes no user-attributed text at all", () => {
    const selected = SessionCompaction.selectContext(entries(steer(NUDGE)), 100_000)
    expect(selected).toBeDefined()
    expect(`${selected!.head}\n${selected!.recent}`).not.toContain("[User]:")
  })
})
