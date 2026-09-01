import { describe, expect, test } from "bun:test"
import { createSubscriptions } from "./subscriptions"

describe("renderer subscriptions", () => {
  test("replaces the previous renderer subscription on reload", () => {
    const subscriptions = createSubscriptions()
    const disposed: string[] = []

    subscriptions.set(1, () => disposed.push("first"))
    subscriptions.set(1, () => disposed.push("second"))

    expect(disposed).toEqual(["first"])
    subscriptions.delete(1)
    expect(disposed).toEqual(["first", "second"])
  })
})
