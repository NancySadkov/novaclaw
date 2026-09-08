import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ServerScope } from "@/utils/server-scope"

/**
 * 🔴 **A MODEL PREFERENCE BELONGS TO THE INSTANCE THAT SERVES THE MODEL.**
 *
 * The delete-a-model cover used to live in one store shared by every configured instance, while the
 * rule that expires a cover reads the SELECTED instance's catalog: *a key stays only while the
 * server still lists the model.* With one store and many servers there is no "the server".
 *
 * The failure, in the shape it was reported: remove `openai-compatible:qwen3-flash` on instance A;
 * switch to instance B, which never served that model; B's catalog loads, B's prune finds the key
 * unlisted and drops it — a destructive write performed on A's data by a server that knows nothing
 * about it. Switch back to A and the removed model is in the Models tab and in every agent's Tune
 * dialog again, with nothing on any screen saying why.
 *
 * ⚠️ **What this drives, and what it deliberately does not.** The defect was entirely in WHICH KEY
 * got written, so these tests use the real target derivation ({@link modelStoreTarget}) and the real
 * prefixed browser-storage adapter that `persisted()` hands to `makePersisted` — the two values that
 * decide isolation. `persisted()` itself is not called here: it builds a `createResource`, which
 * needs solid's browser build, and its readiness contract is already driven end to end in
 * `test-browser/persist-ready.test.ts`. The expiry rule is scope-free and stays proven by
 * `models-removed-cover.test.ts`. What neither of those could show is that B's prune has no way to
 * reach A's array, which is what this file is for.
 *
 * ⚠️ Every test uses instance names of its own. `utils/persist.ts` keeps a process-wide read cache
 * keyed by the full storage name, so a shared key plus a `clear()` between tests would let a later
 * read answer from the cache after the storage behind it was emptied — a green run that proves the
 * cache works and says nothing about the keys.
 */

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  clear() {
    this.values.clear()
  }
  get length() {
    return this.values.size
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

const backing = new MemoryStorage()
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

let PersistTesting: typeof import("@/utils/persist").PersistTesting
let modelStoreTarget: typeof import("./models-store").modelStoreTarget

const REMOVED = "openai-compatible:qwen3-flash"
const OTHER = "anthropic:claude-opus-5"
const instance = (name: string) => `https://${name}.example` as ServerScope

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: backing, configurable: true, writable: true })
  PersistTesting = (await import("@/utils/persist")).PersistTesting
  modelStoreTarget = (await import("./models-store")).modelStoreTarget
})

afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

/** One instance's model-preference store, at the exact key and storage the context persists to. */
function storeFor(scope: ServerScope) {
  const target = modelStoreTarget(scope)
  if (!target.storage) throw new Error("model store must name a storage")
  const storage = PersistTesting.localStorageWithPrefix(target.storage)
  const covers = (): string[] => {
    const raw = storage.getItem(target.key)
    if (raw === null) return []
    return ((JSON.parse(raw) as { removed?: string[] }).removed ?? []).slice()
  }
  const write = (removed: string[]) => storage.setItem(target.key, JSON.stringify({ removed }))
  return {
    covers,
    /** The Models-tab delete. */
    remove: (key: string) => write([...covers(), key]),
    /** What the prune effect does once THIS instance's catalog no longer lists the model. */
    prune: (listed: readonly string[]) => write(covers().filter((key) => listed.includes(key))),
  }
}

describe("model preferences are per instance", () => {
  test("🔴 a cover written on one instance is invisible to another", () => {
    storeFor(instance("a1")).remove(REMOVED)
    expect(storeFor(instance("b1")).covers()).toEqual([])
  })

  test("NEGATIVE CONTROL: the SAME instance reads its own cover back", () => {
    // Without this, a target that wrote nowhere at all would pass the test above, and the isolation
    // it claims would be the absence of persistence rather than the presence of a scope.
    storeFor(instance("a2")).remove(REMOVED)
    expect(storeFor(instance("a2")).covers()).toEqual([REMOVED])
  })

  test("🔴 the other instance's prune cannot erase it — the destructive half of the defect", () => {
    const a = instance("a3")
    storeFor(a).remove(REMOVED)
    // B loads its own catalog, which never carried this model, and expires what it takes to be its
    // own settled covers.
    storeFor(instance("b3")).prune([OTHER])
    expect(storeFor(a).covers()).toEqual([REMOVED])
  })

  test("NEGATIVE CONTROL: an instance's OWN prune still expires its OWN cover", () => {
    // Without this, a store that dropped every write would pass the test above. The cover must stay
    // droppable — that it expires at all is the whole reason it is a cover and not a tombstone.
    const a = instance("a4")
    storeFor(a).remove(REMOVED)
    storeFor(a).prune([OTHER])
    expect(storeFor(a).covers()).toEqual([])
  })

  test("the local instance keeps the key it already wrote under, so an upgrade loses nothing", () => {
    expect(modelStoreTarget(ServerScope.local).key).toBe("model")
    expect(modelStoreTarget(ServerScope.local).legacy).toEqual(["model.v1"])
    const remote = modelStoreTarget(instance("a5"))
    expect(remote.storage).toBe(modelStoreTarget(ServerScope.local).storage)
    expect(remote.key).not.toBe("model")
    expect(remote.key).toContain("https://a5.example")
  })
})
