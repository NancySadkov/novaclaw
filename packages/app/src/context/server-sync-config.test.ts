import { describe, expect, test } from "bun:test"
import { settleConfigUpdate } from "./server-sync"

describe("config mutation settlement", () => {
  test("switches the accepted credential before any follow-up read", () => {
    const order: string[] = []

    settleConfigUpdate({ onAccepted: () => order.push("credential") }, () => order.push("refetch"))

    expect(order).toEqual(["credential", "refetch"])
  })

  test("a connection rebuild owns its bootstrap instead of refetching through the retired client", () => {
    const order: string[] = []

    settleConfigUpdate({ onAccepted: () => order.push("credential"), refetch: false }, () =>
      order.push("stale-refetch"),
    )

    expect(order).toEqual(["credential"])
  })
})
