import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createResource, createRoot } from "solid-js"
import { createStore } from "solid-js/store"

// ui-arch-hardening P1 — the readiness CONTRACT: `ready()` is the reactive boolean and
// `ready.promise` is ALWAYS a Promise — already-resolved for a synchronously-loaded store,
// never undefined. The 2026-07-14 composer-autofocus bug shipped because a resource was built
// over a sometimes-undefined promise and never resolved on warm mounts; these tests replay it.
// Lives in test-browser: `persisted()` calls createResource, which needs solid's browser build.

type PersistedFn = typeof import("@/utils/persist").persisted
let persisted: PersistedFn

// Switchable platform: "web" (sync localStorage path) or "desktop" with a gated async storage.
let mode: { platform: string; storage?: (name?: string) => AsyncStorage } = { platform: "web" }

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => mode,
  }))
  persisted = (await import("@/utils/persist")).persisted
})

beforeEach(() => {
  localStorage.clear()
  mode = { platform: "web" }
})

describe("persisted readiness contract (P1)", () => {
  test("sync (web) store: ready() true immediately and ready.promise is ALWAYS a resolving Promise", async () => {
    const [, , , ready] = createRoot(() => persisted("p1-sync", createStore({ v: 1 })))
    expect(ready()).toBe(true)
    // THE TRAP replayed: this promise used to be undefined for an already-loaded store.
    expect(ready.promise).toBeInstanceOf(Promise)
    await expect(ready.promise).resolves.toBeDefined()
  })

  test("a resource over ready.promise resolves on a WARM store (the autofocus failure mode)", async () => {
    const { res, dispose } = createRoot((dispose) => {
      const [, , , ready] = persisted("p1-warm", createStore({ v: 1 }))
      const [res] = createResource(
        () => ready.promise,
        (promise) => promise.then(() => true),
      )
      return { res, dispose }
    })
    for (let i = 0; i < 50 && res.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 10))
    expect(res.state).toBe("ready")
    expect(res.latest).toBe(true)
    dispose()
  })

  test("async (desktop) store: ready.promise gates the load; the loaded value lands", async () => {
    const backing = new Map<string, string>([["p1-async", JSON.stringify({ v: 42 })]])
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    mode = {
      platform: "desktop",
      storage: () => ({
        getItem: async (key) => {
          await gate
          return backing.get(key) ?? null
        },
        setItem: async (key, value) => {
          backing.set(key, value)
        },
        removeItem: async (key) => {
          backing.delete(key)
        },
        clear: async () => undefined,
        key: async () => null,
        getLength: async () => 0,
        length: Promise.resolve(0),
      }),
    }
    const { state, ready, dispose } = createRoot((dispose) => {
      const [state, , , ready] = persisted<{ v: number }>("p1-async", createStore({ v: 0 }))
      return { state, ready, dispose }
    })
    expect(ready()).toBe(false)
    expect(ready.promise).toBeInstanceOf(Promise)
    release()
    await ready.promise
    for (let i = 0; i < 50 && !ready(); i++) await new Promise((r) => setTimeout(r, 10))
    expect(ready()).toBe(true)
    expect(state.v).toBe(42)
    dispose()
  })

  test("writes after ready survive into storage and a second mount reads them (round-trip)", async () => {
    const first = createRoot((dispose) => {
      const [, setState, , ready] = persisted<{ v: number }>("p1-write", createStore({ v: 1 }))
      return { setState, ready, dispose }
    })
    await first.ready.promise
    first.setState("v", 7)
    first.dispose()
    const second = createRoot((dispose) => {
      const [state, , , ready] = persisted<{ v: number }>("p1-write", createStore({ v: 1 }))
      return { state, ready, dispose }
    })
    await second.ready.promise
    expect(second.state.v).toBe(7)
    second.dispose()
  })
})
