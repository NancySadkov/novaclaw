import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppRegistry } from "./app-registry"

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-apps-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const opts = () => ({ root, now: () => new Date(1_700_000_000_000) })

describe("AppRegistry.normalize", () => {
  test("derives the id from the title when omitted", () => {
    const m = AppRegistry.normalize({ title: "Stock Prices", open: { type: "url", value: "https://x.test" } }, opts())
    expect(m.id).toBe("stock-prices")
  })

  test("rejects traversal-shaped and invalid ids", () => {
    for (const id of ["../evil", "a/b", "UPPER", ".hidden"]) {
      expect(() => AppRegistry.normalize({ id, title: "T", open: { type: "route", value: "files" } }, opts())).toThrow()
    }
    // An EMPTY id is not invalid — it means "derive from the title".
    const m = AppRegistry.normalize({ id: "", title: "My App", open: { type: "route", value: "files" } }, opts())
    expect(m.id).toBe("my-app")
  })

  test("rejects reserved built-in ids", () => {
    expect(() =>
      AppRegistry.normalize({ id: "settings", title: "T", open: { type: "route", value: "files" } }, opts()),
    ).toThrow(/reserved/)
  })

  test("validates open specs by type", () => {
    expect(() =>
      AppRegistry.normalize({ title: "T", open: { type: "url", value: "javascript:alert(1)" } }, opts()),
    ).toThrow(/http/)
    expect(() => AppRegistry.normalize({ title: "T", open: { type: "route", value: "/files" } }, opts())).toThrow(
      /Unknown app route id.*contacts.*files/,
    )
    expect(AppRegistry.normalize({ title: "T", open: { type: "route", value: "files" } }, opts()).open).toEqual({
      type: "route",
      value: "files",
    })
    expect(() => AppRegistry.normalize({ title: "T", open: { type: "nope" as never, value: "x" } }, opts())).toThrow()
    expect(() => AppRegistry.normalize({ title: "T", open: { type: "prompt", value: "  " } }, opts())).toThrow(/empty/)
  })
})

describe("AppRegistry save/list/remove", () => {
  test("save -> list round-trip", async () => {
    await AppRegistry.saveApp({ title: "Stock Prices", open: { type: "prompt", value: "Show stocks" } }, opts())
    const listed = await AppRegistry.listApps(opts())
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe("stock-prices")
    expect(listed[0].open).toEqual({ type: "prompt", value: "Show stocks" })
  })

  test("save with an existing id updates but keeps createdAt", async () => {
    const first = await AppRegistry.saveApp({ id: "x", title: "One", open: { type: "route", value: "notes" } }, opts())
    const second = await AppRegistry.saveApp(
      { id: "x", title: "Two", open: { type: "route", value: "files" } },
      { root, now: () => new Date(1_800_000_000_000) },
    )
    expect(second.title).toBe("Two")
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBe(1_800_000_000_000)
    expect(await AppRegistry.listApps(opts())).toHaveLength(1)
  })

  test("remove deletes the manifest and reports existence", async () => {
    await AppRegistry.saveApp({ id: "gone", title: "Gone", open: { type: "route", value: "notes" } }, opts())
    expect(await AppRegistry.removeApp("gone", opts())).toBe(true)
    expect(await AppRegistry.removeApp("gone", opts())).toBe(false)
    expect(await AppRegistry.listApps(opts())).toHaveLength(0)
  })

  test("list skips torn/corrupt files", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "bad.json"), "{ not json", "utf8")
    await AppRegistry.saveApp({ id: "ok", title: "Ok", open: { type: "route", value: "notes" } }, opts())
    const listed = await AppRegistry.listApps(opts())
    expect(listed.map((m) => m.id)).toEqual(["ok"])
  })

  test("a corrupt manifest is never replaced by a partial update", async () => {
    await fs.mkdir(root, { recursive: true })
    const file = path.join(root, "broken.json")
    await fs.writeFile(file, "{ not json", "utf8")
    await expect(
      AppRegistry.saveApp({ id: "broken", title: "Replacement", open: { type: "route", value: "notes" } }, opts()),
    ).rejects.toThrow("unreadable and was not overwritten")
    expect(await fs.readFile(file, "utf8")).toBe("{ not json")
  })

  test("an unknown route id performs no write and offers the available ids", async () => {
    await expect(
      AppRegistry.saveApp({ id: "stocks", title: "Stocks", open: { type: "route", value: "stocks" } }, opts()),
    ).rejects.toThrow(/Unknown app route id "stocks".*contacts.*files/)
    expect(await fs.readdir(root)).toEqual([])
  })

  test("list skips a persisted free-form route from the retired contract", async () => {
    await fs.writeFile(
      path.join(root, "old.json"),
      JSON.stringify({
        id: "old",
        title: "Old",
        open: { type: "route", value: "/stocks" },
        createdAt: 1,
        updatedAt: 1,
      }),
      "utf8",
    )
    await AppRegistry.saveApp({ id: "current", title: "Current", open: { type: "route", value: "files" } }, opts())
    expect((await AppRegistry.listApps(opts())).map((manifest) => manifest.id)).toEqual(["current"])
  })
})
