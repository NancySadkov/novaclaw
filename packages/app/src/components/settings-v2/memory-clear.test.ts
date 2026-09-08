import { describe, expect, test } from "bun:test"
import { runBackedUpMemoryErase } from "./memory-clear"

describe("backup-before-erase ordering", () => {
  test("does not begin deletion when a later backup page fails", async () => {
    let backupStarted = false
    let eraseStarted = false
    const failure = new Error("backup page two failed")

    await expect(
      runBackedUpMemoryErase({
        collect: async () => {
          // Page one was read, but a complete bundle was never produced.
          await Promise.resolve("page one")
          throw failure
        },
        beginBackup: () => {
          backupStarted = true
        },
        erase: async () => {
          eraseStarted = true
          return 1
        },
      }),
    ).rejects.toBe(failure)
    expect(backupStarted).toBe(false)
    expect(eraseStarted).toBe(false)
  })

  test("does not begin deletion when the browser cannot initiate the promised backup", async () => {
    let eraseStarted = false
    const failure = new Error("download could not start")

    await expect(
      runBackedUpMemoryErase({
        collect: async () => "complete restorable bundle",
        beginBackup: () => {
          throw failure
        },
        erase: async () => {
          eraseStarted = true
          return 1
        },
      }),
    ).rejects.toBe(failure)
    expect(eraseStarted).toBe(false)
  })

  test("returns the exact erase count only after a complete bundle was offered", async () => {
    const order: string[] = []
    const result = await runBackedUpMemoryErase({
      collect: async () => {
        order.push("complete bundle")
        return "complete restorable bundle"
      },
      beginBackup: () => order.push("download started"),
      erase: async () => {
        order.push("erase")
        return 2_743
      },
    })

    expect(order).toEqual(["complete bundle", "download started", "erase"])
    expect(result).toEqual({ erased: 2_743, backupStarted: true })
  })
})
