import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"
import { ServerScope } from "@/utils/server-scope"
import { selectProviderCatalog } from "@/hooks/provider-catalog"
import { directoryKey } from "./utils"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
const querySingles: Array<() => { queryKey?: unknown[]; enabled?: boolean }> = []
const persist: typeof import("@/utils/persist").persisted = (_target, store) => [
  store[0],
  store[1],
  null,
  // P1 readiness contract: ready.promise is always a Promise (resolved when loaded).
  Object.assign(() => true, { promise: Promise.resolve(true) }),
]

const child = () => createStore({} as State)
const provider = {
  all: new Map(),
  models: new Map(),
  connected: [],
  default: {},
} satisfies NormalizedProviderListResponse

/** A one-provider catalog, distinguishable from every other by the id it carries. */
const catalogOf = (id: string): NormalizedProviderListResponse => ({
  all: new Map([[id, { id, name: id, api: { type: "native", settings: {} }, request: { headers: {}, body: {} } }]]),
  models: new Map(),
  connected: [id],
  default: { [id]: `${id}-model` },
})

/** What the mocked per-directory `providers` query answers with. Unlisted directories get `provider`. */
const providerByDirectory = new Map<string, NormalizedProviderListResponse>()

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  mcp: (directory: string) => ({ queryKey: [directory, "mcp"], queryFn: async () => ({}) }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  mock.module("@tanstack/solid-query", () => ({
    useQuery: (options: () => { queryKey?: unknown[]; enabled?: boolean }) => {
      querySingles.push(options)
      return {
        get isLoading() {
          return options().queryKey?.[1] === "path"
        },
        get data() {
          if (options().queryKey?.[1] === "path") throw new Error("pending path data read")
          if (options().queryKey?.[1] === "mcp") return options().enabled ? { demo: { status: "disabled" } } : undefined
          if (options().queryKey?.[1] === "providers")
            return providerByDirectory.get(String(options().queryKey?.[0])) ?? provider
          return undefined
        },
      }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onMcp() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: queryOptionsApi,
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(5)
      expect(bootstraps).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  // Ported from outside contribution #10 by @DassaultFalconKing — the second
  // of the two stores that had the bug.
  test("treats exited sessions as settled", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store, setStore] = manager.child("/project", { bootstrap: false })

      expect(store.session_working("root")).toBe(false)
      setStore("session_status", "root", { type: "busy" })
      expect(store.session_working("root")).toBe(true)
      setStore("session_status", "root", { type: "exited" })
      expect(store.session_working("root")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("enables MCP only when requested for the directory", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const mcpLoads: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp(directory) {
          mcpLoads.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store, setStore] = manager.child("/project", { bootstrap: false })
      expect(querySingles.length - offset).toBe(3)
      const query = querySingles[offset + 1]
      if (!query) throw new Error("query required")
      expect(query().enabled).toBe(false)

      setStore("status", "complete")
      manager.child("/project", { bootstrap: false, mcp: true })
      expect(query().enabled).toBe(true)
      expect(store.mcp).toEqual({ demo: { status: "disabled" } })
      expect(mcpLoads).toEqual(["/project"])

      manager.disableMcp("/project")
      expect(query().enabled).toBe(false)
      expect(manager.mcp("/project")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("force-disposes every child during parent teardown, including pinned children", () => {
    const disposed: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose(directory) {
          disposed.push(directory)
        },
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      manager.child("/project", { bootstrap: false })
      manager.pin("/project")

      expect(manager.disposeDirectory(directoryKey("/project"))).toBe(false)
      manager.disposeAll()
      manager.disposeAll()

      expect(manager.children["/project"]).toBeUndefined()
      expect(disposed).toEqual(["/project"])
    } finally {
      dispose()
    }
  })
})

/**
 * 🔴 **WHICH CATALOG A DIRECTORY ANSWERS WITH — and where that question is allowed to be answered.**
 *
 * There were two rules. One lived in the child store's `provider` getter (*"if my catalog is empty
 * and the instance-wide one is not, serve that instead"*) and could never run: the instance-wide
 * list arrived as a value read once at construction, while its query was still loading, so the
 * comparison it guarded on was `0 > 0` on every evaluation the app would ever make. A branch that
 * cannot be taken still reads like a promise, and this one promised graceful degradation.
 *
 * The other lives in `selectProviderCatalog`, is reactive, and is what every consumer of this field
 * actually goes through. It strictly subsumes the dead one — an empty catalog lists no connected
 * providers — so the dead rule is gone rather than repaired.
 *
 * ⚠️ Both halves are asserted here, on the same store instance, because each half already had its
 * own passing test and the JOIN is what nothing exercised: `child-store.test.ts` asserted a branch
 * the only production caller could not reach, and `provider-catalog.test.ts` asserted the selector
 * against hand-built catalogs it never got from a child store.
 */
describe("which catalog a directory answers with", () => {
  const withManager = (run: (manager: ReturnType<typeof createChildStoreManager>) => void) => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
      })
    })
    try {
      if (!manager) throw new Error("manager required")
      run(manager)
    } finally {
      dispose()
      providerByDirectory.clear()
    }
  }

  test("🔴 an EMPTY per-directory catalog is reported as empty — the store never substitutes another answer", () => {
    // The condition the deleted branch claimed to handle. The store's job is to say what THIS
    // directory's server returned; the decision about what to show instead is not its to make.
    withManager((manager) => {
      const [store] = manager.child("/empty-catalog", { bootstrap: false })
      expect(store.provider_ready).toBe(true)
      expect(store.provider.all.size).toBe(0)
      expect(store.provider.connected).toEqual([])
    })
  })

  test("NEGATIVE CONTROL: a directory that HAS a catalog reports it, so the getter is not simply empty", () => {
    // Without this, a `provider` getter hardwired to EMPTY would pass the test above.
    withManager((manager) => {
      providerByDirectory.set(directoryKey("/served"), catalogOf("directory"))
      const [store] = manager.child("/served", { bootstrap: false })
      expect([...store.provider.all.keys()]).toEqual(["directory"])
      expect(store.provider.connected).toEqual(["directory"])
    })
  })

  test("🔴 the surviving fallback is REACHABLE: an empty child catalog resolves to the instance-wide one", () => {
    // Fed the real store's real output — not a hand-built empty literal — the live rule takes the
    // fallback. This is the assertion the dead branch was pretending to make.
    withManager((manager) => {
      const global = catalogOf("global")
      const [store] = manager.child("/empty-catalog", { bootstrap: false })
      const selected = selectProviderCatalog({
        directory: "/empty-catalog",
        catalog: { ready: store.provider_ready, providers: store.provider },
        global,
      })
      expect(selected).toBe(global)
      expect([...selected.all.keys()]).toEqual(["global"])
    })
  })

  test("NEGATIVE CONTROL: a directory that serves its own connected providers keeps them", () => {
    // Without this, a selector that always returned `global` would pass the test above and every
    // directory in the app would silently show the instance-wide catalog.
    withManager((manager) => {
      providerByDirectory.set(directoryKey("/served"), catalogOf("directory"))
      const [store] = manager.child("/served", { bootstrap: false })
      const selected = selectProviderCatalog({
        directory: "/served",
        catalog: { ready: store.provider_ready, providers: store.provider },
        global: catalogOf("global"),
      })
      expect([...selected.all.keys()]).toEqual(["directory"])
    })
  })
})
