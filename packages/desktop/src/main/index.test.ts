import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")
const entry = read("./index.ts")
const application = read("./application.ts")

test("the desktop entry composes the application without mutable lifecycle state", () => {
  expect(entry).toContain('import { runDesktop } from "./application"')
  expect(entry).toContain("runDesktop().catch")
  expect(entry).not.toMatch(/\b(?:let|var)\b/)
  expect(entry).not.toContain("superviseLocalServer")
})
test("the adapter delegates boot, window ordering and initialization to the tested lifecycle", () => {
  expect(application).toContain("createDesktopLifecycle({")
  expect(application).toContain("await lifecycle.run()")
  expect(application).toContain("openWindow: window.open")
  expect(application).toContain("awaitInitialization: lifecycle.awaitInitialization")
  expect(application).toContain("instances: [wsl]")
})
test("quit, relaunch, signals and recovery reach the same lifecycle deadline", () => {
  expect(application).toMatch(/lifecycle\s*\.quit\(\)\s*\.then/)
  expect(application).toMatch(/before-quit[\s\S]{0,120}preventDefault\(\)/)
  expect(application).toContain('for (const signal of ["SIGINT", "SIGTERM"]')
  expect(application).toContain("offerBootRecovery(failure, quit)")
  expect(read("./boot-recovery-host.ts")).not.toMatch(/app\.(?:exit|relaunch)\(/)
})
test("sidecar startup and login-shell probes belong to the local owner", () => {
  expect(application).toMatch(/spawn:[\s\S]{0,120}superviseLocalServer\(/)
  expect(application).toMatch(/prepare:[\s\S]{0,150}prepareLocalEnvironment\(/)
  expect(read("./local-instance.ts")).toContain("signal.throwIfAborted()")
  expect(application).toContain("subscribeSupervisorState: local.subscribe")
})
test("desktop has no maintenance scheduler and crash capture follows home selection", () => {
  expect(application.indexOf("prepareInstanceHome()")).toBeLessThan(application.indexOf("createDesktopDiagnostics()"))
  expect(read("./diagnostics.ts")).toContain('import("@novaclaw/core/observability/crash-capture")')
  expect(application).not.toMatch(/(?:checkForUpdates|downloadUpdate|setInterval)\(/)
})
