import { expect, test } from "bun:test"
import { createDesktopLifecycle, type DesktopLifecyclePorts } from "./lifecycle"

const credentials = { url: "http://127.0.0.1:1234", username: "novaclaw", password: "fixture" }
const fixture = (overrides: Partial<DesktopLifecyclePorts> = {}) => {
  const events: string[] = []
  const ready = Promise.withResolvers<void>()
  const started = Promise.withResolvers<{ credentials: typeof credentials; healthy: Promise<void> }>()
  const health = Promise.withResolvers<void>()
  const failures: unknown[] = []
  const lifecycle = createDesktopLifecycle({
    electronReady: () => ready.promise,
    openWindow: () => {
      events.push("window")
    },
    local: {
      start: async () => {
        events.push("start")
        return started.promise
      },
      stop: async () => {
        events.push("local-stop")
      },
    },
    instances: [],
    afterCredentials: () => {
      events.push("credentials")
    },
    failure: (error, stage) => {
      failures.push(error)
      events.push(stage + "-failed")
    },
    ...overrides,
  })
  return { lifecycle, events, ready, started, health, failures }
}
const advance = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

test("one run opens the window before starting the instance and publishes credentials once", async () => {
  const f = fixture()
  const run = f.lifecycle.run()
  expect(f.lifecycle.run()).toBe(run)
  expect(f.events).toEqual([])
  f.ready.resolve()
  await advance()
  expect(f.events).toEqual(["window", "start"])
  expect(f.lifecycle.phase()).toBe("window-open")
  f.started.resolve({ credentials, healthy: f.health.promise })
  expect(await f.lifecycle.awaitInitialization()).toEqual(credentials)
  expect(f.events.filter((x) => x === "credentials")).toHaveLength(1)
  f.health.resolve()
  await run
  expect(f.lifecycle.phase()).toBe("sidecar-healthy")
})

test("a startup failure settles renderer initialization even when IPC subscribes afterwards", async () => {
  const f = fixture()
  const run = f.lifecycle.run()
  f.ready.resolve()
  await advance()
  const error = new Error("startup failed")
  f.started.reject(error)
  await run
  await expect(f.lifecycle.awaitInitialization()).rejects.toBe(error)
  expect(f.failures).toEqual([error])
  expect(f.lifecycle.phase()).toBe("failed")
})

test("quit closes boot before Electron readiness and stops all owners under one cleared deadline", async () => {
  const calls: string[] = []
  const first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>()
  let scheduled = 0,
    cancelled = 0
  const f = fixture({
    local: {
      start: async () => {
        throw new Error("must not start")
      },
      stop: () => {
        calls.push("local")
        return first.promise
      },
    },
    instances: [
      {
        stop: () => {
          calls.push("wsl")
          return second.promise
        },
      },
    ],
    deadline: {
      schedule: () => {
        scheduled++
        return 1
      },
      cancel: () => {
        cancelled++
      },
    },
  })
  const run = f.lifecycle.run()
  const quit = f.lifecycle.quit()
  expect(f.lifecycle.quit()).toBe(quit)
  expect(calls).toEqual(["local", "wsl"])
  f.ready.resolve()
  await run
  expect(f.events).toEqual([])
  first.resolve()
  await advance()
  expect(f.lifecycle.phase()).toBe("quitting")
  second.resolve()
  expect(await quit).toEqual({ outcome: "settled", failures: [] })
  expect(scheduled).toBe(1)
  expect(cancelled).toBe(1)
  expect(f.lifecycle.phase()).toBe("stopped")
  await expect(f.lifecycle.awaitInitialization()).rejects.toThrow("shutting down")
})

test("late sidecar credentials and health cannot reopen a quitting lifecycle", async () => {
  const f = fixture()
  const run = f.lifecycle.run()
  f.ready.resolve()
  await advance()
  await f.lifecycle.quit()
  f.started.resolve({ credentials, healthy: Promise.reject(new Error("child stopped during health")) })
  await run
  await expect(f.lifecycle.awaitInitialization()).rejects.toThrow("shutting down")
  expect(f.events).not.toContain("credentials")
  expect(f.lifecycle.phase()).toBe("stopped")
})

test("one deadline bounds a hung owner and a throwing owner cannot skip its siblings", async () => {
  const calls: string[] = []
  let fire!: () => void
  const error = new Error("stop failed")
  const f = fixture({
    local: {
      start: async () => {
        throw error
      },
      stop: () => {
        calls.push("local")
        throw error
      },
    },
    instances: [
      {
        stop: () => {
          calls.push("wsl")
          return new Promise(() => {})
        },
      },
    ],
    deadline: {
      schedule: (callback) => {
        fire = callback
        return 1
      },
      cancel: () => {},
    },
  })
  const quit = f.lifecycle.quit()
  expect(calls).toEqual(["local", "wsl"])
  fire()
  expect(await quit).toEqual({ outcome: "forced", failures: [error] })
  expect(f.lifecycle.phase()).toBe("stopped")
})
