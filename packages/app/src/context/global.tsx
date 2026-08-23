import { createSimpleContext } from "@novaclaw/ui/context"
import { createEffect, createMemo, createResource, createRoot, createSignal } from "solid-js"
import { createServerProjects, ServerConnection, useServer } from "./server"
import { useServerHealth } from "@/utils/server-health"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { getOwner } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import { listAgents } from "@/apps/agent-list"
import type { AgentLike } from "@/apps/contacts"

export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
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

    createMemo(() => {
      for (const conn of server.list) {
        ensureServerCtx(conn)
      }
    })

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
  const sync = createServerSyncContext(sdk)

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
  const agents = {
    list: (): readonly AgentLike[] => agentRoster.latest ?? [],
    loading: () => agentRoster.loading,
    /** The last failure, or `undefined` once a read succeeds. */
    error: () => rosterError(),
    refetch: () => void agentRosterActions.refetch(),
  }

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

  const isLocal =
    (conn?.type === "sidecar" && conn.variant === "base") || (conn?.type === "http" && isLocalHost(conn.http.url))

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

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}
