import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { createSaveFileAuthorizations, parseSavePickerOptions } from "./save-picker"

describe("save file authorizations", () => {
  test("writes exactly the selected path once and leaves another path untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "novaclaw-save-picker-"))
    const selected = join(directory, "selected.json")
    const other = join(directory, "other.json")
    try {
      await writeFile(other, "sentinel")
      const authorizations = createSaveFileAuthorizations()
      const token = authorizations.add(1, selected)

      await authorizations.write(1, token, "saved")

      expect(await readFile(selected, "utf8")).toBe("saved")
      expect(await readFile(other, "utf8")).toBe("sentinel")
      await expect(authorizations.write(1, token, "replay")).rejects.toThrow("not selected")
      expect(await readFile(selected, "utf8")).toBe("saved")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("another sender is refused without consuming the owner's token", async () => {
    const writes: Array<readonly [string, string]> = []
    const authorizations = createSaveFileAuthorizations(async (path, content) => {
      writes.push([path, content])
    })
    const token = authorizations.add(11, "owner.json")

    await expect(authorizations.write(12, token, "stolen")).rejects.toThrow("this window")
    await authorizations.write(11, token, "owned")

    expect(writes).toEqual([["owner.json", "owned"]])
  })

  test("a call without a picker-issued token is refused", async () => {
    const authorizations = createSaveFileAuthorizations(async () => undefined)
    await expect(authorizations.write(1, "invented-token", "content")).rejects.toThrow("not selected")
  })

  test("oversized UTF-8 content is refused before the writer and burns the one-shot token", async () => {
    let writes = 0
    const authorizations = createSaveFileAuthorizations(async () => {
      writes += 1
    }, 5)
    const token = authorizations.add(1, "selected.json")

    // Two characters, six UTF-8 bytes: the bound is on bytes written, not JavaScript code units.
    await expect(authorizations.write(1, token, "€€")).rejects.toThrow("limit")
    expect(writes).toBe(0)
    await expect(authorizations.write(1, token, "ok")).rejects.toThrow("not selected")
  })

  test("IPC values are type-checked at runtime and an invalid payload cannot be retried", async () => {
    const authorizations = createSaveFileAuthorizations(async () => undefined)
    await expect(authorizations.write(1, 42, "content")).rejects.toThrow("token must be a string")

    const token = authorizations.add(1, "selected.json")
    await expect(authorizations.write(1, token, new Uint8Array())).rejects.toThrow("content must be a string")
    await expect(authorizations.write(1, token, "retry")).rejects.toThrow("not selected")
  })

  test("closing one renderer releases only its pending save capabilities", async () => {
    const writes: string[] = []
    const authorizations = createSaveFileAuthorizations(async (path) => {
      writes.push(path)
    })
    const first = authorizations.add(1, "first.json")
    const second = authorizations.add(2, "second.json")

    authorizations.releaseSender(1)

    await expect(authorizations.write(1, first, "first")).rejects.toThrow("not selected")
    await authorizations.write(2, second, "second")
    expect(writes).toEqual(["second.json"])
  })
})

describe("save picker request validation", () => {
  test("accepts the closed picker option shape", () => {
    expect(parseSavePickerOptions(undefined)).toEqual({})
    expect(parseSavePickerOptions({ title: "Export", defaultPath: "settings.json" })).toEqual({
      title: "Export",
      defaultPath: "settings.json",
    })
  })

  test("rejects malformed values and undeclared fields", () => {
    for (const value of [null, [], "settings.json", { title: 42 }, { defaultPath: false }, { path: "x" }])
      expect(() => parseSavePickerOptions(value)).toThrow()
  })
})

describe("renderer save bridge", () => {
  const main = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8")
  const preload = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8")
  const types = readFileSync(new URL("../preload/types.ts", import.meta.url), "utf8")

  test("does not expose generic filesystem read or write channels", () => {
    for (const source of [main, preload, types]) {
      expect(source).not.toContain('"read-file"')
      expect(source).not.toContain('"write-file"')
      expect(source).not.toMatch(/\breadFile\s*:/)
      expect(source).not.toMatch(/\bwriteFile\s*:/)
    }
  })

  test("the only renderer write carries token and content to the sender-bound authorizer", () => {
    expect(preload).toContain('ipcRenderer.invoke("write-picked-file", token, content)')
    expect(main).toContain('ipcMain.handle("write-picked-file"')
    expect(main).toContain("token: unknown, content: unknown")
    expect(main).toContain("pickedSaves.write(event.sender.id, token, content)")
    expect(types).toContain("writePickedFile: (token: string, content: string) => Promise<void>")
  })
})
