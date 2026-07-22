import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { TelegramDriver } from "@novaclaw/core/messenger/driver/telegram"
import type { FetchLike } from "@novaclaw/core/messenger/driver/telegram"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// P1 gate (notes/messenger-plan.md §8): the Telegram bot driver against a FAKE Bot API server —
// getUpdates→normalize, sendMessage→chunk+call shape, self-echo tagging, durable offset advance.
// Live clock: real promises (fake fetch) + a forked poll loop + a queue.

// A tiny fake Bot API: scripted getUpdates batches + a call log. Returns Telegram-shaped JSON.
const makeFakeApi = (updateBatches: unknown[][]) => {
  const calls: { method: string; body: unknown }[] = []
  let batch = 0
  const fetchImpl: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? ""
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, body })
    if (method === "getMe") return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "NovaBot" } })
    if (method === "getUpdates") {
      if (batch >= updateBatches.length) {
        // Exhausted the script → simulate a real long-poll holding open with no updates (never
        // resolves within the test). The scoped connection interrupts this await on close, so the
        // poll loop parks instead of busy-spinning on empty responses.
        return new Promise<Response>(() => {})
      }
      const result = updateBatches[batch] ?? []
      batch += 1
      return Response.json({ ok: true, result })
    }
    if (method === "sendMessage")
      return Response.json({ ok: true, result: { message_id: 5000 + calls.length, chat: { id: body.chat_id, type: "private" }, date: 1 } })
    return Response.json({ ok: false, description: "unknown method" })
  }
  return { fetchImpl, calls }
}

const collect = (
  fetchImpl: FetchLike,
  opts?: { cursorStore?: { value: unknown } },
) =>
  Effect.gen(function* () {
    const cursor = opts?.cursorStore ?? { value: undefined as unknown }
    const received: InboundEvent[] = []
    yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* TelegramDriver.make(fetchImpl).connect({
          account: {
            id: "msa_x" as never,
            driverID: "telegram",
            label: "t",
            enabled: true,
            settings: {},
          } as never,
          secret: "TOKEN",
          cursor: {
            get: () => Effect.sync(() => cursor.value),
            set: (value) => Effect.sync(() => (cursor.value = value)),
          },
        })
        // Pull a few events, then leave the scope (ending the poll loop).
        yield* connection.inbound.pipe(Stream.take(2), Stream.runForEach((event) => Effect.sync(() => received.push(event))))
        return connection
      }),
    )
    return received
  })

describe("TelegramDriver", () => {
  it.live("normalizes a text message and tags self-echo via getMe", () =>
    Effect.gen(function* () {
      const { fetchImpl } = makeFakeApi([
        [
          {
            update_id: 100,
            message: {
              message_id: 7,
              from: { id: 12345, first_name: "Nancy", username: "nancy" },
              chat: { id: 12345, type: "private", first_name: "Nancy" },
              date: 1_700_000,
              text: "hello nova",
            },
          },
          {
            update_id: 101,
            message: {
              message_id: 8,
              from: { id: 999, is_bot: true, username: "NovaBot" },
              chat: { id: 12345, type: "private" },
              date: 1_700_001,
              text: "(my own echo)",
            },
          },
        ],
      ])
      const received = yield* collect(fetchImpl)
      expect(received).toHaveLength(2)
      const [first, second] = received
      expect(first?.kind).toBe("message")
      if (first?.kind === "message") {
        expect(first.chat.chatID).toBe("12345")
        expect(first.chat.kind).toBe("dm")
        expect(first.text).toBe("hello nova")
        expect(first.sender.name).toBe("nancy")
        expect(first.sender.isSelf).toBe(false)
      }
      if (second?.kind === "message") expect(second.sender.isSelf).toBe(true)
    }),
  )

  it.live("a rejected bot token fails connect legibly instead of showing connected", () =>
    Effect.gen(function* () {
      // Regression (found by the P2 settings walkthrough): a bad token used to leave the account
      // "connected" while it silently polled 401s forever — getMe is the token gate now.
      const fetchImpl: FetchLike = async () =>
        Response.json({ ok: false, error_code: 401, description: "Unauthorized" })
      const failure = yield* Effect.scoped(
        TelegramDriver.make(fetchImpl).connect({
          account: { id: "msa_x" as never, driverID: "telegram", label: "t", enabled: true, settings: {} } as never,
          secret: "BAD-TOKEN",
          cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
        }),
      ).pipe(Effect.flip)
      expect(failure._tag).toBe("MessengerDriver.ConnectError")
      if (failure._tag === "MessengerDriver.ConnectError") {
        expect(failure.reason).toContain("rejected this bot token")
        expect(failure.reason).toContain("Unauthorized")
      }
    }),
  )

  it.live("advances and persists the update offset (durable cursor)", () =>
    Effect.gen(function* () {
      const cursorStore = { value: undefined as unknown }
      const { fetchImpl, calls } = makeFakeApi([
        [{ update_id: 42, message: { message_id: 1, chat: { id: 5, type: "private" }, date: 1, text: "a" } }],
        [{ update_id: 43, message: { message_id: 2, chat: { id: 5, type: "private" }, date: 1, text: "b" } }],
      ])
      yield* collect(fetchImpl, { cursorStore })
      // After consuming update 42 then 43, the persisted offset is last_update_id + 1 = 44.
      expect(cursorStore.value).toBe(44)
      // The second getUpdates must have been called with offset = 43 (42 + 1).
      const getUpdatesCalls = calls.filter((call) => call.method === "getUpdates")
      expect((getUpdatesCalls[1]?.body as { offset?: number })?.offset).toBe(43)
    }),
  )

  it.live("normalizes a document attachment and a group chat", () =>
    Effect.gen(function* () {
      const { fetchImpl } = makeFakeApi([
        [
          {
            update_id: 1,
            message: {
              message_id: 3,
              from: { id: 1, first_name: "Client" },
              chat: { id: -400, type: "supergroup", title: "Support" },
              date: 1,
              caption: "here is the brief",
              document: { file_id: "FILE1", file_name: "brief.pdf", mime_type: "application/pdf", file_size: 1234 },
            },
          },
          { update_id: 2, message: { message_id: 4, chat: { id: -400, type: "supergroup", title: "Support" }, date: 1, text: "ping" } },
        ],
      ])
      const received = yield* collect(fetchImpl)
      const [doc] = received
      if (doc?.kind === "message") {
        expect(doc.chat.kind).toBe("group")
        expect(doc.chat.title).toBe("Support")
        expect(doc.text).toBe("here is the brief")
        expect(doc.attachments?.[0]).toMatchObject({ id: "FILE1", name: "brief.pdf", mime: "application/pdf", size: 1234 })
      }
    }),
  )

  it.live("sendMessage chunks HTML to the 4096 limit and reports the last id", () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = makeFakeApi([[]])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* TelegramDriver.make(fetchImpl).connect({
            account: { id: "msa_x", driverID: "telegram", label: "t", enabled: true, settings: {} } as never,
            secret: "TOKEN",
            cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
          })
          const long = "x".repeat(9000)
          const result = yield* connection.send("777", { text: long })
          expect(result.messageID).not.toBe("0")
          const sends = calls.filter((call) => call.method === "sendMessage")
          expect(sends.length).toBe(3) // 9000 / 4096 → 3 chunks
          for (const send of sends) {
            const text = (send.body as { text: string }).text
            expect(text.length).toBeLessThanOrEqual(4096)
            expect((send.body as { parse_mode: string }).parse_mode).toBe("HTML")
          }
        }),
      )
    }),
  )
})
