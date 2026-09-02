import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createMemo, createResource, createRoot } from "solid-js"
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

/**
 * **A STORE THAT COULD NOT BE READ.**
 *
 * 🔴 Every reader of `ready` sat outside an `ErrorBoundary` and both halves of it threw on a
 * rejected load. `ready()` returned `ready.latest`, whose getter **re-throws** a stored error
 * whenever `resolved` is set — and `initialValue` sets `resolved`, so the spelling that reads like
 * the guarded one was the one that threw. `ready.promise` was `init.then(() => true)` with no
 * rejection arm, so every resource built over it errored (their accessors throw in turn) and every
 * `void ready.promise` caller raised an unhandled rejection. On desktop the trigger is ordinary:
 * `readCurrentAsync` awaits `storage.setItem` whenever a stored value is rewritten by
 * `normalize`/`migrate`, and the `store-set` IPC handler — unlike `store-get` — has no `try`/`catch`,
 * so a locked or full config file replaced the entire UI with the fatal error page.
 *
 * ⚠️ **A "did not throw" assertion alone would be satisfied by a store that never loads at all**,
 * so each case below pins the OUTCOME too: `ready()` settles `true` on the defaults, and the
 * failure is carried as the `false` that `ready.promise` resolves with. The successful case in the
 * same block is the control — it proves the promise is not simply hard-coded to report a failure,
 * and it is the reading these three assertions would produce if the fix were a swallow.
 */
describe("a persisted read that REJECTS settles instead of throwing", () => {
  const rejecting = (): AsyncStorage => ({
    getItem: async () => {
      throw new Error("electron-store: EACCES, config is locked")
    },
    setItem: async () => undefined,
    removeItem: async () => undefined,
    clear: async () => undefined,
    key: async () => null,
    getLength: async () => 0,
    length: Promise.resolve(0),
  })

  const healthy = (value: unknown): AsyncStorage => {
    const backing = new Map<string, string>([["p1-outcome", JSON.stringify(value)]])
    return {
      getItem: async (key) => backing.get(key) ?? null,
      setItem: async (key, next) => {
        backing.set(key, next)
      },
      removeItem: async (key) => {
        backing.delete(key)
      },
      clear: async () => undefined,
      key: async () => null,
      getLength: async () => 0,
      length: Promise.resolve(0),
    }
  }

  const settle = async (ready: () => boolean) => {
    for (let i = 0; i < 50 && !ready(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  test("the rejection is carried by ready.promise and never thrown", async () => {
    mode = { platform: "desktop", storage: rejecting }
    const { state, ready, dispose } = createRoot((dispose) => {
      const [state, , , ready] = persisted<{ v: number }>("p1-outcome", createStore({ v: 0 }))
      return { state, ready, dispose }
    })

    // THE symptom, first: this used to reject, which is what errored the composer's resource.
    await expect(ready.promise).resolves.toBe(false)
    await settle(ready)
    // Settled, on the defaults the store already holds — not parked at "still loading" forever.
    expect(ready()).toBe(true)
    expect(state.v).toBe(0)
    dispose()
  })

  test("CONTROL — the same three readings on a store that loads", async () => {
    mode = { platform: "desktop", storage: () => healthy({ v: 42 }) }
    const { state, ready, dispose } = createRoot((dispose) => {
      const [state, , , ready] = persisted<{ v: number }>("p1-outcome", createStore({ v: 0 }))
      return { state, ready, dispose }
    })

    await expect(ready.promise).resolves.toBe(true)
    await settle(ready)
    expect(ready()).toBe(true)
    expect(state.v).toBe(42)
    dispose()
  })

  test("a resource over ready.promise — the composer's own expression — does not error", async () => {
    mode = { platform: "desktop", storage: rejecting }
    const { res, ready, dispose } = createRoot((dispose) => {
      const [, , , ready] = persisted<{ v: number }>("p1-outcome", createStore({ v: 0 }))
      // Character-for-character what `components/prompt-input.tsx` builds over `prompt.ready`.
      const [res] = createResource(
        () => ready.promise,
        async (promise) => (await promise) === true,
      )
      return { res, ready, dispose }
    })

    for (let i = 0; i < 50 && res.state === "pending"; i++) await new Promise((r) => setTimeout(r, 10))
    // "errored" is the pre-fix reading, and it is the state whose ACCESSOR throws — from a bare
    // comma-expression in JSX, which is why one failed write took the whole application down.
    expect(res.state).toBe("ready")
    expect(res.error).toBeUndefined()
    // False, not undefined: the composer can tell "your draft did not load" from "still loading".
    expect(res()).toBe(false)
    // And the boolean half — `ready.latest`, the other pre-fix throw — is readable from a TRACKING
    // scope, which is the only place it is ever read in the app.
    expect(createRoot((d) => (createMemo(() => ready())(), d(), true))).toBe(true)
    dispose()
  })
})
