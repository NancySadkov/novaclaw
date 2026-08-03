import { describe, expect, test } from "bun:test"
import { createFileTreeStore } from "./tree-store"

describe("file tree directory failures", () => {
  test("keeps an inline error and clears it before retrying", async () => {
    let fail = true
    const errors: string[] = []
    const tree = createFileTreeStore({
      scope: () => "server\0workspace",
      normalizeDir: (value) => value,
      list: async () => {
        if (fail) throw new Error("offline")
        return []
      },
      onError: (message) => errors.push(message),
    })

    await tree.listDir("")
    expect(tree.dirState("")?.error).toBe("offline")
    expect(tree.dirState("")?.loaded).not.toBe(true)
    expect(errors).toEqual(["offline"])

    fail = false
    await tree.listDir("", { force: true })
    expect(tree.dirState("")?.error).toBeUndefined()
    expect(tree.dirState("")?.loaded).toBe(true)
  })
})
