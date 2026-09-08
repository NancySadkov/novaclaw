import { expect, test } from "bun:test"
import { preloadFailureRecovery } from "./preload-recovery"

test("a failed preload produces a native-startup recovery message", () => {
  expect(
    preloadFailureRecovery({
      window: "main",
      preloadPath: "C:\\NovaClaw\\preload.js",
      error: new Error("bridge initialization failed"),
    }),
  ).toEqual({
    message: "NovaClaw could not start",
    detail: "Window: main\nPreload: C:\\NovaClaw\\preload.js\nError: bridge initialization failed",
  })
})

test("non-Error preload failures are still named for recovery", () => {
  expect(preloadFailureRecovery({ window: "main", preloadPath: "preload.js", error: "missing module" }).detail).toContain(
    "Error: missing module",
  )
})
