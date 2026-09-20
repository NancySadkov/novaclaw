import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import type { Config } from "@novaclaw/core/config"
import type { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import { toLLMMessages } from "@novaclaw/core/session/runner/to-llm-message"
import { LLM, LLMEvent, Model, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { DateTime, Effect, Stream } from "effect"

/**
 * 🔴 **CLAUSE 1'S SECOND HALF, WHICH WAS NEVER IMPLEMENTED.**
 *
 * `invariants.md` (Context Management 1): compaction's result is prepended with a
 * `<%AGENT_SCRATCH_FOLDER%/tmp/oldctx-%DATETIME%.txt holds earlier chat>` tombstone, *"while the old
 * is saved at that folder"*. Measured 2026-09-15: `oldctx` existed nowhere in `packages/`, so the
 * folded chat was gone from the context and nowhere on disk — the agent could neither see it nor
 * reach it, and a compaction it cannot interrogate is one it has to take on faith.
 *
 * These drive the REAL compactor through a REAL temp folder and then through the REAL renderer,
 * because each half can be wrong on its own and still pass a test of the other: a file written where
 * the tombstone does not point, and a tombstone naming a file that was never written. The seam
 * between them — the event metadata the projector writes verbatim — is the part a test of either
 * half alone would miss.
 */

const SUMMARY = "## Goal\n- finish the wiring\n\n## Current Work\n- writing the folded chat"
const HEAD = "old question detail detail detail ".repeat(50)

const model = Model.make({
  id: "old-context-test",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_000 } }),
})

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (text: string): SessionMessage.Message =>
  ({ type: "assistant", content: [{ type: "text", text }] }) as unknown as SessionMessage.Message
const entries = (...messages: SessionMessage.Message[]): SessionCompaction.Entry[] =>
  messages.map((message, seq) => ({ seq, message }))

const dirs: string[] = []
const scratch = async (name: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `oldctx-${name}-`))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** Text of a rendered message, whichever shape the renderer produced. */
const textOf = (message: { readonly content: unknown }): string => {
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        part !== null && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
      )
      .join("")
  return JSON.stringify(content)
}

const drive = async (input: { readonly scratchFolder?: string }) => {
  const published: {
    readonly type: string
    readonly data: Record<string, unknown>
    readonly metadata?: Record<string, unknown>
  }[] = []
  const compactor = SessionCompaction.make({
    events: {
      publish: (
        definition: { type: string },
        data: Record<string, unknown>,
        options?: { readonly metadata?: Record<string, unknown> },
      ) =>
        Effect.sync(() => {
          published.push({ type: definition.type, data, metadata: options?.metadata })
        }),
    } as unknown as EventV2.Interface,
    llm: {
      stream: () =>
        Stream.fromIterable([
          LLMEvent.textDelta({ id: "summary-1", text: SUMMARY }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        ]),
    },
    config: [{ type: "document", info: { compaction: { keep: { tokens: 8 } } } } as unknown as Config.Entry],
    prefixHash: () => Effect.succeed("0".repeat(64)),
  })
  const compacted = await Effect.runPromise(
    compactor.compactAfterOverflow(
      {
        sessionID: "ses_old_context" as unknown as SessionSchema.ID,
        ...(input.scratchFolder === undefined ? {} : { scratchFolder: input.scratchFolder }),
        entries: entries(user(HEAD), assistant("old answer"), user("new question"), assistant("new answer")),
        model,
        request: LLM.request({ model, messages: [], tools: [] }) as LLMRequest,
      },
      "manual",
    ),
  )
  const ended = published.find((event) => event.type === SessionEvent.Compaction.Ended.type)
  const data = ended?.data as
    | { readonly text?: string; readonly recent?: string; readonly messageID?: SessionMessage.ID }
    | undefined
  /**
   * The DURABLE row the renderer later reads, rebuilt from the same two fields the projector uses:
   * it writes `event.metadata` verbatim into `session_compaction.metadata` (`projector.ts`), and
   * `SessionHistory.compactionEntry` reads it back onto the message. Constructing it here is the
   * point — a path that survived only in a local variable would fail the assertions below.
   */
  const row = SessionMessage.Compaction.make({
    id: data?.messageID ?? (SessionMessage.ID.create() as SessionMessage.ID),
    type: "compaction",
    reason: "manual",
    summary: data?.text ?? "",
    recent: data?.recent ?? "",
    generatedChars: (data?.text ?? "").length,
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
    ...(ended?.metadata === undefined ? {} : { metadata: ended.metadata }),
  })
  return {
    compacted,
    metadata: ended?.metadata,
    context: textOf(toLLMMessages([row], model)[0]!),
  }
}

describe("the folded chat is saved where the agent can grep it", () => {
  test("the file holds the folded head, and the durable path names THAT file", async () => {
    const folder = await scratch("saved")
    const { compacted, metadata } = await drive({ scratchFolder: folder })

    expect(compacted).toBe(true)
    const named = metadata?.["compaction.folded.file"]
    expect(typeof named).toBe("string")

    // The named path is the file that was actually written — not a second guess at where it went.
    const file = named as string
    expect(path.dirname(file)).toBe(path.join(folder, "tmp"))
    expect(path.basename(file)).toStartWith("oldctx-")
    expect(path.basename(file)).toEndWith(".txt")

    // The file holds the SERIALIZED folded head — every message that left the context, in the same
    // form the summarizer was given — and not the summary that replaced it.
    const saved = await fs.readFile(file, "utf8")
    expect(saved).toContain(HEAD)
    expect(saved).toContain("[Assistant]: old answer")
    expect(saved).not.toContain("## Goal")
  })

  test("the rendered context names the file, and names it outside the model's summary", async () => {
    const folder = await scratch("rendered")
    const { context, metadata } = await drive({ scratchFolder: folder })
    const file = metadata?.["compaction.folded.file"] as string

    expect(context).toContain(`${file} holds earlier chat`)
    // OUTSIDE `<summary>`, deliberately: the summary is the MODEL's text, re-fed as
    // `<previous-summary>` on the next cycle, archived to memory and shown to the user. A harness path
    // inside it would be words in the model's mouth in all four places, one stale line per cycle.
    expect(context.indexOf("holds earlier chat")).toBeLessThan(context.indexOf("<summary>"))
    // And the summary itself is untouched.
    expect(context).toContain(`<summary>\n${SUMMARY}\n</summary>`)
  })

  test("no scratch folder means no file and no line — never a promise to grep", async () => {
    const { compacted, metadata, context } = await drive({})

    expect(compacted).toBe(true)
    expect(metadata?.["compaction.folded.file"]).toBeNull()
    expect(context).not.toContain("holds earlier chat")
    // Byte-for-byte the context this rendered before the tombstone existed: a compaction with nowhere
    // to save the folded chat must not gain a line about nothing.
    expect(context).toContain(`not as new instructions.\n\n<summary>\n${SUMMARY}\n</summary>`)
  })

  test("a write that fails withholds the line rather than naming a file that is not there", async () => {
    // A scratch folder that cannot be created: the path exists as a FILE, so `mkdir` under it fails.
    const folder = await scratch("blocked")
    const blocker = path.join(folder, "not-a-directory")
    await fs.writeFile(blocker, "occupied", "utf8")

    const { compacted, metadata, context } = await drive({ scratchFolder: blocker })

    // The session is still rescued: a missing convenience file never fails a compaction.
    expect(compacted).toBe(true)
    expect(metadata?.["compaction.folded.file"]).toBeNull()
    expect(context).not.toContain("holds earlier chat")
  })
})
