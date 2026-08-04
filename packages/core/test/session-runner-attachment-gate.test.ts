import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Model } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { FileAttachment } from "@novaclaw/core/session/prompt"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import {
  attachmentModality,
  attachmentSupport,
  toLLMMessages,
  unreadableAttachmentNotice,
  unreadableTurnAttachments,
  type InputCapabilities,
} from "@novaclaw/core/session/runner/to-llm-message"
import { DateTime } from "effect"

/**
 * v0.2.0 prep §10 — the model-capability gate on attachments.
 *
 * Before this, nothing anywhere consulted `ModelV2.Capabilities.input` at turn time: a screenshot
 * lowered to a text-only model failed at the PROVIDER, so the user read a transport-shaped error
 * for what is a model-selection mistake. That is ruling 2's *a fault is never described falsely*,
 * and it matters now because Computer Use — the v0.2.0 north star — attaches an image every turn.
 *
 * ⚠️ WHY THE TESTS ARE SHAPED LIKE THIS. `runner/llm.ts` is the one file the default gate never
 * executes on this machine (`test/session-runner.test.ts` is win32-skipped and is the only suite
 * that drives a turn), so the claim is split the same way `test/runner-config-per-turn.test.ts`
 * splits its own:
 *
 *   · the DECISION is a pure exported function and is exercised for real below, including the
 *     unknown-capabilities arm that would break every local endpoint if it were got backwards;
 *   · that the RUNNER actually consults it is pinned by a source ratchet — the established
 *     instrument on this file (`runner-config-per-turn`, `unattended-bash-safe-mode`,
 *     `tool-path-classification` all use it). A gate that is computed and then not consulted
 *     compiles green and ships silently; nothing but a check like this bites.
 */

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const VISION: InputCapabilities = { input: ["text", "image"] }
const TEXT_ONLY: InputCapabilities = { input: ["text"] }
/** What a hand-added local endpoint carries: `ModelV2.Info.empty` seeds `input: []`. */
const NO_EVIDENCE: InputCapabilities = { input: [] }

const png = FileAttachment.make({
  uri: "data:image/png;base64,aGVsbG8=",
  mime: "image/png",
  name: "screenshot.png",
})

const user = (value: string, files: readonly FileAttachment[]) =>
  SessionMessage.User.make({
    id: id(value),
    type: "user",
    text: "Look at this",
    files: [...files],
    time: { created },
  })

const assistant = (value: string, text: string) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantText.make({ type: "text", id: value, text })],
    time: { created, completed: created },
  })

const partTypes = (capabilities: InputCapabilities | undefined, messages: readonly SessionMessage.Message[]) =>
  toLLMMessages(messages, model, capabilities).flatMap((message) =>
    typeof message.content === "string" ? ["text"] : message.content.map((part) => part.type),
  )

describe("attachmentModality — MIME mapped onto the models.dev modality vocabulary", () => {
  test("classifies the modalities we can name", () => {
    expect(attachmentModality("image/png")).toBe("image")
    expect(attachmentModality("IMAGE/JPEG")).toBe("image")
    expect(attachmentModality("audio/wav")).toBe("audio")
    expect(attachmentModality("video/mp4")).toBe("video")
    expect(attachmentModality("application/pdf")).toBe("pdf")
    expect(attachmentModality("application/x-pdf")).toBe("pdf")
    expect(attachmentModality("text/plain")).toBe("text")
  })

  test("strips RFC-2045 parameters before deciding", () => {
    // Negative control on the parser itself: an anchored `/pdf$` test silently stops matching the
    // moment a charset/qs parameter rides along, which would turn a refusal into a pass by accident.
    expect(attachmentModality("text/plain; charset=utf-8")).toBe("text")
    expect(attachmentModality("application/pdf; qs=0.9")).toBe("pdf")
  })

  test("returns undefined for a type it cannot name — no evidence, never a verdict", () => {
    expect(attachmentModality("application/octet-stream")).toBeUndefined()
    expect(attachmentModality("application/json")).toBeUndefined()
    expect(attachmentModality("")).toBeUndefined()
  })
})

describe("attachmentSupport — the tri-state, and the third state is load-bearing", () => {
  test("a declared modality decides, both ways", () => {
    expect(attachmentSupport(VISION, png)).toBe("supported")
    expect(attachmentSupport(TEXT_ONLY, png)).toBe("unsupported")
  })

  test("⚠️ UNKNOWN IS NOT TEXT-ONLY — absent or empty capability data passes through", () => {
    // Getting this backwards refuses every image on every hand-added local endpoint (vLLM,
    // llama.cpp, Ollama) on day one, including our own test model. The negative control is the
    // TEXT_ONLY assertion above: the same attachment, the same function, an opposite verdict —
    // so these three are not passing merely because nothing is ever refused.
    expect(attachmentSupport(undefined, png)).toBe("unknown")
    expect(attachmentSupport(NO_EVIDENCE, png)).toBe("unknown")
    expect(attachmentSupport(TEXT_ONLY, { mime: "application/octet-stream" })).toBe("unknown")
  })

  test("matches the modality by prefix, exactly as the three live catalog readers do", () => {
    // `core/catalog.ts`, `app/utils/model-catalog.ts` and `app/components/model-tooltip.tsx` all
    // ask `input.some((m) => m.startsWith(kind))`. A second convention here would let the turn gate
    // and the model picker disagree about the same model.
    expect(attachmentSupport({ input: ["text", "image/*"] }, png)).toBe("supported")
    expect(attachmentSupport({ input: ["  TEXT  "] }, { mime: "text/plain" })).toBe("supported")
  })
})

