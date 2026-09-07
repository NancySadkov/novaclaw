import { expect, test } from "bun:test"
import { Writable } from "node:stream"
import * as ProtocolWrite from "../../src/session-worker/protocol-write"

test("an asynchronous EPIPE reaches the protocol failure handler", async () => {
  const failures: Error[] = []
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      queueMicrotask(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })))
    },
  })
  ProtocolWrite.observeErrors(stream, (error) => failures.push(error))
  ProtocolWrite.write(stream, "message\n", (error) => failures.push(error))

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(failures.length).toBeGreaterThan(0)
  expect(failures.every((error) => error.message === "broken pipe")).toBe(true)
})

test("a synchronous write failure reaches the same handler", () => {
  const failure = new Error("closed")
  const stream = {
    on() {
      return this
    },
    write() {
      throw failure
    },
  }
  let received: Error | undefined
  ProtocolWrite.write(stream as never, "message\n", (error) => {
    received = error
  })
  expect(received).toBe(failure)
})
