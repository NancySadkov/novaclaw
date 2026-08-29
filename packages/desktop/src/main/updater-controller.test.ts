import { describe, expect, test } from "bun:test"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"

function setup(input?: {
  currentVersion?: string
  ready?: UpdaterReadyRecord
  networkPolicy?: () => Promise<{ allowed: true } | { allowed: false; reason: "airgap" | "policy-unavailable" }>
}) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    networkPolicy: input?.networkPolicy ?? (async () => ({ allowed: true })),
    stop: async () => {
      calls.push("stop")
    },
  })
  return { controller, calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("automatic startup refuses explicit airgap before check or download", async () => {
    const app = setup({ networkPolicy: async () => ({ allowed: false, reason: "airgap" }) })

    await app.controller.start()

    expect(app.calls).toEqual([])
    expect(app.controller.getState()).toEqual({ status: "blocked", reason: "airgap" })
  })

  test("manual checks refuse unknown policy before check or download", async () => {
    const app = setup({ networkPolicy: async () => ({ allowed: false, reason: "policy-unavailable" }) })

    await app.controller.check()

    expect(app.calls).toEqual([])
    expect(app.controller.getState()).toEqual({ status: "blocked", reason: "policy-unavailable" })
  })

  test("re-evaluates policy on every attempt so a refused check can recover", async () => {
    let allowed = false
    const app = setup({
      networkPolicy: async () => (allowed ? { allowed: true } : { allowed: false, reason: "airgap" }),
    })

    await app.controller.check()
    allowed = true
    await app.controller.check()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("re-checks the gate before download when policy changes during the update check", async () => {
    let policyRead = 0
    const app = setup({
      networkPolicy: async () =>
        ++policyRead === 1 ? { allowed: true } : { allowed: false, reason: "airgap" },
    })

    await app.controller.check()

    expect(app.calls).toEqual(["check"])
    expect(app.controller.getState()).toEqual({ status: "blocked", reason: "airgap" })
  })

  test("returns to ready when quitAndInstall returns without exiting", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      networkPolicy: async () => ({ allowed: true }),
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await failed.start()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})