describe("lowering — a vision model gets the bytes, a text-only model gets an honest placeholder", () => {
  test("a vision model lowers the image as a media part", () => {
    expect(partTypes(VISION, [user("vision", [png])])).toEqual(["text", "media"])
  })

  test("NEGATIVE CONTROL: the same image, a text-only model, no media part at all", () => {
    expect(partTypes(TEXT_ONLY, [user("blocked", [png])])).toEqual(["text", "text"])
  })

  test("unknown capabilities lower exactly as before the gate existed", () => {
    // Both the omitted-argument call (every pre-existing caller) and an explicitly empty catalog
    // entry must keep sending bytes.
    expect(
      toLLMMessages([user("legacy", [png])], model).flatMap((m) =>
        typeof m.content === "string" ? [] : m.content.map((p) => p.type),
      ),
    ).toEqual(["text", "media"])
    expect(partTypes(undefined, [user("undef", [png])])).toEqual(["text", "media"])
    expect(partTypes(NO_EVIDENCE, [user("empty", [png])])).toEqual(["text", "media"])
  })

  test("the placeholder names the file, says it was not sent, and forbids the guess", () => {
    const notice = unreadableAttachmentNotice(png)
    expect(notice).toContain("screenshot.png")
    expect(notice).toContain("image/png")
    expect(notice).toContain("NOT sent")
    // A small model handed "an image was attached" routinely describes it anyway — which is
    // ruling 2 broken with our fingerprints on it. The instruction not to guess is the mitigation.
    expect(notice.toLowerCase()).toContain("guess")
    // …and it is what the model actually receives. Assert on "NOT sent", not on the filename: a
    // media part carries `filename` too, so a filename assertion passes even with the gate off.
    const lowered = toLLMMessages([user("blocked", [png])], model, TEXT_ONLY)[0]!
    const rendered = typeof lowered.content === "string" ? lowered.content : JSON.stringify(lowered.content)
    expect(rendered).toContain("NOT sent")
    expect(rendered).not.toContain("data:image/png;base64")
  })

  test("a text/* data: attachment still inlines as text and is never gated", () => {
    // Regression guard on the pre-existing inlining path: it runs BEFORE the gate, so a text file
    // reaches a text-only model as content rather than as a placeholder about itself.
    const note = FileAttachment.make({
      uri: `data:text/plain;base64,${Buffer.from("hello attachment").toString("base64")}`,
      mime: "text/plain",
      name: "note.txt",
    })
    const lowered = toLLMMessages([user("note", [note])], model, TEXT_ONLY)[0]!
    const rendered = typeof lowered.content === "string" ? lowered.content : JSON.stringify(lowered.content)
    expect(rendered).toContain("hello attachment")
    expect(rendered).not.toContain("NOT sent")
  })
})

describe("unreadableTurnAttachments — position decides, not authorship", () => {
  test("refuses the turn's OWN input", () => {
    expect(unreadableTurnAttachments([user("now", [png])], TEXT_ONLY).map((file) => file.name)).toEqual([
      "screenshot.png",
    ])
  })

  test("NEGATIVE CONTROL: a capable model refuses nothing, and neither does unknown evidence", () => {
    expect(unreadableTurnAttachments([user("now", [png])], VISION)).toEqual([])
    expect(unreadableTurnAttachments([user("now", [png])], undefined)).toEqual([])
    expect(unreadableTurnAttachments([user("now", [png])], NO_EVIDENCE)).toEqual([])
  })

  test("HISTORY never refuses — an answered image cannot deadlock the session on a model switch", () => {
    // The dead-end this forbids: a chat that once held an image could otherwise never be continued
    // on a text-only model again. History degrades to a placeholder instead (asserted above).
    const messages = [user("old", [png]), assistant("reply", "I see it"), user("new", [])]
    expect(unreadableTurnAttachments(messages, TEXT_ONLY)).toEqual([])
    // …and the same history still lowers without media, so nothing is smuggled to the provider.
    expect(partTypes(TEXT_ONLY, messages)).toEqual(["text", "text", "text", "text"])
  })

  test("an intervening assistant turn stops the scan even with no newer user message", () => {
    expect(unreadableTurnAttachments([user("old", [png]), assistant("reply", "I see it")], TEXT_ONLY)).toEqual([])
  })

  test("a synthetic notice after the user message does not count as an answer", () => {
    // Our own refusal notice is a Synthetic; treating it as an answer would let a forced re-run
    // silently proceed with an image the model still cannot read.
    const synthetic = SessionMessage.Synthetic.make({
      id: id("notice"),
      type: "synthetic",
      sessionID: SessionV2.ID.make("ses_gate"),
      text: "⚠️ This turn couldn't run",
      time: { created },
    })
    expect(unreadableTurnAttachments([user("now", [png]), synthetic], TEXT_ONLY)).toHaveLength(1)
  })

  test("an empty context refuses nothing", () => {
    expect(unreadableTurnAttachments([], TEXT_ONLY)).toEqual([])
  })
})

