import { describe, expect, test } from "bun:test"
import {
  CLIENT_LOG_BATCH_SIZE,
  clientLogPayload,
  createClientLogDrain,
  installClientLogSender,
  pushErrorLog,
  type ErrorLogEntry,
} from "./error-log"

const entry = (at: number, level: ErrorLogEntry["level"] = "error"): ErrorLogEntry => ({
  at,
  level,
  text: `fault-${at}`,
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("renderer client-log drain", () => {
  test("boot faults wait in memory until an instance sender exists", async () => {
    const soon: Array<() => void> = []
    const sent: number[] = []
    const drain = createClientLogDrain({ soon: (run) => soon.push(run) })
    drain.enqueue(entry(1))
    expect(soon).toEqual([])

    drain.use(async (item) => {
      sent.push(item.at)
      return true
    })
    expect(soon).toHaveLength(1)
    soon.shift()!()
    await flushPromises()
    expect(sent).toEqual([1])
  })

  test("the production capture path reaches an installed instance sender asynchronously", async () => {
    const sent: ErrorLogEntry[] = []
    const remove = installClientLogSender(async (item) => {
      sent.push(item)
      return true
    })

    pushErrorLog("error", ["renderer broke"])
    expect(sent).toEqual([])
    await flushPromises()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ level: "error", text: "renderer broke" })
    remove()
  })

  test("enqueue leaves the error stack immediately and drains in bounded batches", async () => {
    const soon: Array<() => void> = []
    const releases: Array<() => void> = []
    const sent: number[] = []
    const drain = createClientLogDrain({ soon: (run) => soon.push(run) })
    drain.use(
      (item) =>
        new Promise<boolean>((resolve) => {
          sent.push(item.at)
          releases.push(() => resolve(true))
        }),
    )

    for (let index = 0; index < CLIENT_LOG_BATCH_SIZE + 2; index += 1) drain.enqueue(entry(index))
    expect(sent).toEqual([])
    expect(soon).toHaveLength(1)

    soon.shift()!()
    expect(sent).toEqual(Array.from({ length: CLIENT_LOG_BATCH_SIZE }, (_, index) => index))
    expect(drain.pending()).toBe(2)

    releases.splice(0).forEach((release) => release())
    await flushPromises()
    expect(soon).toHaveLength(1)
    soon.shift()!()
    expect(sent).toEqual(Array.from({ length: CLIENT_LOG_BATCH_SIZE + 2 }, (_, index) => index))
  })

  test("transport rejection retains entries and waits for the retry scheduler", async () => {
    const soon: Array<() => void> = []
    const later: Array<() => void> = []
    const drain = createClientLogDrain({
      soon: (run) => soon.push(run),
      later: (run) => {
        later.push(run)
        return run
      },
      cancelLater: () => undefined,
      batchSize: 2,
    })
    drain.use(async () => {
      throw new Error("offline")
    })
    drain.enqueue(entry(1))
    drain.enqueue(entry(2))
    soon.shift()!()
    await flushPromises()

    expect(drain.pending()).toBe(2)
    expect(later).toHaveLength(1)
    expect(soon).toHaveLength(0)
  })

  test("an explicit limiter refusal is final and does not fight the server", async () => {
    const soon: Array<() => void> = []
    const later: Array<() => void> = []
    const drain = createClientLogDrain({
      soon: (run) => soon.push(run),
      later: (run) => {
        later.push(run)
        return run
      },
    })
    drain.use(async () => false)
    drain.enqueue(entry(1))
    soon.shift()!()
    await flushPromises()

    expect(drain.pending()).toBe(0)
    expect(later).toEqual([])
  })

  test("an offline queue keeps the newest ring-sized window", () => {
    const drain = createClientLogDrain({ capacity: 3 })
    for (let index = 0; index < 5; index += 1) drain.enqueue(entry(index))
    expect(drain.pending()).toBe(3)
  })

  test("wire levels preserve richer renderer kinds as metadata", () => {
    expect(clientLogPayload(entry(0, "warn"))).toMatchObject({ level: "warn", extra: { kind: "warn" } })
    expect(clientLogPayload(entry(0, "notice"))).toMatchObject({ level: "info", extra: { kind: "notice" } })
    expect(clientLogPayload(entry(0, "uncaught"))).toMatchObject({ level: "error", extra: { kind: "uncaught" } })
    expect(clientLogPayload(entry(0, "rejection"))).toMatchObject({
      service: "renderer",
      level: "error",
      message: "fault-0",
      extra: { kind: "rejection", at: "1970-01-01T00:00:00.000Z" },
    })
  })
})
