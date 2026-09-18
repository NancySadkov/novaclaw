import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from ".."
import { Auth, LLMClient } from "../route"
import { OpenAIChat } from "./openai-chat"

/**
 * THE WIRE SYSTEM MESSAGE — the bytes "Export Prompt" promises to hand back.
 *
 * 🔴 Owner, 2026-09-17: the exported prompt must be byte-equal to what the OpenAI endpoint receives,
 * with the one `PromptManager` prompt as `{ role: "system", content }`, so a user can replay it with
 * `curl` against another OpenAI-compatible provider. `PromptCapture` writes `LLMClient.prepare(...)`
 * `.bodyText`; this pins what that string contains and that it is deterministic.
 */

const route = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "qwen3.6-35b" })

const PROMPT = "You're officer agent of a NovaClaw instance — multi-agent AI workgroup."

const prepared = () =>
  Effect.runSync(
    LLMClient.prepare(
      LLM.request({
        model: route,
        system: PROMPT,
        prompt: "Say hello.",
      } as Parameters<typeof LLM.request>[0]),
    ),
  )

describe("openai-chat — the captured wire body carries the system prompt", () => {
  test("bodyText is an OpenAI body whose first message is the sent system prompt", () => {
    const { bodyText } = prepared()
    expect(typeof bodyText).toBe("string")
    const body = JSON.parse(bodyText!) as { readonly messages?: ReadonlyArray<Record<string, unknown>> }
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages?.[0]?.["role"]).toBe("system")
    // Byte-for-byte: the content is exactly the system text we passed (no tools, so no appended
    // tools section), which is what makes the export replayable rather than merely similar.
    expect(body.messages?.[0]?.["content"]).toBe(PROMPT)
    expect(body.messages?.[1]?.["role"]).toBe("user")
  })

  test("the captured body is deterministic, so the exported bytes equal the dispatched ones", () => {
    // The runner captures with `prepare(request)` while the dispatch compiles the same request again.
    // Byte-equality by determinism is the guarantee; this fails the day either compile drifts.
    expect(prepared().bodyText).toBe(prepared().bodyText)
  })
})
