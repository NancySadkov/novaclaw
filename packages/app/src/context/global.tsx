import { createSimpleContext } from "@novaclaw/ui/context"
import { createEffect, createMemo, createResource, createRoot, createSignal, onCleanup } from "solid-js"
import { createServerProjects, ServerConnection, useServer } from "./server"
import { useServerHealth } from "@/utils/server-health"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { getOwner } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import { listAgents } from "@/apps/agent-list"
import type { AgentLike } from "@/apps/contacts"

export const {
  use: useGlobal,
  provider: GlobalProvider,
  context: GlobalContext,
} = createSimpleContext({
  name: "Global",
  init: () => {
    const server = useServer()
    const serverHealth = useServerHealth(
      () => server.list,
      () => true,
    )
    // `settings.serverKey` lived here until 2026-08-07: a per-panel "which instance's catalog am I
    // editing" selection whose only reader and only writer were `settings-server-picker.tsx`, inside
    // the unreachable v1 Settings dialog. Deleted with it — both halves, per todo.md's *we discard
    // all the cruft* ruling. The v2 Models tab derives its connection from the ACTIVE instance
    // (`settings-v2/models.tsx`), so nothing here has a second reader waiting.
    const serverCtxs = new Map<
      ServerConnection.Key,
      { dispose: () => void; serverCtx: ReturnType<typeof createServerCtx>; auth: string }
    >()

    const owner = getOwner()

    // The ctx cache is keyed by URL, but the SDK clients inside bake the connection's
    // CREDENTIALS into their auth header at creation — so editing an instance's username/
    // password must rebuild its ctx, or every request keeps the stale header (observed live
    // 2026-07-21: adding the token to a saved instance left the old credential-less ctx
    // serving 401s despite correct saved creds).
    const connAuth = (conn: ServerConnection.Any) => `${conn.http.username ?? ""}\0${conn.http.password ?? ""}`

    const ensureServerCtx = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      const existing = serverCtxs.get(key)
      if (existing && existing.auth === connAuth(conn)) return existing.serverCtx
      if (existing) {
        existing.dispose()
        serverCtxs.delete(key)
      }
      const root = createRoot((dispose) => {
        const serverCtx = createServerCtx(conn, server.scope(key), server.projects.forServer(key))
        return { dispose, serverCtx }
      }, owner as any)
      serverCtxs.set(key, { ...root, auth: connAuth(conn) })
      return root.serverCtx
    }

    // Server contexts are demand-created by the active route or an explicitly opened surface.
    // Creating one here for every configured connection starts that instance's TanStack queries,
    // roster resource, recovery reads, and SSE stream even when the user has never selected it.
    // `serverHealth` remains intentionally instance-wide because the server picker needs a truthful
    // status for every configured connection; it is the only boot fan-out left in this context.
    createEffect(() => {
      for (const [key] of serverCtxs) {
        if (!server.list.find((conn) => ServerConnection.key(conn) === key)) {
          const { dispose } = serverCtxs.get(key)!
          dispose()
          serverCtxs.delete(key)
        }
      }
    })

    return {
      servers: {
        list: () => server.list,
        health: serverHealth,
      },
      ensureServerCtx(conn: ServerConnection.Any) {
        return ensureServerCtx(conn)
      },
    }
  },
})

