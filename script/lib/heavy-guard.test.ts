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
