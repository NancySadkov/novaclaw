import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Deferred, Duration, Effect, Fiber, Option, Queue } from "effect"
import { createOverflowTerminatingHandler, makeBoundedInboundQueue } from "@novaclaw/core/messenger/driver/inbound-queue"
import { makeBoundedMap } from "@novaclaw/core/messenger/driver/bounded-map"

describe("messenger ingress queues", () => {
  test("production messenger drivers cannot reintroduce an unbounded queue", async () => {
    const directory = fileURLToPath(new URL("../src/messenger/driver/", import.meta.url))
    const files = (await readdir(directory)).filter((file) => file.endsWith(".ts"))
    const violations = await Promise.all(
      files.map(async (file) => {
        const source = await readFile(`${directory}/${file}`, "utf8")
        return /Queue\.unbounded\s*(?:<|\()/.test(source) ? file : undefined
      }),
    )

    expect(violations.filter((file) => file !== undefined)).toEqual([])
  })

  test("external messenger connection caches cannot grow with remote IDs", async () => {
    const whatsapp = await readFile(
      new URL("../../novaclaw/src/messenger/whatsapp-baileys-socket.ts", import.meta.url),
      "utf8",
    )
    const discord = await readFile(new URL("../src/messenger/driver/discord.ts", import.meta.url), "utf8")
    const email = await readFile(new URL("../src/messenger/driver/email.ts", import.meta.url), "utf8")
    expect(whatsapp).toContain("makeInboundInbox<WAMessage>(INBOUND_INBOX_CAPACITY")
    expect(whatsapp).toContain("makeBoundedMap<string, ChatSnapshot>(4096)")
    expect(whatsapp).not.toContain("buffer.push(normalized)")
    expect(discord).toContain("makeBoundedMap<string, ChannelMeta>(4096)")
    expect(discord).toContain("makeBoundedMap<string, string>(4096)")
    expect(email).toContain("makeBoundedMap<string, ThreadState>(4096)")

    const cache = makeBoundedMap<string, number>(2)
    cache.set("oldest", 1)
    cache.set("next", 2)
    cache.set("oldest", 3)
    cache.set("newest", 4)
    expect(cache.size).toBe(2)
    expect([...cache.keys()]).toEqual(["next", "newest"])
    expect(cache.get("oldest")).toBeUndefined()
  })

  test("a full queue parks its producer until the consumer takes an event", () =>
    Effect.gen(function* () {
      const queue = yield* makeBoundedInboundQueue<string>(1)
      const completed = yield* Deferred.make<boolean>()
      yield* Queue.offer(queue, "first")
      const producer = yield* Queue.offer(queue, "second").pipe(
        Effect.tap((accepted) => Deferred.succeed(completed, accepted)),
        Effect.forkChild,
      )

      expect(Option.isNone(yield* Deferred.await(completed).pipe(Effect.timeoutOption(Duration.millis(5))))).toBe(true)
      expect(yield* Queue.take(queue)).toBe("first")
      expect(yield* Fiber.join(producer)).toBe(true)
      expect(yield* Queue.take(queue)).toBe("second")
    }).pipe(Effect.scoped, Effect.runPromise),
  )

  test("a callback stops offering and reports only once after queue overflow", () => {
    const offered: string[] = []
    let reports = 0
    const handle = createOverflowTerminatingHandler(
      (value: string) => {
        offered.push(value)
        return value !== "overflow"
      },
      () => {
        reports++
      },
    )

    handle("accepted")
    handle("overflow")
    handle("later")
    handle("later-again")

    expect(offered).toEqual(["accepted", "overflow"])
    expect(reports).toBe(1)
  })

  test("overflow fails a full callback queue after its buffered event drains", () =>
    Effect.gen(function* () {
      const queue = yield* makeBoundedInboundQueue<string, Error>(1)
      const overflow = new Error("queue overflow")
      const handle = createOverflowTerminatingHandler(
        (value: string) => Queue.offerUnsafe(queue, value),
        () => {
          Effect.runFork(Queue.fail(queue, overflow))
        },
      )

      handle("buffered")
      handle("overflow")
      handle("ignored")
      yield* Effect.yieldNow

      expect(yield* Queue.take(queue)).toBe("buffered")
      expect(yield* Queue.take(queue).pipe(Effect.flip)).toBe(overflow)
    }).pipe(Effect.scoped, Effect.runPromise),
  )
})
