import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionV2 } from "@novaclaw/core/session"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { createLLMEventPublisher } from "@novaclaw/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const boundaries: Array<{
    readonly phase: "drain" | "provider" | "tool" | "maintenance"
    readonly checkpoint: "clear" | "mark" | "keep"
  }> = []
  let toolProtocolMarks = 0
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
      executionBoundary: (phase, checkpoint) =>
        Effect.sync(() => {
          boundaries.push({ phase, checkpoint })
        }),
      providerToolProtocol: () =>
        Effect.sync(() => {
          toolProtocolMarks++
        }),
      toolSideEffects: { read: "read" },
    }),
    boundaries,
    toolProtocolMarks: () => toolProtocolMarks,
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  expect(published.find((event) => event.type === "session.next.tool.called.1")?.data).toMatchObject({
    callID: call.id,
    sideEffect: "read",
  })

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("pre-receipt Tool.Called history still decodes conservatively", () => {
  const legacy = {
    sessionID,
    assistantMessageID: SessionMessage.ID.create(),
    timestamp: Date.now(),
    callID: "legacy_call",
    tool: "plugin_tool",
    input: {},
    provider: { executed: false },
  }
  expect(() => Schema.decodeUnknownSync(SessionEvent.Tool.Called.data)(legacy)).not.toThrow()
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher, boundaries } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop" })
  expect(boundaries).toEqual([{ phase: "provider", checkpoint: "mark" }])
})

test("execution boundary records partial output once and fences unsettled tools", async () => {
  const { publisher, boundaries, toolProtocolMarks } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "partial-boundary" })))
  await Effect.runPromise(publisher.publish(LLMEvent.reasoningStart({ id: "reasoning-boundary" })))
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  expect(boundaries).toEqual([
    { phase: "provider", checkpoint: "mark" },
    { phase: "tool", checkpoint: "clear" },
    { phase: "tool", checkpoint: "mark" },
  ])
  expect(toolProtocolMarks()).toBe(1)
})

test("a broken stream settles its partial assistant without publishing a fatal failure", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "partial" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "partial", text: "Useful partial answer" })))
  await Effect.runPromise(publisher.breakAssistant())

  expect(publisher.stepSettlement()).toMatchObject({
    finish: "broken",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  expect(published.some((event) => event.type === "session.next.step.failed.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.text.ended.1")).toBe(true)
})

test("stream checkpoints stay storage-linear and identify their offsets", async () => {
  const { published, publisher } = capture()
  const first = "a".repeat(600)
  const second = "b".repeat(600)
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "text-checkpoint" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-checkpoint", text: first })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "text-checkpoint", text: second })))

  const checkpoints = published
    .filter((event) => event.type === "session.next.text.progress.1")
    .map((event) => {
      const data = event.data as { offset: number; delta: string }
      return { offset: data.offset, delta: data.delta }
    })
  expect(checkpoints).toEqual([
    { offset: 0, delta: first },
    { offset: first.length, delta: second },
  ])
  expect(checkpoints.reduce((sum, checkpoint) => sum + checkpoint.delta.length, 0)).toBe(first.length + second.length)
})
