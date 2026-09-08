import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const main = readFileSync(new URL("./windows.ts", import.meta.url), "utf8")
const preload = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8")

test("the preload proves bridge readiness after exposure", () => {
  expect(preload.indexOf('contextBridge.exposeInMainWorld("api", api)')).toBeGreaterThan(-1)
  expect(preload.indexOf('ipcRenderer.send("preload-ready")')).toBeGreaterThan(
    preload.indexOf('contextBridge.exposeInMainWorld("api", api)'),
  )
})

test("the main process bounds a silent preload and clears the watchdog on readiness", () => {
  expect(main).toContain("PRELOAD_READY_TIMEOUT_MS = 15_000")
  expect(main).toContain('channel === "preload-ready"')
  expect(main).toContain("win.once(\"closed\", clearPreloadWatchdog)")
  expect(main).toContain("The privileged preload bridge did not initialize within 15 seconds.")
})
