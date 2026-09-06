import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LLMEvent, Model } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { make } from "../scheduler"
import { generate } from "./short-answer"

const model = Model.make({ id: "utility", provider: "test", route: OpenAIChat.route })
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("ShortAnswer interactive-idle admission", () => {
  test("the provider stream cannot start while an interactive turn holds the same device", async () => {
    const scheduler = make()
    await run(scheduler.admit({ sessionID: "ui", deviceKey: "device", sessionClass: "interactive" }))
    let requests = 0
    const answer = Effect.runFork(
      generate({
        model,
        llm: {
          stream: () => {
            requests++
            return Stream.fromIterable([
              LLMEvent.textDelta({ id: "answer", text: "Concise label" }),
              LLMEvent.finish({ reason: "stop" }),
            ])
          },
        },
        system: "Return one label.",
        text: "A long conversation",
        reasoningBudget: 128,
        maxTokens: 512,
        scheduler,
        maintenance: { ownerID: "owner", task: "title", deviceKey: "device" },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(requests).toBe(0)
    expect((await run(scheduler.snapshot()))[0]!.waitingMaintenance).toHaveLength(1)

    await run(scheduler.release({ sessionID: "ui", deviceKey: "device" }))
    expect(await run(Fiber.join(answer))).toBe("Concise label")
    expect(requests).toBe(1)
    expect((await run(scheduler.snapshot()))[0]!.inFlightMaintenance).toEqual([])
  })

  test("zero budget disables thinking on the first request", async () => {
    const scheduler = make()
    let body: Record<string, unknown> | undefined
    const answer = await run(
      generate({
        model,
        llm: {
          stream: (request) => {
            body = request.http?.body
            return Stream.fromIterable([
              LLMEvent.textDelta({ id: "answer", text: "Search the project" }),
              LLMEvent.finish({ reason: "stop" }),
            ])
          },
        },
        system: "Return one label.",
        text: "rg -n hello packages",
        reasoningBudget: 0,
        maxTokens: 512,
        scheduler,
        maintenance: { ownerID: "owner", task: "tool-title", deviceKey: "device" },
      }),
    )

    expect(answer).toBe("Search the project")
    expect(body?.["chat_template_kwargs"]).toEqual({ enable_thinking: false })
  })
})
