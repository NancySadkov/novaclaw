import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createReviewNavigation, reviewDiffID } from "./review-navigation"

test("review diff anchors are stable, path-specific, and namespaced", () => {
  const first = reviewDiffID("src/first.ts")
  expect(first).toBe(reviewDiffID("src/first.ts"))
  expect(first).toStartWith("session-review-diff-")
  expect(first).not.toBe(reviewDiffID("src/second.ts"))
})

test("focusing a diff opens the review surface and records both focused and pending paths", () => {
  const calls: string[] = []
  createRoot((dispose) => {
    const navigation = createReviewNavigation({
      root: () => undefined,
      pending: () => undefined,
      ready: () => false,
      setPending: (path) => calls.push(`pending:${path}`),
      setFocused: (path) => calls.push(`focused:${path}`),
      openPanel: () => calls.push("panel"),
      openPath: (path) => calls.push(`open:${path}`),
      saveScroll: () => {},
    })
    navigation.focus("src/app.ts")
    dispose()
  })

  expect(calls).toEqual(["panel", "open:src/app.ts", "focused:src/app.ts", "pending:src/app.ts"])
})
