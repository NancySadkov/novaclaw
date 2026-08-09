import { expect, test } from "bun:test"
import { keepEqualRows, startPendingPoll } from "./pending-poll"

test("an unchanged empty result preserves signal identity instead of rearming the effect", () => {
  const current: string[] = []
  expect(keepEqualRows(current, [], (a, b) => a === b)).toBe(current)
  expect(keepEqualRows(current, ["queued"], (a, b) => a === b)).toEqual(["queued"])
})

test("an idle paused session still reads its durable pending input once", async () => {
  const updates: string[][] = []
  let scheduled = false
  const stop = startPendingPoll({
    repeat: false,
    fetch: async () => ["accepted but unpromoted"],
    update: (rows) => updates.push([...rows]),
    every: () => {
      scheduled = true
      return () => undefined
    },
  })
  await Promise.resolve()

  expect(updates).toEqual([["accepted but unpromoted"]])
  expect(scheduled).toBe(false)
  stop()
})

test("a working session keeps reading until cleanup", async () => {
  let reads = 0
  let scheduled: (() => void) | undefined
  let cancelled = false
  const stop = startPendingPoll({
    repeat: true,
    fetch: async () => [String(++reads)],
    update: () => undefined,
    every: (tick) => {
      scheduled = tick
      return () => {
        cancelled = true
      }
    },
  })
  await Promise.resolve()
  scheduled?.()
  await Promise.resolve()
  expect(reads).toBe(2)

  stop()
  expect(cancelled).toBe(true)
})
