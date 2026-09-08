import { expect, test } from "bun:test"
import { createLocalInstance, probeLocalPort } from "./local-instance"

const ready = () => ({ listener: { stop: async () => {} }, health: { wait: Promise.resolve() } })

test("a lost ephemeral port race re-probes and publishes the successful port", async () => {
  let probes = 0
  const ports: number[] = []
  const local = createLocalInstance({
    prepare() {},
    log() {},
    probe: async () => 4000 + ++probes,
    spawn: async (port) => {
      ports.push(port)
      if (ports.length === 1) throw Object.assign(new Error("collision"), { name: "PortUnavailableError" })
      return ready()
    },
  })
  const start = await local.start(new AbortController().signal)
  expect(ports).toEqual([4001, 4002])
  expect(start.credentials.url).toBe("http://127.0.0.1:4002")
  await start.healthy
  await local.stop()
})

test("a pinned collision, invalid pin and non-port failure are not retried", async () => {
  for (const [pinnedPort, name, expected] of [
    ["4000", "PortUnavailableError", 1],
    ["0", "Error", 0],
    [undefined, "Error", 1],
  ] as const) {
    let calls = 0
    const local = createLocalInstance({
      prepare() {},
      log() {},
      pinnedPort,
      probe: async () => 4000,
      spawn: async () => {
        calls++
        throw Object.assign(new Error("failed"), { name })
      },
    })
    await expect(local.start(new AbortController().signal)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(expected)
    await local.stop()
  }
})

test("quit owns a pending acquisition, stops it once and refuses later starts", async () => {
  const acquired = Promise.withResolvers<ReturnType<typeof ready>>()
  const released = Promise.withResolvers<void>()
  let spawned = 0,
    stopped = 0,
    settled = false
  const childSignals: AbortSignal[] = []
  const local = createLocalInstance({
    prepare() {},
    log() {},
    pinnedPort: "4000",
    spawn: async (_port, _password, signal) => {
      spawned++
      childSignals.push(signal)
      return acquired.promise
    },
  })
  const start = local.start(new AbortController().signal)
  void start.catch(() => undefined)
  const stopping = local.stop()
  expect(local.stop()).toBe(stopping)
  expect(childSignals[0]?.aborted).toBe(true)
  void stopping.then(() => {
    settled = true
  })
  acquired.resolve({
    listener: {
      stop: () => {
        stopped++
        return released.promise
      },
    },
    health: { wait: Promise.resolve() },
  })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(stopped).toBe(1)
  expect(settled).toBe(false)
  released.resolve()
  await stopping
  await expect(start).rejects.toThrow("shutting down")
  await expect(local.start(new AbortController().signal)).rejects.toThrow("shutting down")
  expect(spawned).toBe(1)
})

test("the real loopback probe returns a bindable port and refuses an already cancelled request", async () => {
  const signal = new AbortController()
  const port = await probeLocalPort(signal.signal)
  expect(port).toBeGreaterThan(0)
  expect(port).toBeLessThan(65536)
  signal.abort(new Error("cancelled"))
  expect(() => probeLocalPort(signal.signal)).toThrow("cancelled")
})
