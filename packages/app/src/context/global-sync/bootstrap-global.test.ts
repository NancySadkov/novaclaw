import { describe, expect, test } from "bun:test"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, NovaclawClient, Path } from "@novaclaw/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import type { InitError } from "@/pages/error"
import { ServerScope } from "@/utils/server-scope"
import { bootstrapGlobal, globalReady, loadGlobalConfigQuery, loadPathQuery, loadProvidersQuery } from "./bootstrap"

// The two literals `context/server-sync.tsx`'s getters answer with when their query holds no data.
// They are the whole point of these tests: a boot that FAILED and an instance that genuinely has
// nothing configured render exactly this, so nothing in the payload can tell them apart.
const EMPTY_PATH: Path = {
  state: "",
  config: "",
  data: "",
  roots: [],
  worktree: "",
  directory: "",
  home: "",
}
const EMPTY_PROVIDER: NormalizedProviderListResponse = {
  all: new Map(),
  models: new Map(),
  connected: [],
  default: {},
}

type Fixture = {
  ready: boolean
  error?: InitError
  path: Path
  provider: NormalizedProviderListResponse
  config: Config
}

/**
 * Stands in for `createServerSyncContextInner`'s global store: the same query-backed getters with
 * the same EMPTY fallbacks, and the REAL `globalReady` predicate rather than a restatement of it.
 */
function harness(sdk: NovaclawClient) {
  const scope = ServerScope.local
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let pending = true

  // ⚠️ Hoisted and ANNOTATED. `ready` derives from `error`, so a getter naming `store` would make
  // that binding's type circular through its own initializer (TS7022) — and an accessor may not
  // declare a `this` parameter (TS2784), so neither shortcut is available. `createStore` proxies
  // this very object, so reading `initial.error` reads what `setStore` wrote; the test asserts that
  // by flipping `ready` on a failed boot rather than trusting it.
  const initial: Fixture = {
    get ready() {
      return globalReady({ pending, error: initial.error })
    },
    get path() {
      return queryClient.getQueryData<Path>([...loadPathQuery(scope, null, sdk).queryKey]) ?? EMPTY_PATH
    },
    get provider() {
      const key = [...loadProvidersQuery(scope, null, sdk).queryKey]
      return queryClient.getQueryData<NormalizedProviderListResponse>(key) ?? EMPTY_PROVIDER
    },
    get config() {
      return queryClient.getQueryData<Config>([...loadGlobalConfigQuery(scope, sdk).queryKey]) ?? {}
    },
  }
  const [store, setStore] = createStore<Fixture>(initial)

  return {
    store,
    async boot() {
      const logged: unknown[][] = []
      const original = console.error
      console.error = (...args: unknown[]) => void logged.push(args)
      try {
        await bootstrapGlobal({
          serverSDK: sdk,
          scope,
          requestFailedTitle: "Request failed",
          translate: (key) => key,
          formatMoreCount: (count) => ` (+${count} more)`,
          // ⚠️ `Fixture` is deliberately the SUBSET of GlobalStore that bootstrapGlobal touches —
          // ready, error, path, provider, config — so the test cannot pass by leaning on a field
          // production would not have populated. The cast states that; widening Fixture to the whole
          // GlobalStore would import members (reload, and the rest) this case never exercises.
          setGlobalStore: setStore as unknown as SetStoreFunction<Parameters<typeof bootstrapGlobal>[0] extends {
            setGlobalStore: SetStoreFunction<infer S>
          }
            ? S
            : never>,
          queryClient,
        })
      } finally {
        console.error = original
      }
      pending = false
      return logged
    },
  }
}

const workingPath: Path = {
  state: "/state",
  config: "/config",
  data: "/data",
  roots: [],
  worktree: "/repo",
  directory: "/repo",
  home: "/home",
}

function sdkOf(input: {
  config: () => Promise<{ data: Config }>
  providers?: () => Promise<{ data: unknown }>
  path?: () => Promise<{ data: Path }>
}) {
  return {
    global: { config: { get: input.config } },
    provider: {
      list: input.providers ?? (async () => ({ data: { providers: [], models: [], connected: [], default: {} } })),
    },
    path: { get: input.path ?? (async () => ({ data: workingPath })) },
  } as unknown as NovaclawClient
}

describe("bootstrapGlobal", () => {
  test("a half-started instance is REPORTED, not rendered as an empty config", async () => {
    // What the SDK throws when the instance answers /health but 500s on GET /config.
    const failure = new Error("Internal Server Error", {
      cause: {
        body: {
          name: "ConfigInvalidError",
          data: { path: "/home/.config/novaclaw/novaclaw.json", message: "Unexpected token }" },
        },
      },
    })
    const boot = harness(sdkOf({ config: async () => Promise.reject(failure) }))
    const logged = await boot.boot()

    // The payload alone says nothing — this is exactly what a fresh, unconfigured instance shows.
    expect(boot.store.config).toEqual({})

    // ...so the failure has to be carried somewhere else, and it names the real cause.
    expect(boot.store.error).toEqual({
      name: "ConfigInvalidError",
      data: { path: "/home/.config/novaclaw/novaclaw.json", message: "Unexpected token }" },
    })
    expect(boot.store.ready).toBe(false)
    expect(logged.map((args) => args[0])).toEqual(["Failed to bootstrap instance globals"])
  })

  test("an instance that genuinely has nothing configured is ready, and looks the same", async () => {
    const boot = harness(sdkOf({ config: async () => ({ data: {} }) }))
    await boot.boot()

    // Byte-for-byte the same reading as the failure above...
    expect(boot.store.config).toEqual({})
    expect(boot.store.provider.all.size).toBe(0)
    // ...and only these two tell the two situations apart.
    expect(boot.store.error).toBeUndefined()
    expect(boot.store.ready).toBe(true)
  })

  test("a fault with no server body still reaches the user as a readable cause", async () => {
    const boot = harness(sdkOf({ config: async () => Promise.reject(new Error("Failed to reach the instance")) }))
    await boot.boot()

    expect(boot.store.error).toEqual({ name: "UnknownError", data: { message: "Failed to reach the instance" } })
    expect(boot.store.ready).toBe(false)
  })

  test("a boot that succeeds after a failure clears the verdict", async () => {
    let attempt = 0
    const boot = harness(
      sdkOf({
        config: async () => {
          attempt++
          if (attempt === 1) return Promise.reject(new Error("Failed to reach the instance"))
          return { data: {} as Config }
        },
      }),
    )

    await boot.boot()
    expect(boot.store.ready).toBe(false)

    // A repaired instance must not stay not-ready forever: `updateConfig` refetches this query.
    await boot.boot()
    expect(boot.store.error).toBeUndefined()
    expect(boot.store.ready).toBe(true)
    expect(attempt).toBe(2)
  })
})
