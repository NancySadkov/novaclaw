import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { CancelledError, QueryClient } from "@tanstack/solid-query"
import type { Config, NovaclawClient, Path } from "@novaclaw/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import { bootstrapDirectory, isCancelledError, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), models: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("isCancelledError", () => {
  // The SSE-reconnect recovery invalidates a scope with cancelRefetch — the cancellations it
  // causes in in-flight fetches are the RECOVERY working, never a fault to toast.
  test("recognizes TanStack cancellations and nothing else", () => {
    expect(isCancelledError(new CancelledError())).toBe(true)
    expect(isCancelledError(new Error("CancelledError"))).toBe(false)
    expect(isCancelledError(new TypeError("Failed to fetch"))).toBe(false)
    expect(isCancelledError(undefined)).toBe(false)
  })
})

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: { state: "", config: "", data: "", roots: [], worktree: "/project", directory: "/project", home: "/home" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      vcs: undefined,
      limit: 5,
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", data: "", roots: [], worktree: "/project", directory: "/project", home: "/home" },
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        v2: {
          permission: { request: { list: async () => ({ data: { data: [] } }) } },
          session: { active: async () => ({ data: { data: {} } }) },
        },
        question: { list: async () => ({ data: [] }) },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as NovaclawClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })
})

describe("bootstrapDirectory path seeding", () => {
  // The real child store exposes `path` as a GETTER over the per-directory path query
  // (child-store.ts) — a store write to it merges into the query's own store proxy, which
  // is Solid's dev "Cannot mutate a Store directly" warn with the write silently swallowed.
  // The seed must go to the query cache instead, and never touch the foreign proxy.
  test("seeds the path query cache and never writes the getter-backed store key", async () => {
    const seeded = {
      state: "s",
      config: "c",
      data: "d",
      roots: [],
      worktree: "/project",
      directory: "/project",
      home: "/home",
    }
    // Stands in for pathQuery.data: a foreign read-only store proxy behind the getter.
    const [foreignPath] = createStore({ ...seeded, state: "", worktree: "" })

    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      get path() {
        return foreignPath
      },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      vcs: undefined,
      limit: 5,
    })

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))

    const queryClient = new QueryClient()
    try {
      await bootstrapDirectory({
        directory: "/project",
        scope: ServerScope.local,
        mcp: false,
        global: {
          config: {} satisfies Config,
          path: seeded,
          provider,
        },
        sdk: {
          app: { agents: async () => ({ data: [] }) },
          config: { get: async () => ({ data: {} }) },
          session: { status: async () => ({ data: {} }) },
          vcs: { get: async () => ({ data: undefined }) },
          command: { list: async () => ({ data: [] }) },
          v2: {
          permission: { request: { list: async () => ({ data: { data: [] } }) } },
          session: { active: async () => ({ data: { data: {} } }) },
        },
          question: { list: async () => ({ data: [] }) },
          mcp: { status: async () => ({ data: {} }) },
          provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
        } as unknown as NovaclawClient,
        store,
        setStore,
        vcsCache: { setStore() {} } as unknown as VcsCache,
        loadSessions() {},
        translate: (key) => key,
        queryClient,
      })
    } finally {
      console.warn = originalWarn
    }

    const pathKey = [...loadPathQuery(ServerScope.local, "/project", {} as NovaclawClient).queryKey]
    expect(queryClient.getQueryData<Path>(pathKey)).toEqual(seeded)
    expect(foreignPath.state).toBe("") // the proxy behind the getter is never written
    expect(warnings.filter((w) => w.includes("Cannot mutate a Store directly"))).toEqual([])
  })

  test("does not clobber existing path query data with the global seed", async () => {
    const existing = {
      state: "existing",
      config: "",
      data: "",
      roots: [],
      worktree: "/project",
      directory: "/project",
      home: "/home",
    }
    const queryClient = new QueryClient()
    const pathKey = [...loadPathQuery(ServerScope.local, "/project", {} as NovaclawClient).queryKey]
    queryClient.setQueryData<Path>(pathKey, existing)

    const [store, setStore] = createStore<State>({
      status: "complete",
      agent: [],
      command: [],
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      get path() {
        return existing
      },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      vcs: undefined,
      limit: 5,
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { ...existing, state: "stale-global" },
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: { list: async () => ({ data: [] }) },
        v2: {
          permission: { request: { list: async () => ({ data: { data: [] } }) } },
          session: { active: async () => ({ data: { data: {} } }) },
        },
        question: { list: async () => ({ data: [] }) },
        mcp: { status: async () => ({ data: {} }) },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as NovaclawClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient,
    })

    expect(queryClient.getQueryData<Path>(pathKey)).toEqual(existing)
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as NovaclawClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
