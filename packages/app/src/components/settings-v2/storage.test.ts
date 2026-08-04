import { describe, expect, test } from "bun:test"
import fs from "node:fs"

import { STORAGE_ENTRIES } from "./storage"
import { dict as en } from "@/i18n/en"

const storageSource = fs.readFileSync(new URL("./storage.tsx", import.meta.url), "utf8")
const serversSource = fs.readFileSync(new URL("./servers.tsx", import.meta.url), "utf8")
const dialogSource = fs.readFileSync(new URL("./dialog-settings-v2.tsx", import.meta.url), "utf8")

// The Storage tab lists WHERE an instance keeps its files (owner ask 2026-07-27). Two things are easy to
// get silently wrong and neither shows up as a crash, so they are asserted here rather than by driving
// the settings dialog: the Normal-vs-Developer split, and a row whose label is a missing i18n key
// (which renders as the raw key — visible nonsense, not an error).

describe("Storage tab entries", () => {
  test("the locations a user needs to back up or move an instance are visible at Normal", () => {
    const normal = STORAGE_ENTRIES.filter((e) => e.level === undefined).map((e) => e.key)
    // The database above all: "which file do I copy?" is the question this tab exists to answer.
    expect(normal).toContain("db")
    expect(normal).toContain("config")
    expect(normal).toContain("data")
    expect(normal).toContain("scratchDir")
    expect(normal).toContain("log")
  })

  test("internal plumbing is Developer-only", () => {
    const developer = STORAGE_ENTRIES.filter((e) => e.level === "developer").map((e) => e.key)
    expect(developer.sort()).toEqual(["cache", "state", "tmp"])
  })

  test("every entry has both i18n keys, so no row can render a raw key as its label", () => {
    const missing: string[] = []
    for (const entry of STORAGE_ENTRIES) {
      for (const suffix of ["", ".description"]) {
        const key = `settings.storage.${entry.i18n}${suffix}`
        if (!(key in (en as Record<string, string>))) missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })

  test("the tab's own chrome and both actions are translated", () => {
    // `in`, not toHaveProperty: these are FLAT keys containing dots, and toHaveProperty would read a
    // dotted string as a nested path and report every one of them missing.
    const dict = en as Record<string, string>
    const missing = [
      "settings.tab.storage",
      "settings.storage.title",
      "settings.storage.description",
      "settings.storage.locations.title",
      "settings.storage.locations.description",
      "settings.storage.copy",
      "settings.storage.open",
      "settings.storage.copied",
      "settings.storage.copyFailed",
      "settings.storage.openFailed",
      "settings.storage.instanceHome",
      "settings.storage.instanceHome.description",
    ].filter((key) => !(key in dict))
    expect(missing).toEqual([])
  })

  test("keys are unique and none is listed twice", () => {
    const keys = STORAGE_ENTRIES.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("Storage is a normal Safety tab and owns the live resource panel", () => {
    expect(dialogSource).not.toContain('storage: "advanced"')
    expect(storageSource).toContain("<InstanceResources />")
    expect(serversSource).not.toContain("<InstanceResources />")
  })
})
