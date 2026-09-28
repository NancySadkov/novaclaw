import { expect, test } from "bun:test"
import { createDeferredInstance } from "./deferred-instance"
import type { SuperviseStatus } from "@novaclaw/script/supervise"

const credentials = { url: "http://127.0.0.1:1", username: null, password: null }
function fixture() {
  const events: string[] = []
  let report: (status: SuperviseStatus) => void = () => {}
  const owner = {
    state: (): SuperviseStatus => ({ phase: "running" }),
    subscribe(listener: typeof report) {
      report = listener
      return () => {
        events.push("unsubscribe")
      }
    },
    async start() {
      events.push("start")
      return { credentials, healthy: Promise.resolve() }
    },
    async stop() {
      events.push("stop")
    },
    retain() {
      events.push("retain")
    },
  }
  const loading = Promise.withResolvers<typeof owner>()
  const instance = createDeferredInstance(() => {
    events.push("load")
    return loading.promise
  })
  return { events, owner, loading, instance, report: (status: SuperviseStatus) => report(status) }
}

test("controls exist before loading, and normal startup forwards status and ownership", async () => {
  const f = fixture()
  const statuses: SuperviseStatus[] = []
  f.instance.subscribe((status) => statuses.push(status))
  expect(f.events).toEqual([])
  const start = f.instance.start(new AbortController().signal)
  expect(f.events).toEqual(["load"])
  f.loading.resolve(f.owner)
  expect((await start).credentials).toEqual(credentials)
  f.report({ phase: "stopped" })
  // 🔴 `starting`, not `running`. This assertion used to require `running` here — the wrapper
  // reporting an instance as up before it had even imported the module that provides it, which is
  // how the connection gate came to be told its server was healthy while the port was still unbound
  // (packaged 0.1.81, 2026-09-28). The forwarding itself is what this test is for, and it is
  // unchanged: the owner's own `stopped` still arrives second.
  expect(statuses).toEqual([{ phase: "starting" }, { phase: "stopped" }])
  f.instance.retain?.()
  await f.instance.stop()
  expect(f.events).toEqual(["load", "start", "retain", "unsubscribe", "stop"])
})

test("quit during module loading releases the late owner without starting it", async () => {
  const f = fixture()
  const start = f.instance.start(new AbortController().signal)
  const rejected = start.catch((error) => error)
  const stop = f.instance.stop()
  expect(f.instance.stop()).toBe(stop)
  f.loading.resolve(f.owner)
  expect(await rejected).toEqual(new Error("NovaClaw is shutting down"))
  await stop
  expect(f.events).toEqual(["load", "stop"])
})

test("quit before startup never imports the server", async () => {
  const f = fixture()
  await f.instance.stop()
  await expect(f.instance.start(new AbortController().signal)).rejects.toThrow("shutting down")
  expect(f.events).toEqual([])
})

test("an import failure reaches startup and does not break shutdown", async () => {
  const f = fixture()
  const start = f.instance.start(new AbortController().signal)
  const rejected = start.catch((error) => error)
  f.loading.reject(new Error("module unavailable"))
  expect(await rejected).toEqual(new Error("module unavailable"))
  await f.instance.stop()
  expect(f.events).toEqual(["load"])
})
