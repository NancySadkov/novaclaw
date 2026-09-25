import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundledModulePath, bundledToolFile, bundledToolRoot } from "./bundled-tool"

describe("bundled tool resolution", () => {
  test("an explicit env path is authoritative", () => {
    expect(bundledToolRoot("w64devkit", "C:/named/w64devkit", "C:/elsewhere/novaclaw.exe")).toBe("C:/named/w64devkit")
  })

  test("falls back to third-party beside the executable, then one level up", () => {
    const root = mkdtempSync(join(tmpdir(), "nc-tool-"))
    try {
      const beside = join(root, "app")
      const oneUp = join(root, "resources")
      mkdirSync(join(beside, "third-party", "w64devkit"), { recursive: true })
      mkdirSync(join(oneUp, "third-party", "imagemagick"), { recursive: true })

      expect(bundledToolRoot("w64devkit", undefined, join(beside, "novaclaw.exe"))).toBe(
        join(beside, "third-party", "w64devkit"),
      )
      expect(bundledToolRoot("imagemagick", undefined, join(oneUp, "server", "novaclaw.exe"))).toBe(
        join(oneUp, "third-party", "imagemagick"),
      )
      expect(bundledToolRoot("portable-git", undefined, join(beside, "novaclaw.exe"))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a file-shaped tool resolves inside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "nc-tool-"))
    try {
      mkdirSync(join(root, "third-party", "ripgrep"), { recursive: true })
      writeFileSync(join(root, "third-party", "ripgrep", "rg.exe"), "x")
      expect(bundledToolFile("ripgrep", "rg.exe", undefined, join(root, "novaclaw.exe"))).toBe(
        join(root, "third-party", "ripgrep", "rg.exe"),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a runtime-required node package resolves beside the executable", () => {
    const root = mkdtempSync(join(tmpdir(), "nc-tool-"))
    try {
      const specifier = "@ladybugdb/wasm-core/nodejs/sync"
      const pkg = join(root, "node_modules", "@ladybugdb", "wasm-core", "nodejs", "sync")
      mkdirSync(pkg, { recursive: true })
      expect(bundledModulePath(specifier, join(root, "novaclaw.exe"))).toBe(pkg)
      expect(bundledModulePath(specifier, join(root, "isolated", "deeper", "novaclaw.exe"))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
