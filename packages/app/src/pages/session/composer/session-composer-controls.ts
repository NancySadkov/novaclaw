import { base64Encode } from "@novaclaw/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { switchMode, switchStrict } from "@/utils/fs-api"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
}) {
  const layout = useLayout()
  const local = useLocal()
  const providers = useProviders()
  const settings = useSettings()
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const view = layout.view(input.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))

  // 1K: mid-session permission-mode switch — update the local signal AND, when a session is live,
  // tell the server so the MODE_RULES overlay applies from the next turn (create-time uses the
  // signal only). Shared with the Strict switch, which raises the mode to its Bypass floor.
  const selectPermissionMode = (value: Parameters<typeof local.permissionMode.set>[0]) => {
    local.permissionMode.set(value)
    const id = input.sessionID()
    const conn = server.current
    const directory = sdk().directory
    if (id && conn && directory)
      void switchMode(conn.http, { directory, sessionID: id, permissionMode: value }).catch((error) =>
        console.error("switchMode failed", error),
      )
  }

  // The per-chat Strict switch (jh.md): this browser's explicit choice wins (it is what we last
  // POSTed — the store record only refreshes on load, so it must not shadow a newer toggle), then
  // the session record (a fork's copied override, or one set from another client), then the global
  // Settings → Strict default. Same local-first precedence as the permission-mode droplist.
  const strictGlobal = () =>
    (sync().data.config as { strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number } }).strict ?? {}
  const strictCurrent = () => {
    const id = input.sessionID()
    const record = id
      ? (sync().session.get(id) as { strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number } } | undefined)
          ?.strict
      : undefined
    return local.strict.current() ?? record ?? strictGlobal()
  }

  return createMemo<PromptInputControls>(() => ({
    // The visible agent picker (plan/build) is retired — the permission-mode droplist is the one mode
    // control. `available` still feeds the composer's @-mention subagent list.
    agents: {
      available: sync().data.agent,
    },
    model: {
      selection: local.model,
      paid: providers.paid().length > 0,
      loading: agentsQuery.isLoading || providersQuery.isLoading || globalProvidersQuery.isLoading,
    },
    permissionMode: {
      current: local.permissionMode.current(),
      select: selectPermissionMode,
    },
    strict: {
      current: strictCurrent(),
      set: (value) => {
        // The draft signal is the instant UI truth (and the create-time payload); a live session
        // ALSO persists the override server-side so the runner reads it on the next turn.
        local.strict.set(value)
        const id = input.sessionID()
        const conn = server.current
        const directory = sdk().directory
        if (id && conn && directory)
          void switchStrict(conn.http, { directory, sessionID: id, strict: value }).catch((error) =>
            console.error("switchStrict failed", error),
          )
        // The Strict harness executes autonomously — the runner's permission floor is Bypass
        // (llm.ts strict gate). Raise the mode with the switch so the toggle just works; the
        // popover says so out loud. Turning Strict off leaves the mode as the user set it.
        if (value.enabled) {
          const mode = local.permissionMode.current()
          if (mode !== "bypass" && mode !== "yolo") selectPermissionMode("bypass")
        }
      },
    },
    session: {
      id: input.sessionID(),
      tabs: layout.tabs(input.sessionKey),
      reviewPanel: view.reviewPanel,
    },
    newLayoutDesigns: settings.general.newLayoutDesigns(),
  }))
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