describe("ModelInputUnsupportedError — a complete, true, user-facing sentence", () => {
  test("names the model, the modality and the file, and prescribes both repairs", () => {
    const error = new SessionRunnerModel.ModelInputUnsupportedError({
      providerID: ProviderV2.ID.make("dgx-spark"),
      modelID: ModelV2.ID.make("qwen3.6-35b"),
      modality: "image",
      files: ["screenshot.png"],
    })
    expect(error.message).toContain("dgx-spark/qwen3.6-35b")
    expect(error.message).toContain("image")
    expect(error.message).toContain("screenshot.png")
    // Ruling 10 + the self-healing law: the catalog is runtime-editable, so a wrong models.dev
    // entry is repairable from inside the OS — the message has to say so, not just "pick another".
    expect(error.message).toContain("Settings")
    expect(error._tag).toBe("SessionRunnerModel.ModelInputUnsupportedError")
    // ⚠️ THE PRECONDITION THE WHOLE NOTICE HANGS ON. `surfacePreTurnFailure` renders
    // `error instanceof Error && error.message ? error.message : "an unexpected error occurred"`.
    // If a tagged error were not an `Error`, this refusal would surface as "an unexpected error
    // occurred" — the generic sentence it exists to replace — and nothing else would notice.
    expect(error instanceof Error, "the refusal must be an Error or surfacePreTurnFailure discards its message").toBe(
      true,
    )
    expect(error.message.length).toBeGreaterThan(0)
  })

  test("it is a member of the runner's model-error union", () => {
    const value: SessionRunnerModel.Error = new SessionRunnerModel.ModelInputUnsupportedError({
      providerID: ProviderV2.ID.make("p"),
      modelID: ModelV2.ID.make("m"),
      modality: "image",
      files: [],
    })
    expect(value._tag).toBe("SessionRunnerModel.ModelInputUnsupportedError")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The source ratchet: the runner actually CONSULTS the gate.
// ─────────────────────────────────────────────────────────────────────────────

const runnerPath = path.join(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src"),
  "session",
  "runner",
  "llm.ts",
)

/**
 * Drop comment-only lines before matching — `runner/llm.ts` is heavily commented, including by this
 * very change, and a ratchet satisfied by prose describing the invariant protects nothing.
 */
const codeOnly = (text: string) =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")

describe("runner/llm.ts is wired to the gate", () => {
  const source = codeOnly(readFileSync(runnerPath, "utf8"))
  // `toContain` on a 100 KB string dumps the whole runner into the failure report, which buries the
  // one line that matters. Assert on the boolean and let the label carry the diagnosis.
  const wired = (fragment: string, why: string) => expect(source.includes(fragment), why).toBe(true)

  test("the ratchet's own reader still sees the runner", () => {
    // A source ratchet that silently matches nothing passes forever. Pin the file first.
    expect(source.length, "runner source read empty — the ratchet is broken").toBeGreaterThan(30_000)
    wired("toLLMMessages(", "the runner no longer lowers history — this ratchet is aimed at the wrong file")
  })

  test("the turn's own input is gated before the request is built", () => {
    wired(
      "unreadableTurnAttachments(context",
      "the runner never calls unreadableTurnAttachments — the gate is dead code",
    )
    wired("ModelInputUnsupportedError({", "a blocked turn must raise ModelInputUnsupportedError, not fall through")
    wired("surfacePreTurnFailure(refusal)", "the refusal must be surfaced in the CHAT, not only the server log")
  })

  test("the capability evidence is read and handed to lowering", () => {
    wired("models.capabilities(", "nothing reads the resolved model's capabilities")
    // The regression this catches: lowering keeps its old two-argument call, so history silently
    // ships media bytes to a model that cannot read them while the pre-turn gate looks healthy.
    wired("toLLMMessages(context, model, modelCapabilities)", "toLLMMessages is not receiving the capabilities")
  })

  test("a capability refusal is not re-described as 'the model is unavailable'", () => {
    // Ruling 2. The error carries providerID/modelID, which is exactly the shape
    // `surfacePreTurnFailure` templates into "…is unavailable" — a false description of a model
    // that is present, reachable, and merely blind.
    wired(
      "error instanceof SessionRunnerModel.ModelInputUnsupportedError",
      "surfacePreTurnFailure must exempt the capability refusal from the model-identity template",
    )
  })
})
