import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeByteBoundedOutbox } from "./pty-outbox"

describe("PTY WebSocket outbox", () => {
  test("rejects output after its byte ceiling and releases bytes on take", async () => {
    const outbox = await Effect.runPromise(makeByteBoundedOutbox((value: string) => value.length, 5))

    expect(outbox.offerUnsafe("1234")).toBe(true)
    expect(outbox.queuedBytes()).toBe(4)
    expect(outbox.offerUnsafe("12")).toBe(false)
    expect(outbox.overflowed()).toBe(true)
    expect(outbox.queuedBytes()).toBe(4)

    expect(await Effect.runPromise(outbox.take)).toBe("1234")
    expect(outbox.queuedBytes()).toBe(0)
    expect(outbox.offerUnsafe("1")).toBe(false)
  })

  test("rejects a full queue even when the byte budget remains", async () => {
    const outbox = await Effect.runPromise(makeByteBoundedOutbox(() => 1, 10_000))

    for (let index = 0; index < 1024; index++) expect(outbox.offerUnsafe(index)).toBe(true)
    expect(outbox.offerUnsafe(1024)).toBe(false)
    expect(outbox.overflowed()).toBe(true)
    expect(outbox.queuedBytes()).toBe(1024)
  })
})
