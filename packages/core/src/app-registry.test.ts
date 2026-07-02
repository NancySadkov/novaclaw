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
      expect(() =>
        AppRegistry.normalize({ id, title: "T", open: { type: "route", value: "/x" } }, opts()),
      ).toThrow()
    }
    // An EMPTY id is not invalid — it means "derive from the title".
    const m = AppRegistry.normalize({ id: "", title: "My App", open: { type: "route", value: "/x" } }, opts())
    expect(m.id).toBe("my-app")
  })

  test("rejects reserved built-in ids", () => {
    expect(() =>
      AppRegistry.normalize({ id: "settings", title: "T", open: { type: "route", value: "/x" } }, opts()),
    ).toThrow(/reserved/)
  })

  test("validates open specs by type", () => {
    expect(() =>
      AppRegistry.normalize({ title: "T", open: { type: "url", value: "javascript:alert(1)" } }, opts()),
    ).toThrow(/http/)
    expect(() => AppRegistry.normalize({ title: "T", open: { type: "route", value: "x" } }, opts())).toThrow(/\//)
    expect(() =>
      AppRegistry.normalize({ title: "T", open: { type: "nope" as never, value: "x" } }, opts()),
    ).toThrow()
    expect(() => AppRegistry.normalize({ title: "T", open: { type: "prompt", value: "  " } }, opts())).toThrow(
      /empty/,
    )
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
    const first = await AppRegistry.saveApp({ id: "x", title: "One", open: { type: "route", value: "/a" } }, opts())
    const second = await AppRegistry.saveApp(
      { id: "x", title: "Two", open: { type: "route", value: "/b" } },
      { root, now: () => new Date(1_800_000_000_000) },
    )
    expect(second.title).toBe("Two")
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBe(1_800_000_000_000)
    expect(await AppRegistry.listApps(opts())).toHaveLength(1)
  })

  test("remove deletes the manifest and reports existence", async () => {
    await AppRegistry.saveApp({ id: "gone", title: "Gone", open: { type: "route", value: "/g" } }, opts())
    expect(await AppRegistry.removeApp("gone", opts())).toBe(true)
    expect(await AppRegistry.removeApp("gone", opts())).toBe(false)
    expect(await AppRegistry.listApps(opts())).toHaveLength(0)
  })

  test("list skips torn/corrupt files", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "bad.json"), "{ not json", "utf8")
    await AppRegistry.saveApp({ id: "ok", title: "Ok", open: { type: "route", value: "/ok" } }, opts())
    const listed = await AppRegistry.listApps(opts())
    expect(listed.map((m) => m.id)).toEqual(["ok"])
  })
})
