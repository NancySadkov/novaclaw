import { expect, test } from "bun:test"
import { createConfigRemover } from "./config-remove"

test("removing overrides filters absent keys and refreshes only after acceptance", async () => {
  const calls: unknown[] = []
  const remove = createConfigRemover({
    current: () => ({ strict: { verification: false }, computer: { display: ":99" } }),
    remove: async (paths) => {
      calls.push(paths)
    },
    refresh: async () => {
      calls.push("refresh")
    },
  })
  await remove([
    ["strict", "verification"],
    ["strict", "attempts"],
    ["computer", "display"],
  ])
  expect(calls).toEqual([
    [
      ["strict", "verification"],
      ["computer", "display"],
    ],
    "refresh",
  ])
  calls.length = 0
  await remove([["strict", "attempts"], []])
  expect(calls).toEqual([])
})

test("a refused delete rejects without refreshing stale state as a success", async () => {
  let refreshed = false
  const remove = createConfigRemover({
    current: () => ({ strict: { attempts: 3 } }),
    remove: async () => {
      throw new Error("instance restarting")
    },
    refresh: async () => {
      refreshed = true
    },
  })
  await expect(remove([["strict", "attempts"]])).rejects.toThrow("instance restarting")
  expect(refreshed).toBe(false)
})
