import { expect, test } from "bun:test"
import { clearWslDistroState, requireWslIpcString, wslServerIdToRestart, wslTerminalArgs } from "./policy"
import {
  expectNovaclawVersion,
  pendingRestartAfterWslInstall,
  pollWslHealth,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"

let persistedServers: WslServerConfig[] = []
let releaseNovaclawResolve: (() => void) | undefined

/**
 * Release the pending NovaClaw check.
 *
 * Called through a function rather than `releaseNovaclawResolve?.()` inline: the variable is only ever
 * assigned from inside a closure (the `new Promise` executor below), which TypeScript's control-flow
 * analysis cannot see, so after the `= undefined` at the top of each test it narrows the variable to
 * `undefined` and `?.()` becomes a call on `never`. Inside a function body the DECLARED type applies,
 * which is both correct and true to what happens at runtime.
 */
function releaseNovaclaw() {
  releaseNovaclawResolve?.()
}

test("starts every configured WSL server on initialization", () => {
  // Typed as WslServerConfig[] rather than passed as a bare literal: the helper declares the narrower
  // `{ id: string }[]` it actually reads, and a fresh literal carrying `distro` would trip the
  // excess-property check. Naming the real type is also what the caller in servers.ts:283 passes.
  const servers: WslServerConfig[] = [
    { id: "wsl:Debian", distro: "Debian" },
    { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
  ]
  expect(wslServerIdsToStartOnInitialize(servers)).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the desktop version", () => {
  expect(() => expectNovaclawVersion("1.16.2", "1.16.2")).not.toThrow()
  expect(() => expectNovaclawVersion("1.14.35", "1.16.2")).toThrow(
    "NovaClaw update finished but Debian still reports 1.14.35; expected 1.16.2",
  )
})

test("restarts an existing distro server after updating NovaClaw", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      { Debian: { name: "Debian", canExecute: true, hasBash: true, hasCurl: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.novaclaw/bin/novaclaw",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesDesktop: true,
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, novaclawChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
})

test("stops health polling when sidecar startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollWslHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

/**
 * 🔴 NC-REL-001 — quit is advertised and implemented as a bounded wait over `stopSidecars()`, but
 * `stopAll` was synchronous and its listener contract was `stop: () => void`. So the wait covered the
 * local sidecar and nothing else: the app could exit while a configured distro's server was still
 * mid-write.
 *
 * A/B: drop the `await Promise.allSettled(stopping)` and this resolves with `stopped` still false.
 */
test("🔴 stopAll AWAITS every distro's stop, so quit can actually wait for them", async () => {
  persistedServers = []
  releaseNovaclawResolve = undefined
  let stopped = false
  let release: () => void = () => {}
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () =>
          new Promise<void>((resolve) => {
            release = () => {
              stopped = true
              resolve()
            }
          }),
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "novaclaw",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.addServer("Debian")
  await waitFor(() => !!releaseNovaclawResolve)
  // ⚠️ Through the helper, for the reason its own comment gives: assigned inside a closure, so after
  // the `= undefined` above TypeScript narrows the variable to `undefined` and an inline `?.()` is a
  // call on `never`.
  releaseNovaclaw()
  // The sidecar is registered once the runtime reaches `ready`. My first version waited on a
  // `controller.list()` that does not exist and swallowed the throw in a `.catch`, so the wait
  // silently did nothing — bun does not typecheck, and the typecheck ran after the tests were green.
  await waitFor(() => controller.getState().servers.some((item) => item.runtime.kind === "ready"))

  let settled = false
  const stopping = controller.stopAll().then(() => (settled = true))
  // The stop has been asked for and has NOT finished: `stopAll` must still be pending.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(settled).toBe(false)

  release()
  await stopping
  expect(settled).toBe(true)
  expect(stopped).toBe(true)
})

test("ignores stale background NovaClaw checks after removing a WSL server", async () => {
  persistedServers = []
  releaseNovaclawResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () => undefined,
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "novaclaw",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.addServer("Debian")
  await waitFor(() => !!releaseNovaclawResolve)
  await controller.removeServer("wsl:Debian")
  releaseNovaclaw()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().novaclawChecks).toEqual({})
})

test("ignores stale startup NovaClaw checks after removing a WSL server", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  releaseNovaclawResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => new Promise<never>(() => undefined),
    testControllerOptions(),
  )

  await controller.initialize()
  await waitFor(() => !!releaseNovaclawResolve)
  await controller.removeServer("wsl:Debian")
  releaseNovaclaw()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().novaclawChecks).toEqual({})
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

test("shutdown owns pending WSL spawns, awaits their disposal and refuses later starts", async () => {
  const spawned = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof createWslServersController>[1]>>>()
  const disposed = Promise.withResolvers<void>()
  let starts = 0,
    stops = 0,
    settled = false
  const controller = createWslServersController(
    "1.16.2",
    () => {
      starts++
      return spawned.promise
    },
    {
      readServers: () => [{ id: "wsl:Debian", distro: "Debian" }],
      writeServers: () => {},
      resolveNovaclaw: async () => null,
      readCommandVersion: async () => "1.16.2",
    },
  )
  await controller.initialize()
  await waitFor(() => starts === 1)
  const stopping = controller.stopAll()
  expect(controller.stopAll()).toBe(stopping)
  void stopping.then(() => {
    settled = true
  })
  spawned.resolve({
    listener: {
      stop: () => {
        stops++
        return disposed.promise
      },
      onExit: () => {},
    },
    url: "http://127.0.0.1:4096",
    username: "novaclaw",
    password: "fixture",
  })
  await waitFor(() => stops === 1)
  expect(settled).toBe(false)
  expect(controller.getState().servers.some((server) => server.runtime.kind === "ready")).toBe(false)
  disposed.resolve()
  await stopping
  await controller.initialize()
  await expect(controller.addServer("Ubuntu")).rejects.toThrow("shutting down")
  expect(starts).toBe(1)
})

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    resolveNovaclaw: async () => {
      await new Promise<void>((resolve) => {
        releaseNovaclawResolve = resolve
      })
      return "/home/me/.novaclaw/bin/novaclaw"
    },
  }
}
