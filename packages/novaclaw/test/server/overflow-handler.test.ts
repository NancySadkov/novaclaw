import { describe, expect, test } from "bun:test"
import { createOverflowTerminatingHandler } from "../../src/server/routes/instance/httpapi/handlers/overflow-handler"

describe("createOverflowTerminatingHandler", () => {
  test("stops offering events and reports only once after overflow", () => {
    const offered: string[] = []
    let reports = 0
    const handle = createOverflowTerminatingHandler(
      (event: string) => {
        offered.push(event)
        return event !== "overflow"
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
})
