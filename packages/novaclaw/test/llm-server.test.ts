import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SYSTEM as STATUS_SYSTEM } from "@novaclaw/core/agent-status/label"
import { SYSTEM as COMMAND_SYSTEM } from "@novaclaw/core/agent-status/command-label"
import { SYSTEM as WORKER_SYSTEM } from "@novaclaw/core/agent-status/worker-label"
import { SYSTEM as TITLE_SYSTEM } from "@novaclaw/core/session/title"
import { isMetadataRequest, TestLLMServer } from "./lib/llm-server"

test("metadata requests leave the interactive response queue intact", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("the interactive reply")
      const post = (messages: Array<{ role: string; content: string }>) =>
        Effect.promise(async () => {
          const response = await fetch(`${llm.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "test-model", messages, stream: true }),
          })
          expect(response.ok).toBe(true)
          return response.text()
        })
      // ShortAnswer appends a reasoning-budget instruction to the canonical system prompt.
      for (const system of [STATUS_SYSTEM, COMMAND_SYSTEM, WORKER_SYSTEM, TITLE_SYSTEM]) {
        const metadata = yield* post([{ role: "system", content: `${system}\nReasoning budget: 128 tokens.` }])
        expect(metadata).not.toContain("the interactive reply")
        expect(yield* llm.pending).toBe(1)
      }
      const user = [{ role: "user", content: "Generate a title for this conversation" }]
      expect(isMetadataRequest({ messages: user })).toBe(false)
      expect(yield* post(user)).toContain("the interactive reply")
      expect(yield* llm.pending).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
})