function createServerCtx(
  conn: ServerConnection.Any,
  scope: ServerScope,
  projects: ReturnType<typeof createServerProjects>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // Instance traffic must not gate on internet-online — see QueryProvider (app.tsx).
        networkMode: "always",
      },
      mutations: {
        networkMode: "always",
      },
    },
  })
  const sdk = createServerSdkContext(conn, scope)
  const sync = createServerSyncContext(sdk, projects)

  // This client is private to the cached server context. Retire its work and cache with the
  // context; otherwise credential rotation/removal leaves a detached client reachable only from
  // the old root's closure.
  onCleanup(() => {
    void queryClient.cancelQueries()
    queryClient.clear()
  })

  /**
   * THE roster for this instance — one fetch, shared by every surface that asks who works here.
   *
   * 🔴 It lives on the server context because there were THREE independent `createResource`s over
   * `GET /api/agent` (review D8, 2026-08-23): the home launcher's New Agent bar, the Contacts page,
   * and the config dialog on EVERY open. Opening Home, then Contacts, then one colleague was three
   * round trips for identical data — and the dialog's own in-flight window is what made it possible
   * to save a colleague's brief away as `""` before its record had arrived (D3).
   *
   * ⚠️ `.catch(() => [])` is not optional. `createResource.read()` re-throws into whatever memo
   * reads it, and this app has exactly ONE ErrorBoundary — at its root — so an unreachable instance
   * used to replace the entire UI, including on the boot route. A roster we cannot read degrades to
   * "nobody listed", never to a dead app; the surfaces that must distinguish "empty" from "failed"
   * keep their own error signal.
   *
   * ⚠️ It is DELIBERATELY the v2 list and not the sync store's `data.agent`, which is the legacy
   * `GET /agent` projection: entries keyed by `name`, carrying no `title`, `personality`, `avatar`
   * or `memory` (`apps/agent-list.ts`).
   */
  const [rosterError, setRosterError] = createSignal<unknown>(undefined)
  const [agentRoster, agentRosterActions] = createResource(
    () => sdk.client.v2,
    (client) =>
      listAgents(client).then(
        (rows) => {
          setRosterError(undefined)
          return rows
        },
        (error: unknown) => {
          // ⚠️ The failure is KEPT, not discarded. Most surfaces only want a list and are content
          // with an empty one, but Contacts is the roster: "you have nobody" and "we could not read
          // who you have" are different sentences, and collapsing them is how a broken request
          // reads as an empty organization. One fetch, both facts.
          setRosterError(error ?? new Error("listAgents failed"))
          return [] as AgentLike[]
        },
      ),
  )
  /**
   * 🔴 The roster JOINS the reconnect recovery engine, because a `createResource` was invisible to it.
   *
   * `server-sync.tsx` invalidates every TanStack query under this server's scope whenever the SSE
   * stream (re)connects — that is the whole data plane's cold-start and outage recovery. This roster
   * is a solid `createResource`, not a query, so it was NOT covered: it fetched exactly once during
   * boot and never ran again. A boot read that landed before the instance had materialised its agent
   * config was therefore permanent, and it did not look like a failure — an empty array resolves
   * SUCCESSFULLY, so `loading` was false, `error` was undefined, and Contacts rendered its
   * "No colleagues yet" empty state over an instance that had a full roster. Nova is seeded in code
   * and can never actually be absent, so that sentence was always a lie; the only cure was a reload,
   * which minted a fresh resource.
   *
   * ⚠️ It refetches on the TRANSITION into "connected", not on every status read. `streamStatus` also
   * carries "connecting"/"reconnecting", and refetching on each would put a request on the wire for
   * every retry tick of an instance that is down — the opposite of what a recovery path is for.
   */
  let lastStreamStatus: string | undefined
  createEffect(() => {
    const status = sdk.streamStatus()
    const previous = lastStreamStatus
    lastStreamStatus = status
    if (status !== "connected" || previous === "connected" || previous === undefined) return
    void agentRosterActions.refetch()
  })

  const agents = {
    list: (): readonly AgentLike[] => agentRoster.latest ?? [],
    loading: () => agentRoster.loading,
    /** The last failure, or `undefined` once a read succeeds. */
    error: () => rosterError(),
    refetch: () => void agentRosterActions.refetch(),
  }

  // Status labels are written by the lifecycle sampler after the roster's initial fetch. The event
  // is a cache-invalidation hint; GET /agent remains the one source of the joined roster row.
  const stopAgentStatus = sync.onAgentStatus(() => void agentRosterActions.refetch())
  onCleanup(stopAgentStatus)

  function enrich(project: { worktree: string; expanded: boolean; sandboxes?: string[]; id?: string }) {
    const [childStore] = sync.child(project.worktree, { bootstrap: false })
    // T3 (entities.md): the entity metadata died — the per-directory LOCAL meta is the source.
    const metadata = childStore.projectMeta

    // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
    // Without this, different subdirectories of the same git repo would share the same
    // icon from the database instead of using their individual overrides.
    const base = { ...metadata, ...project }
    if (childStore.icon) {
      return { ...base, icon: { ...base.icon, override: childStore.icon } }
    }
    return base
  }

  const projectsList = createMemo(() => projects.list().map(enrich))

  // ServerConnection.local IS this expression, and it returns a real boolean. The inline copy answered
  // `boolean | "local" | undefined`, because the private isLocalHost it called returns the STRING "local".
  const isLocal = ServerConnection.local(conn)

  return {
    queryClient,
    sdk,
    sync,
    agents,
    isLocal,
    projects: {
      ...projects,
      list: projectsList,
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>
