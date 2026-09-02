import { describe, expect, test } from "bun:test"
import { bypassesGuard, hasEnoughFreeMemory, heavyJobLabels } from "./heavy-guard"

describe("heavy job classification", () => {
  test("treats a managed llama.cpp server as incompatible with the test suite", () => {
    expect(
      heavyJobLabels(
        "llama-server.exe",
        'llama-server.exe --model "Qwen3.5-4B-Q4_K_M.gguf" --ctx-size 65536 --port 11343',
      ),
    ).toEqual(["a local llama.cpp model server"])
  })

  test("does not mistake a diagnostic PowerShell query for the heavy job it mentions", () => {
    expect(
      heavyJobLabels(
        "powershell.exe",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'llama-server|tsgo' }",
      ),
    ).toEqual([])
  })

  test("keeps typechecks and release builds mutually exclusive with tests", () => {
    expect(heavyJobLabels("tsgo.exe", "tsgo --noEmit -p tsconfig.json")).toEqual(["a typecheck (tsgo)"])
    expect(heavyJobLabels("app-builder.exe", "app-builder electron-builder package")).toContain(
      "an electron-builder package step",
    )
  })

  test("the test runner cannot bypass the guard with force or CI environment flags", () => {
    const environment = { NOVACLAW_SKIP_HEAVY_GUARD: "1", CI: "true" }
    expect(bypassesGuard(["bun", "test", "--force"], environment, { allowOverride: false })).toBe(false)
    expect(bypassesGuard(["bun", "build", "--force"], {}, { allowOverride: true })).toBe(true)
  })

  test("refuses a heavy job before immediately available RAM falls into the paging danger zone", () => {
    expect(hasEnoughFreeMemory(6 * 1024 ** 3 - 1)).toBe(false)
    expect(hasEnoughFreeMemory(6 * 1024 ** 3)).toBe(true)
    expect(hasEnoughFreeMemory(2.5 * 1024 ** 3 - 1, 2.5 * 1024 ** 3)).toBe(false)
    expect(hasEnoughFreeMemory(2.5 * 1024 ** 3, 2.5 * 1024 ** 3)).toBe(true)
  })
})

/**
 * ─── the gate refusing ITSELF (2026-09-02) ─────────────────────────────────────────────────────
 *
 * Found by running the concurrent gate, not by reading the classifier: with `desktop` in flight the
 * next admission printed *"Refusing to start test unit app:browser: another heavy job is already
 * running... Found: an electron-builder package step"* and exited 2. There was no build. The
 * "electron-builder" it found was a TEST FILE NAME in its own sibling's command line.
 */
describe("a run unit is not a heavy job", () => {
  test("🔴 `desktop`'s own argv names electron-builder.config.test.ts and must not read as a build", () => {
    const cmd = String.raw`"C:\Users\x\bun.exe" test src electron-builder.config.test.ts scripts --timeout=15000`
    expect(heavyJobLabels("bun.exe", cmd)).toEqual([])
  })

  test("a real electron-builder step is still caught", () => {
    expect(heavyJobLabels("node.exe", "node ./node_modules/electron-builder/cli.js --win")).toContain(
      "an electron-builder package step",
    )
    expect(heavyJobLabels("app-builder.exe", "app-builder.exe blockmap")).not.toEqual([])
  })

  test("🔴 a rival RUNNER is still caught — it is `bun script/test.ts`, never `bun test`", () => {
    // This is what makes the exclusion honest: it narrows onto a string that was never a job.
    expect(heavyJobLabels("bun.exe", "bun script/test.ts --full")).toContain("another test suite run")
    expect(heavyJobLabels("bun.exe", "bun run test")).toEqual([])
  })
})
