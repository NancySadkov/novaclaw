import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { createOverflowTerminatingHandler } from "../../src/server/routes/instance/httpapi/handlers/overflow-handler"

describe("createOverflowTerminatingHandler", () => {
  test("clears the stale queue, stops offering events, and reports only once after overflow", () => {
    const offered: string[] = []
    let reports = 0
    const queue = Effect.runSync(Queue.bounded<string>(1))
    const handle = createOverflowTerminatingHandler(
      queue,
      (event: string) => {
        offered.push(event)
        return Queue.offerUnsafe(queue, event)
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
    expect(Effect.runSync(Queue.size(queue))).toBe(0)
    expect(Queue.offerUnsafe(queue, "after-shutdown")).toBe(false)
  })
})
