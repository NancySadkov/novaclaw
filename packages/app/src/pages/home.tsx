import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  startTransition,
  Switch,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@novaclaw/ui/button"
import { Logo } from "@novaclaw/ui/logo"
import { Spinner } from "@novaclaw/ui/spinner"
import { ScrollView } from "@novaclaw/ui/scroll-view"
import { ProjectAvatar } from "@novaclaw/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { MenuV2 } from "@novaclaw/ui/v2/menu-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { getProjectAvatarVariant, useLayout, type HomeProjectSelection, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@novaclaw/core/util/encode"
import { Icon } from "@novaclaw/ui/icon"
import { useNewAgentSpawn } from "@/pages/home-screen/new-agent-bar"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogSelectServer, useServerManagementController } from "@/components/dialog-select-server"
import { DialogServerV2 } from "@/components/settings-v2/dialog-server-v2"
import { ServerConnection, useServer } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import {
  closeHomeProject,
  displayName,
  errorMessage,
  getProjectAvatarSource,
  homeProjectDirectories,
  projectForSession,
  sortedRootSessions,
  toggleHomeProjectSelection,
} from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { sessionTimeMillis } from "@/utils/session-time"
import { pathKey } from "@/utils/path-key"
import { useGlobal } from "@/context/global"
import { Binary } from "@novaclaw/core/util/binary"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { type ServerHealth } from "@/utils/server-health"
import { Persist, persisted } from "@/utils/persist"
import { useMarked } from "@novaclaw/ui/context/marked"
import { preloadMarkdown } from "@novaclaw/session-ui/markdown-cache"
import { archiveHomeSession } from "./home-session-archive"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { compactTokens, homeSessionTimeLabel, subtreeRows, tokenTotals } from "./home-session-meta"
import { Dialog } from "@novaclaw/ui/dialog"
import { usePermission } from "@/context/permission"
import { useChatsAttentionSets } from "@/apps/chats-attention"
import { DialogSessionInfo } from "@/components/dialog-session-info"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { showToast } from "@/utils/toast"
import { exportSessionMarkdown } from "@/utils/fs-api"

const HOME_SESSION_LIMIT = 64
const HOME_SESSION_HEADER_STICKY_TOP = 12
const HOME_SESSION_HEADER_TEXT_HEIGHT = 16
const HOME_SESSION_HEADER_FADE_DISTANCE = 16
const SHOW_HOME_SESSION_ARCHIVE = false
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base data-[selected]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:hover:bg-v2-background-bg-layer-03 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

let pendingHomeNavigation: { server: ServerConnection.Key; href: string } | undefined

function buildHomeSessionRecords(input: {
  sync: Pick<ServerSync, "child">
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  // The always-provisioned scratch cwd (new-agent-bar's default home for a chat started with no
  // project picked). Chats is the TASK MANAGER — a chat living outside every opened project must
  // still list (owner-hit 2026-07-22: launcher chats were invisible forever), so scratch-dir
  // sessions get a synthetic "Scratch" group instead of being dropped by the project filter.
  scratch?: { directory: string; name: string }
}) {
  const scratchKey = input.scratch ? pathKey(input.scratch.directory) : undefined
  return [
    ...new Map(
      input
        .projectDirectories()
        .flatMap((directory) => sortedRootSessions(input.sync.child(directory, { bootstrap: false })[0], Date.now()))
        .map((session) => [`${pathKey(session.location.directory)}:${session.id}`, session] as const),
    ).values(),
  ]
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .flatMap((session) => {
      const project = projectForSession(session, input.projects())
      if (!project) {
        if (scratchKey && pathKey(session.location.directory) === scratchKey && input.scratch) {
          return {
            session,
            project: { worktree: input.scratch.directory } as LocalProject,
            projectName: input.scratch.name,
          }
        }
        return []
      }
      return {
        session,
        project,
        projectName: displayName(project),
      }
    })
}

function useHomeSessionHeaderOpacity(groups: () => HomeSessionGroup[]) {
  let viewport: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let positionFrame: number | undefined
  let resizeObserver: ResizeObserver | undefined
  const headerRefs = new Map<HomeSessionGroup["id"], HTMLDivElement>()
  const headerOffsets = new Map<HomeSessionGroup["id"], number>()
  const [state, setState] = createStore({
    titleOpacity: {} as Partial<Record<HomeSessionGroup["id"], number>>,
  })

  createEffect(() => {
    const items = groups()
    const ids = new Set(items.map((group) => group.id))
    headerRefs.forEach((_, id) => {
      if (!ids.has(id)) headerRefs.delete(id)
    })
    headerOffsets.forEach((_, id) => {
      if (!ids.has(id)) headerOffsets.delete(id)
    })
    if (items.length === 0) {
      content = undefined
      bindResizeObserver()
    }
    queuePositionUpdate()
  })

  onCleanup(() => {
    if (positionFrame !== undefined) cancelAnimationFrame(positionFrame)
    resizeObserver?.disconnect()
  })

  function setViewport(el: HTMLDivElement) {
    viewport = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setContentRef(el: HTMLDivElement) {
    content = el
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setHeaderRef(id: HomeSessionGroup["id"], el: HTMLDivElement) {
    headerRefs.set(id, el)
    queuePositionUpdate()
  }

  function queuePositionUpdate() {
    if (typeof requestAnimationFrame === "undefined") {
      updatePositionCache()
      return
    }
    if (positionFrame !== undefined) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined
      updatePositionCache()
    })
  }

  function updatePositionCache() {
    if (!viewport) return
    groups().forEach((group) => {
      const el = headerRefs.get(group.id)
      if (!el) return
      headerOffsets.set(group.id, el.offsetTop)
    })
    update(viewport.scrollTop)
  }

  function update(scrollTop: number) {
    const items = groups()
    items.forEach((group, index) => {
      const nextOffset = items
        .slice(index + 1)
        .map((item) => headerOffsets.get(item.id))
        .find((offset) => offset !== undefined)
      const fadeEnd = HOME_SESSION_HEADER_STICKY_TOP + HOME_SESSION_HEADER_TEXT_HEIGHT
      const nextTop = nextOffset === undefined ? undefined : nextOffset - scrollTop
      const opacity =
        nextTop === undefined ? 1 : Math.max(0, Math.min(1, (nextTop - fadeEnd) / HOME_SESSION_HEADER_FADE_DISTANCE))
      setState("titleOpacity", group.id, Math.round(opacity * 1000) / 1000)
    })
  }

  function titleOpacity(id: HomeSessionGroup["id"]) {
    return state.titleOpacity[id] ?? 1
  }

  function bindResizeObserver() {
    resizeObserver?.disconnect()
    if (typeof ResizeObserver === "undefined") return
    resizeObserver = new ResizeObserver(() => queuePositionUpdate())
    if (viewport) resizeObserver.observe(viewport)
    if (content) resizeObserver.observe(content)
  }

  return { setViewport, setContentRef, setHeaderRef, update, titleOpacity }
}

export function NewHome() {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const notification = useNotification()
  const marked = useMarked()
  const newAgent = useNewAgentSpawn()
  const selection = layout.home.selection

  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )
  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]
  // The scratch cwd (new-agent-bar's default chat home) — its sessions list under a synthetic
  // "Scratch" group; a chat must never be invisible in the task manager just because it lives
  // outside every opened project. Only in the all-projects view: picking a workspace means
  // "show me that project".
  const scratchDir = createMemo(() => (focusedSync().data.path as { scratchDir?: string } | undefined)?.scratchDir)
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) {
      const scratch = scratchDir()
      const opened = projects().flatMap(directories)
      return scratch && !opened.some((directory) => pathKey(directory) === pathKey(scratch))
        ? [...opened, scratch]
        : opened
    }
    return directories(project)
  })
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", selection().server, ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(
        projectDirectories().map((directory) =>
          focusedSync().project.loadSessions(directory, { limit: HOME_SESSION_LIMIT }),
        ),
      )
      // Threads tree (uix-improvement slice 4): the roots-only list never carries child sessions;
      // hydrate them per directory (best-effort — the roots already rendered).
      void Promise.all(
        projectDirectories().map((directory) => focusedSync().project.loadChildSessions(directory)),
      )
      return null
    },
  }))

  const allRecords = createMemo(() => {
    const scratch = scratchDir()
    return buildHomeSessionRecords({
      sync: focusedSync(),
      projectDirectories,
      projects,
      ...(scratch ? { scratch: { directory: scratch, name: language.t("home.scratch.name") } } : {}),
    })
  })
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  // Tags component (notes/entities.md T0): the tag filter over chat processes. The universe is the
  // tags of the currently listed roots; picking one narrows the list (attention cluster included).
  const [selectedTag, setSelectedTag] = createSignal<string | undefined>()
  const tagUniverse = createMemo(() => {
    if (selection().server !== server.key) return []
    const map = sync().session.data.tag
    const universe = new Set<string>()
    for (const record of records()) for (const tag of map[record.session.id] ?? []) universe.add(tag)
    return [...universe].sort()
  })
  // Toolbar search: a plain client-side text filter over title + project/folder name — the
  // task-manager's find-as-you-type (owner 2026-07-22). Composes with the tag filter.
  const [searchQuery, setSearchQuery] = createSignal("")
  const visibleRecords = createMemo(() => {
    const tag = selectedTag()
    const query = searchQuery().trim().toLowerCase()
    let list = records()
    if (tag) {
      const map = sync().session.data.tag
      list = list.filter((record) => (map[record.session.id] ?? []).includes(tag))
    }
    if (query) {
      list = list.filter((record) => {
        const title = (sessionTitle(record.session.title) || record.session.id).toLowerCase()
        return title.includes(query) || (record.projectName ?? "").toLowerCase().includes(query)
      })
    }
    return list
  })
  // Selection mode (mass delete/archive): Select toggles it; row clicks then toggle membership
  // instead of opening; the toolbar becomes the bulk-action bar. Both bulk actions confirm.
  const [selecting, setSelecting] = createSignal(false)
  const [selectedIDs, setSelectedIDs] = createSignal<Set<string>>(new Set(), { equals: false })
  const toggleSelected = (id: string) =>
    setSelectedIDs((current) => {
      if (current.has(id)) current.delete(id)
      else current.add(id)
      return current
    })
  const setMembership = (id: string, value: boolean) =>
    setSelectedIDs((current) => {
      if (value) current.add(id)
      else current.delete(id)
      return current
    })
  // Drag-select (owner 2026-07-22): press on a row and sweep — every row entered while the
  // pointer is down gets the SAME membership the anchor row toggled to (the file-manager
  // rubber-band feel without the geometry). Pointer-path only: keyboard toggles never start a
  // drag, and a document-level pointerup always ends it.
  let dragSelectValue: boolean | undefined
  const [dragSelecting, setDragSelecting] = createSignal(false)
  const beginDragSelect = (session: Session) => {
    const next = !selectedIDs().has(session.id)
    setMembership(session.id, next)
    dragSelectValue = next
    setDragSelecting(true)
  }
  const dragSelectOver = (session: Session) => {
    if (!dragSelecting() || dragSelectValue === undefined) return
    setMembership(session.id, dragSelectValue)
  }
  onMount(() => {
    const endDrag = () => setDragSelecting(false)
    document.addEventListener("pointerup", endDrag)
    onCleanup(() => document.removeEventListener("pointerup", endDrag))
  })
  const selectAllFiltered = () => setSelectedIDs(new Set(visibleRecords().map((record) => record.session.id)))
  const clearSelection = () => {
    setSelecting(false)
    setSelectedIDs(new Set<string>())
  }
  const selectedSessions = createMemo(() => {
    const ids = selectedIDs()
    return visibleRecords()
      .filter((record) => ids.has(record.session.id))
      .map((record) => record.session)
  })
  const runBulk = async (action: (session: Session) => Promise<void>) => {
    // Sequential on purpose: each call folds the store + tab state; parallel removes raced the
    // per-directory store writes when several sessions share a folder.
    for (const session of selectedSessions()) await action(session)
    clearSelection()
  }
  const confirmBulkDelete = () => {
    const count = selectedSessions().length
    if (count === 0) return
    void dialog.show(() => (
      <DialogBulkSessions
        count={count}
        danger
        title={language.t("home.sessions.bulk.delete.title", { count })}
        description={language.t("session.delete.description")}
        actionLabel={language.t("session.delete.button")}
        onConfirm={() => runBulk(deleteSession)}
      />
    ))
  }
  const confirmBulkArchive = () => {
    const count = selectedSessions().length
    if (count === 0) return
    void dialog.show(() => (
      <DialogBulkSessions
        count={count}
        title={language.t("home.sessions.bulk.archive.title", { count })}
        description={language.t("home.sessions.bulk.archive.description")}
        actionLabel={language.t("common.archive")}
        onConfirm={() => runBulk(archiveSession)}
      />
    ))
  }
  // T1: sortable process list. "recent" keeps the day groups + pinned attention cluster; the
  // metric sorts (activity status · consumed tokens) render a FLAT ordered list instead — a
  // grouping only makes sense for the time axis.
  const [sortMode, setSortMode] = createSignal<"recent" | "active" | "tokens">("recent")
  const flatSorted = createMemo(() => {
    const mode = sortMode()
    if (mode === "recent") return []
    const items = visibleRecords().slice()
    const updatedAt = (record: HomeSessionRecord) =>
      sessionTimeMillis(record.session.time.updated ?? record.session.time.created)
    if (mode === "tokens") {
      // Generated tokens only (output + reasoning) — the same metric the row badge shows.
      const generated = (record: HomeSessionRecord) => {
        const tokens = record.session.tokens
        return tokens ? (tokens.output ?? 0) + (tokens.reasoning ?? 0) : 0
      }
      return items.sort((a, b) => generated(b) - generated(a) || updatedAt(b) - updatedAt(a))
    }
    // active: waiting on the user → working → unseen output → everything else, newest first.
    const sets = chatsAttention()
    const waiting = new Set(sets.waiting)
    const unseen = new Set(sets.unseen)
    const data = sync().session.data
    const rank = (record: HomeSessionRecord) =>
      waiting.has(record.session.id)
        ? 0
        : data.session_working(record.session.id)
          ? 1
          : unseen.has(record.session.id)
            ? 2
            : 3
    return items.sort((a, b) => rank(a) - rank(b) || updatedAt(b) - updatedAt(a))
  })
  // Pinned "Needs attention" cluster (uix-improvement slice 3): chats waiting on the user first,
  // then unseen — lifted OUT of the day groups so the thing that needs you is always on top.
  const chatsAttention = useChatsAttentionSets()
  const attentionRecords = createMemo(() => {
    if (selection().server !== server.key) return []
    const sets = chatsAttention() ?? { waiting: [], unseen: [] }
    if (!sets.waiting.length && !sets.unseen.length) return []
    const rank = new Map<string, number>()
    sets.waiting.forEach((id) => rank.set(id, 0))
    sets.unseen.forEach((id) => rank.set(id, 1))
    // A record pins when it OR any session in its subtask subtree wants attention (a waiting
    // child bubbles to its root — the list shows roots).
    const recordRank = (record: HomeSessionRecord) => {
      let best = rank.get(record.session.id)
      // A record mid-fold (e.g. right after a session.next.moved event) can briefly lack its
      // location — skip the subtree walk rather than throw the whole memo into a faulted state.
      const directory = record.session.location?.directory
      if (!directory) return best
      const [childStore] = sync().child(directory, { bootstrap: false })
      for (const row of subtreeRows(childStore.session, record.session.id)) {
        const tier = rank.get(row.session.id)
        if (tier !== undefined && (best === undefined || tier < best)) best = tier
      }
      return best
    }
    return visibleRecords()
      .map((record) => ({ record, tier: recordRank(record) }))
      .filter((item): item is { record: HomeSessionRecord; tier: number } => item.tier !== undefined)
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier
        const at = sessionTimeMillis(a.record.session.time.updated ?? a.record.session.time.created)
        const bt = sessionTimeMillis(b.record.session.time.updated ?? b.record.session.time.created)
        return bt - at
      })
      .map((item) => item.record)
  })
  const groups = createMemo(() => {
    const pinned = new Set(attentionRecords().map((record) => record.session.id))
    return groupSessions(
      visibleRecords().filter((record) => !pinned.has(record.session.id)),
      language,
    )
  })
  const sessionHeaderOpacity = useHomeSessionHeaderOpacity(groups)
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = focusedServerCtx()
    if (!ctx) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(focusedServer()!)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            // F1e S5: warm the markdown cache from the native SessionMessage store (user prompt
            // text + assistant text content) — the V1 message/part store is being torn down.
            void ctx.sync.nativeMessages
              .load(record.session.id)
              .then(() => {
                const messages = ctx.sync.nativeMessages.messages(record.session.id) ?? []
                return Promise.all(
                  messages.flatMap((message) => {
                    if (message.type === "user") {
                      return message.text ? preloadMarkdown(message.text, message.id, marked) : []
                    }
                    if (message.type !== "assistant") return []
                    return message.content.flatMap((content) =>
                      content.type === "text" && content.text
                        ? preloadMarkdown(content.text, content.id, marked)
                        : [],
                    )
                  }),
                )
              })
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  // Surface a working folder on a fresh client. The web build has no native directory picker, so a
  // browser session would otherwise be stranded with nothing opened; the server's own working
  // directory (from the /path bootstrap) is the one folder it can meaningfully suggest. Runs once
  // per mount and only when zero folders are opened, so a curated client is never disturbed.
  let surfacedBackendProjects = false
  createEffect(() => {
    const ctx = focusedServerCtx()
    if (!ctx || surfacedBackendProjects) return
    if (ctx.projects.list().length > 0) {
      surfacedBackendProjects = true
      return
    }
    // T3 (entities.md): the server tracks no project list — its own working directory (the
    // /path bootstrap data) is the one directory a fresh client can meaningfully open.
    const cwd = ctx.sync.data.path.directory
    if (!cwd) return
    surfacedBackendProjects = true
    ctx.projects.open(cwd)
    ctx.projects.touch(cwd)
  })

  createEffect(() => {
    const pending = pendingHomeNavigation
    if (!pending || pending.server !== server.key) return
    pendingHomeNavigation = undefined
    navigate(pending.href)
  })

  function focusServer(conn: ServerConnection.Any) {
    setSelection({ server: ServerConnection.key(conn) })
  }

  function selectProject(conn: ServerConnection.Any, directory: string) {
    const key = ServerConnection.key(conn)
    if (global.servers.health[key]?.healthy === false) return
    if (
      !global
        .ensureServerCtx(conn)
        .projects.list()
        .some((project) => project.worktree === directory)
    )
      return
    setSelection(toggleHomeProjectSelection(selection(), key, directory))
  }

  function addProjects(conn: ServerConnection.Any, directories: string[]) {
    const directory = directories[0]
    if (!directory) return
    const ctx = global.ensureServerCtx(conn)
    directories.forEach(ctx.projects.open)
    ctx.projects.touch(directory)
    setSelection({ server: ServerConnection.key(conn), directory })
  }

  // Start a chat straight from the typed greeting entry: open a draft on the focused project and
  // hand the composer the seed prompt (newDraft appends ?prompt=), so the user never clicks "new session".
  function startChat(prompt: string) {
    const conn = focusedServer()
    const project = newSessionProject()
    if (!conn || !project) return
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(project.worktree)
    ctx.projects.touch(project.worktree)
    tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, prompt.trim() || undefined)
  }

  function editProject(conn: ServerConnection.Any, project: LocalProject) {
    void import("@/components/dialog-edit-project").then((x) => {
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    if (!state) return 0
    return directories(project).reduce((total, directory) => total + state.project.unseenCount(directory), 0)
  }

  function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    if (!state) return
    directories(project)
      .filter((directory) => state.project.unseenCount(directory) > 0)
      .forEach((directory) => state.project.markViewed(directory))
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects())
    const conn = focusedServer()
    if (!conn) return
    const directory = project?.worktree ?? session.location.directory
    const ctx = global.ensureServerCtx(conn)
    // The scratch cwd is server plumbing, not a user folder — opening it as a project would
    // pin a "scratch" workspace into the projects list forever. Its chats open by tab alone.
    const scratch = scratchDir()
    if (!scratch || pathKey(directory) !== pathKey(scratch)) {
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
    }
    startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    })
  }

  async function archiveSession(session: Session) {
    const conn = focusedServer()
    const ctx = focusedServerCtx()
    if (!conn || !ctx) return
    const [, setStore] = ctx.sync.child(session.location.directory)
    await archiveHomeSession({
      server: ServerConnection.key(conn),
      session: { id: session.id, directory: session.location.directory },
      update: (value) => ctx.sdk.client.v2.session.update(value),
      remove: () =>
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, session.id, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        ),
      onError: (error) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        }),
    })
  }

  const requestFailedToast = (error: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(error, language.t("common.requestFailed")),
    })

  // Task-manager controls (the ps row: suspend/resume/kill — todo.md §OS metaphor). Stop interrupts
  // the running turn (the chat survives); clone forks the full transcript into a fresh chat; delete
  // permanently removes the chat after an explicit confirm.
  async function stopSession(session: Session) {
    const ctx = focusedServerCtx()
    if (!ctx) return
    await ctx.sdk.client.v2.session
      .interrupt({ sessionID: session.id })
      .catch(requestFailedToast)
  }

  async function cloneSession(session: Session) {
    const ctx = focusedServerCtx()
    if (!ctx) return
    try {
      const forked = await ctx.sdk.client.v2.session.fork({ sessionID: session.id })
      if (forked.data?.data) openSession(forked.data.data)
    } catch (error) {
      requestFailedToast(error)
    }
  }

  // Export a chat as Markdown. The folder picker is the same one the Calendar and Recipes use, so the
  // user chooses where it lands; the server renders and writes the file (a browser cannot write to a
  // server path, and the server's message store is the authoritative, ordered source).
  //
  // A session that is STILL RUNNING exports what exists so far and says so — both in the toast and in
  // the file's closing note. We never pause a run to export it.
  async function exportSession(session: Session) {
    const conn = focusedServer()
    if (!conn) return
    // A Save-As, not a bare folder pick: the picker showed nowhere to type a name, so the export read as
    // broken (owner 2026-07-26). Seeded with a slug of the chat title; the server still guards the name.
    const suggested = `${(session.title || session.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || session.id}.md`
    let filename = suggested
    pickDirectory({
      server: conn,
      title: language.t("home.session.export.pick", { title: session.title || session.id }),
      filename: { initial: suggested, onFilename: (name) => (filename = name) },
      onSelect: (result) => {
        const into = Array.isArray(result) ? result[0] : result
        if (!into) return
        void exportSessionMarkdown(conn.http, {
          directory: session.location.directory,
          sessionID: session.id,
          into,
          filename,
        })
          .then((res) =>
            showToast({
              variant: "success",
              icon: "circle-check",
              title: res.running
                ? language.t("home.session.export.toast.running")
                : language.t("home.session.export.toast.done"),
              description: res.path,
            }),
          )
          .catch((error) =>
            showToast({
              title: language.t("home.session.export.toast.failed"),
              description: error instanceof Error ? error.message : String(error),
            }),
          )
      },
    })
  }

  async function deleteSession(session: Session) {
    const conn = focusedServer()
    const ctx = focusedServerCtx()
    if (!conn || !ctx) return
    try {
      await ctx.sdk.client.v2.session.remove({ sessionID: session.id })
      const [, setStore] = ctx.sync.child(session.location.directory)
      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, session.id, (s) => s.id)
          if (match.found) draft.session.splice(match.index, 1)
        }),
      )
      notifySessionTabsRemoved({
        server: ServerConnection.key(conn),
        directory: session.location.directory,
        sessionIDs: [session.id],
      })
    } catch (error) {
      showToast({
        title: language.t("session.delete.failed.title"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  function chooseProject(conn: ServerConnection.Any) {
    if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return

    function resolve(result: string | string[] | null) {
      addProjects(conn, homeProjectDirectories(result))
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="rounded-[10px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 lg:overflow-hidden bg-v2-background-bg-base self-stretch flex-1">
      {/* T1 (notes/entities.md): NO project column — the Chats app is logo → spawn box → the flat
          list of chat processes. Projects are just working folders; the spawn box targets the safe
          scratch dir by default with an optional folder override. */}
      <div class="mx-auto flex h-full w-full max-w-[720px] flex-col px-3 lg:px-6">
        <section
          class="min-h-0 min-w-0 flex-1 flex flex-col pt-6 lg:pt-10 relative"
          aria-label={language.t("sidebar.project.recentSessions")}
        >
          {/* Owner 2026-07-22: no "Sessions" heading — the top is ONE functional row
              (search · sort · Select · New Session), swapping to the bulk-action bar in
              selection mode; tag pills get their own wrap row below when tags exist. */}
          <div class="flex min-w-0 items-center gap-2 pt-1">
            <div class="relative min-w-0 flex-1">
              {/* Position the icon via a wrapper span — Icon renders its own sized <div>, and
                  absolute classes on the Icon itself land on the inner svg, detaching it from
                  its size box (the giant-glyph bug, owner-hit 2026-07-22). */}
              <span class="pointer-events-none absolute left-2 top-1/2 z-10 flex -translate-y-1/2 items-center text-v2-icon-icon-muted">
                <Icon name="magnifying-glass" size="small" />
              </span>
              <TextInputV2
                type="search"
                appearance="base"
                class="!w-full !pl-7"
                value={searchQuery()}
                placeholder={language.t("home.sessions.search.placeholder")}
                spellcheck={false}
                autocomplete="off"
                onInput={(event) => setSearchQuery(event.currentTarget.value)}
              />
            </div>
            <Show
              when={!selecting()}
              fallback={
                <>
                  <span class="shrink-0 text-[12px] leading-none text-v2-text-text-muted [font-weight:500]">
                    {language.t("home.sessions.selectedCount", { count: selectedIDs().size })}
                  </span>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={selectAllFiltered}>
                    {language.t("home.sessions.selectAll")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="neutral"
                    disabled={selectedIDs().size === 0}
                    onClick={confirmBulkArchive}
                  >
                    {language.t("common.archive")}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="danger"
                    disabled={selectedIDs().size === 0}
                    onClick={confirmBulkDelete}
                  >
                    {language.t("session.delete.button")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={clearSelection}>
                    {language.t("common.cancel")}
                  </ButtonV2>
                </>
              }
            >
            <div data-slot="home-sort" class="flex shrink-0 items-center gap-1">
              <For each={["recent", "active", "tokens"] as const}>
                {(mode) => (
                  <button
                    type="button"
                    class="rounded-full px-2 py-1 text-[12px] leading-none [font-weight:500] transition-colors"
                    classList={{
                      "bg-v2-background-bg-layer-02 text-v2-text-text-base": sortMode() === mode,
                      "text-v2-text-text-muted hover:bg-v2-background-bg-layer-01": sortMode() !== mode,
                    }}
                    aria-pressed={sortMode() === mode}
                    onClick={() => setSortMode(mode)}
                  >
                    {language.t(`home.sessions.sort.${mode}`)}
                  </button>
                )}
              </For>
            </div>
            <ButtonV2 size="small" variant="ghost-muted" class="shrink-0" onClick={() => setSelecting(true)}>
              {language.t("home.sessions.select")}
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="gold"
              class="shrink-0"
              disabled={!newAgent.ready() || newAgent.spawning()}
              onClick={() => void newAgent.spawn()}
            >
              <Icon name="plus-small" size="small" />
              {language.t("home.sessions.new")}
            </ButtonV2>
            </Show>
          </div>
          <Show when={(tagUniverse()?.length ?? 0) > 0}>
            <div data-slot="home-tag-filter" class="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
              <button
                type="button"
                class="rounded-full px-2 py-1 text-[12px] leading-none [font-weight:500] transition-colors"
                classList={{
                  "bg-v2-background-bg-layer-02 text-v2-text-text-base": selectedTag() === undefined,
                  "text-v2-text-text-muted hover:bg-v2-background-bg-layer-01": selectedTag() !== undefined,
                }}
                onClick={() => setSelectedTag(undefined)}
              >
                {language.t("home.sessions.filter.all")}
              </button>
              <For each={tagUniverse()}>
                {(tag) => (
                  <button
                    type="button"
                    class="rounded-full px-2 py-1 text-[12px] leading-none [font-weight:500] transition-colors"
                    classList={{
                      "bg-v2-background-bg-layer-02 text-v2-text-text-base": selectedTag() === tag,
                      "text-v2-text-text-muted hover:bg-v2-background-bg-layer-01": selectedTag() !== tag,
                    }}
                    onClick={() => setSelectedTag((current) => (current === tag ? undefined : tag))}
                  >
                    {tag}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <ScrollView
            class="mt-3 -mr-3 min-h-0 flex-1 relative"
            viewportRef={sessionHeaderOpacity.setViewport}
            onScroll={(event) => sessionHeaderOpacity.update(event.currentTarget.scrollTop)}
          >
            <Show
              when={!sessionLoad.isLoading}
              fallback={
                <div class="pt-3">
                  <HomeSessionSkeleton label={language.t("common.loading")} />
                </div>
              }
            >
              <Show
                // `?.` on each list: a faulted/HMR-disposed memo reads as undefined (owner-hit
                // 2026-07-21 — `.length` of undefined crashed the whole sessions pane); the
                // degrade is an empty list, never a dead-end (dependability law).
                when={
                  (groups()?.length ?? 0) > 0 ||
                  (attentionRecords()?.length ?? 0) > 0 ||
                  (flatSorted()?.length ?? 0) > 0
                }
                fallback={<HomeSessionsEmpty onNewSession={() => navigate("/")} />}
              >
                <div ref={sessionHeaderOpacity.setContentRef} class="flex flex-col pt-3 pr-3 pb-16">
                  <Show
                    when={sortMode() === "recent"}
                    fallback={
                      <div data-slot="home-flat-list" class="flex min-w-0 flex-col gap-px pt-1">
                        <For each={flatSorted()}>
                          {(record) => (
                            <HomeSessionRow
                              record={record}
                              showProjectName={!selectedProject()}
                              server={selection().server}
                              activeServer={selection().server === server.key}
                              openSession={openSession}
                              archiveSession={archiveSession}
                              stopSession={stopSession}
                              cloneSession={cloneSession}
                              exportSession={exportSession}
                              deleteSession={deleteSession}
                              selecting={selecting()}
                              selected={selectedIDs().has(record.session.id)}
                              onToggleSelect={(session) => toggleSelected(session.id)}
                              onSelectStart={beginDragSelect}
                              onSelectOver={dragSelectOver}
                            />
                          )}
                        </For>
                      </div>
                    }
                  >
                  <Show when={(attentionRecords()?.length ?? 0) > 0}>
                    <HomeSessionGroupHeader
                      title={language.t("home.sessions.group.attention")}
                      titleOpacity={1}
                      // A callback no-op, NOT `undefined`: Solid compiles a plain ref prop into an
                      // assignment, and forwarding undefined becomes `window.undefined = el` (crash).
                      ref={() => {}}
                      elevated
                    />
                    <div data-slot="home-attention-cluster" class="flex min-w-0 flex-col gap-px pt-4 mb-6">
                      <For each={attentionRecords()}>
                        {(record) => (
                          <HomeSessionRow
                            record={record}
                            showProjectName={!selectedProject()}
                            server={selection().server}
                            activeServer={selection().server === server.key}
                            openSession={openSession}
                            archiveSession={archiveSession}
                            stopSession={stopSession}
                            cloneSession={cloneSession}
                              exportSession={exportSession}
                            deleteSession={deleteSession}
                            selecting={selecting()}
                            selected={selectedIDs().has(record.session.id)}
                            onToggleSelect={(session) => toggleSelected(session.id)}
                            onSelectStart={beginDragSelect}
                            onSelectOver={dragSelectOver}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                  <For each={groups()}>
                    {(group, index) => (
                      <>
                        <HomeSessionGroupHeader
                          title={group.title}
                          titleOpacity={sessionHeaderOpacity.titleOpacity(group.id)}
                          ref={(el) => sessionHeaderOpacity.setHeaderRef(group.id, el)}
                          elevated={index() === 0}
                        />
                        <div
                          class={`flex min-w-0 flex-col gap-px pt-4 ${index() === groups().length - 1 ? "" : "mb-6"}`}
                        >
                          <For each={group.sessions}>
                            {(record) => (
                              <HomeSessionRow
                                record={record}
                                showProjectName={!selectedProject()}
                                server={selection().server}
                                activeServer={selection().server === server.key}
                                openSession={openSession}
                                archiveSession={archiveSession}
                                stopSession={stopSession}
                                cloneSession={cloneSession}
                              exportSession={exportSession}
                                deleteSession={deleteSession}
                                selecting={selecting()}
                                selected={selectedIDs().has(record.session.id)}
                                onToggleSelect={(session) => toggleSelected(session.id)}
                                onSelectStart={beginDragSelect}
                                onSelectOver={dragSelectOver}
                              />
                            )}
                          </For>
                        </div>
                      </>
                    )}
                  </For>
                  </Show>
                </div>
              </Show>
            </Show>
          </ScrollView>
        </section>
      </div>
    </div>
  )
}

// The greeting entry that leads the Chats main column: type a message and hit Enter (or Start) to
// begin a new chat. It seeds `startChat`, which opens the real composer pre-filled — no "new session"
// click. When no project is open yet (O1) it does NOT dead-end at a greyed-out box: it shows a friendly
// branded CTA that opens the folder picker, so the tour's promised "just start chatting" never fails
// silently. Strings are i18n'd (C5/O4).
function ChatEntry(props: { onSubmit: (prompt: string) => void; disabled?: boolean; onAddProject?: () => void }) {
  const language = useLanguage()
  const [value, setValue] = createSignal("")
  const submit = () => {
    const text = value().trim()
    if (!text || props.disabled) return
    setValue("")
    props.onSubmit(text)
  }
  return (
    <div class="flex w-full shrink-0 flex-col items-center gap-3.5 pb-4">
      {/* The greeting is the page's focal point — sized like a title, not a label. */}
      <div class="text-[20px] font-semibold tracking-tight text-v2-text-text-base">
        {language.t("home.chat.greeting")}
      </div>
      <Show
        when={!props.disabled}
        fallback={
          <button
            type="button"
            data-action="chat-entry-add-project"
            class="flex w-full items-center gap-3 rounded-[14px] bg-v2-background-bg-layer-02 px-4 py-3.5 text-left shadow-[0_0_0_0.5px_var(--v2-border-border-base)] transition-colors hover:bg-v2-background-bg-layer-03"
            onClick={() => props.onAddProject?.()}
          >
            <div
              class="flex size-9 shrink-0 items-center justify-center rounded-[0.7rem] ring-1 ring-white/15"
              style={{
                "background-image": "linear-gradient(155deg, #f4d06a -8%, #e7b62f 42%, #c99a2e 105%)",
                "--icon-base": "color-mix(in srgb, var(--nc-ink, #1a1135) 92%, transparent)",
              }}
            >
              <IconV2 name="folder-add-left" />
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[14px] font-semibold text-v2-text-text-base">
                {language.t("home.chat.addProjectTitle")}
              </span>
              <span class="text-[12px] text-v2-text-text-muted leading-snug">
                {language.t("home.chat.addProjectHint")}
              </span>
            </div>
          </button>
        }
      >
        <div class="flex w-full items-end gap-2 rounded-[14px] bg-v2-background-bg-layer-02 px-3.5 py-3 shadow-[0_0_0_0.5px_var(--v2-border-border-base)] transition-[box-shadow] duration-[120ms] ease-in-out focus-within:shadow-[0_0_0_1px_var(--v2-border-border-focus),var(--v2-elevation-raised)]">
          <textarea
            rows={1}
            data-component="chat-entry-input"
            class="max-h-40 min-h-6 min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-[15px] text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
            placeholder={language.t("home.chat.placeholder")}
            value={value()}
            onInput={(event) => {
              setValue(event.currentTarget.value)
              event.currentTarget.style.height = "auto"
              event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {/* The one gold CTA on the page — the shared gold variant (hover/pressed states intact). */}
          <ButtonV2
            data-action="chat-entry-start"
            variant="gold"
            size="normal"
            class="h-7 shrink-0 px-3.5"
            disabled={!value().trim()}
            onClick={submit}
          >
            {language.t("home.chat.start")}
          </ButtonV2>
        </div>
      </Show>
    </div>
  )
}

// (T1: the desktop project column and its server/project row components were removed —
// projects are just working folders; organization is tags. See notes/entities.md.)

function HomeSessionLeading(props: {
  project: LocalProject
  session: Session
  server: ServerConnection.Key
  activeServer: boolean
  revealProjectOnHover: boolean
}) {
  const tabs = useTabs()
  const hasOpenTab = createMemo(() => sessionHasOpenTab(tabs.store, props.server, props.session))
  return (
    <div class="relative shrink-0">
      <Show when={hasOpenTab()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-[7px] w-[3px] -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 5px)" }}
        />
      </Show>
      <SessionTabAvatar
        project={props.project}
        directory={props.session.location.directory}
        sessionId={props.session.id}
        activeServer={props.activeServer}
        revealProjectOnHover={props.revealProjectOnHover}
      />
    </div>
  )
}

function HomeSessionGroupHeader(props: {
  title: string
  titleOpacity: number
  ref: ComponentProps<"div">["ref"]
  elevated?: boolean
}) {
  return (
    <div
      ref={props.ref}
      class={`pointer-events-none sticky top-3 flex h-7 min-w-0 items-center justify-between pl-3 bg-v2-background-bg-base ${props.elevated ? "home-session-group-header z-[5]" : "z-10"}`}
    >
      <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
        {props.title}
      </div>
    </div>
  )
}

// Attention + activity on a Chats row (uix-improvement slice 1) — the sidebar-dot vocabulary
// (sidebar-items.tsx SessionRow) made explicit on the hero list. Priority order: a chat waiting
// on the USER (pending permission/question, incl. child sessions) shows a labeled amber pill;
// agent activity shows a spinner; an unseen error a red dot; other unseen output a blue dot.
// Active server only — other servers' session/notification stores aren't synced client-side.
function HomeSessionAttention(props: { session: Session; activeServer: boolean }) {
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()

  // Created in component init (NOT inside a memo) exactly like the sidebar's SessionItem — child()
  // may bootstrap the directory store, and store creation must not run inside a tracked computation.
  // Default bootstrap: a fresh /chats load must seed the pending permission/question state for the
  // directories on screen, or the pill (and the page-level attention cluster reading the same store)
  // only ever appears from live events.
  const [childStore] = serverSync().child(props.session.location.directory)
  const waiting = createMemo(() => {
    if (!props.activeServer) return false
    const data = serverSync().session.data
    const ask = sessionPermissionRequest(
      childStore.session,
      data.permission,
      props.session.id,
      (item) => !permission.autoResponds(item, props.session.location?.directory),
    )
    if (ask) return true
    return !!sessionQuestionRequest(childStore.session, data.question, props.session.id)
  })
  const working = createMemo(() => {
    if (!props.activeServer || waiting()) return false
    return serverSync().session.data.session_working(props.session.id)
  })
  const hasError = createMemo(() => props.activeServer && notification.session.unseenHasError(props.session.id))
  const unseen = createMemo(() => props.activeServer && notification.session.unseenCount(props.session.id) > 0)

  return (
    <Switch>
      <Match when={waiting()}>
        <span
          data-slot="home-session-attention"
          data-kind="waiting"
          class="shrink-0 flex items-center rounded-full bg-v2-state-bg-warning px-1.5 py-0.5 text-[11px] leading-none text-v2-state-fg-warning [font-weight:530]"
        >
          {language.t("home.sessions.attention.waiting")}
        </span>
      </Match>
      <Match when={working()}>
        <span
          data-slot="home-session-attention"
          data-kind="working"
          class="shrink-0 flex items-center"
          title={language.t("home.sessions.attention.working")}
        >
          <Spinner class="size-[13px] text-v2-icon-icon-muted" />
        </span>
      </Match>
      <Match when={hasError()}>
        <span
          data-slot="home-session-attention"
          data-kind="error"
          class="shrink-0 size-1.5 rounded-full bg-v2-state-fg-danger"
          title={language.t("home.sessions.attention.error")}
        />
      </Match>
      <Match when={unseen()}>
        <span
          data-slot="home-session-attention"
          data-kind="unseen"
          class="shrink-0 size-1.5 rounded-full bg-v2-state-fg-info"
          title={language.t("home.sessions.attention.unseen")}
        />
      </Match>
    </Switch>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  showProjectName: boolean
  server: ServerConnection.Key
  activeServer: boolean
  openSession: (session: Session) => void
  archiveSession: (session: Session) => Promise<void>
  stopSession: (session: Session) => Promise<void>
  cloneSession: (session: Session) => Promise<void>
  exportSession: (session: Session) => Promise<void>
  deleteSession: (session: Session) => Promise<void>
  // Selection mode (mass delete/archive): clicking toggles membership instead of opening,
  // a leading check indicator renders, and the hover action strip stands down. The pointer
  // pair (start/over) powers drag-select; onToggleSelect stays the keyboard path.
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (session: Session) => void
  onSelectStart?: (session: Session) => void
  onSelectOver?: (session: Session) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName && props.record.projectName
  // Changes badge (Chat-UI slice d): a row whose agent has actual file changes in its folder shows
  // +add −del, sourced from Session.summary (populated in the list query). No badge when nothing changed.
  const changes = createMemo(() => {
    const summary = props.record.session.summary
    if (!summary || (summary.files ?? 0) <= 0) return undefined
    return { files: summary.files ?? 0, additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 }
  })
  const timeLabel = createMemo(() => {
    const time = props.record.session.time
    return homeSessionTimeLabel(time.updated ?? time.created, language.intl())
  })
  // Subtask subtree (uix-improvement slice 4): a root's child agents nest under it, indented —
  // the spawned-process structure is visible without a separate view. Children come from the
  // directory child store (the roots-only home query never carries them).
  const serverSyncForChildren = useServerSync()
  const children = createMemo(() => {
    if (!props.activeServer) return []
    const directory = props.record.session.location?.directory
    if (!directory) return []
    return subtreeRows(serverSyncForChildren().child(directory, { bootstrap: false })[0].session, props.record.session.id)
  })
  // Tags component (notes/entities.md T0): the chat's tag chips from the instance-wide tag map.
  const rowTags = createMemo(() =>
    props.activeServer ? (serverSyncForChildren().session.data.tag[props.record.session.id] ?? []) : [],
  )
  // Task-manager meta (todo.md ps row: … status · tokens): the chat's token spend incl. its
  // sub-agent threads, and whether a turn is currently running (gates the Stop control).
  const tokens = createMemo(() =>
    tokenTotals([props.record.session, ...children().map((row) => row.session)]),
  )
  const working = createMemo(
    () => props.activeServer && serverSyncForChildren().session.data.session_working(props.record.session.id),
  )
  // Live generation telemetry (ps shows CPU%): ~tokens streamed this run + current t/s, from the
  // SSE delta stream via the throttled session_live reader. Only rendered while the agent works.
  const live = createMemo(() =>
    working() ? serverSyncForChildren().session.data.session_live(props.record.session.id) : undefined,
  )
  const confirmDelete = () => {
    void dialog.show(() => (
      <DialogDeleteSession name={title()} onConfirm={() => props.deleteSession(props.record.session)} />
    ))
  }

  return (
    <>
    <div
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
      classList={{ group: !!showProjectName(), "bg-v2-background-bg-layer-01": !!props.selected }}
    >
      <button
        type="button"
        data-component="home-session-row"
        aria-pressed={props.selecting ? !!props.selected : undefined}
        class={`${HOME_ROW} h-10 min-w-0 flex-1 gap-2 py-3 pl-3 pr-10`}
        onPointerDown={(event) => {
          if (props.selecting && event.button === 0) {
            // preventDefault keeps the press from starting text selection while sweeping.
            event.preventDefault()
            props.onSelectStart?.(props.record.session)
          }
        }}
        onPointerEnter={() => {
          if (props.selecting) props.onSelectOver?.(props.record.session)
        }}
        onClick={(event) => {
          if (!props.selecting) props.openSession(props.record.session)
          // Keyboard activation only (detail 0): the pointer path already toggled on
          // pointerdown — letting the trailing click toggle again would undo it.
          else if (event.detail === 0) props.onToggleSelect?.(props.record.session)
        }}
      >
        <Show when={props.selecting}>
          <span
            data-slot="home-session-check"
            class="flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-colors"
            classList={{
              "ring-v2-text-text-accent bg-v2-background-bg-layer-02 text-v2-icon-icon-accent": !!props.selected,
              "ring-v2-border-border-base": !props.selected,
            }}
          >
            {/* Render the check ONLY when selected — sprite strokes don't inherit
                text-transparent, so an always-mounted check read as "prefilled". */}
            <Show when={props.selected}>
              <Icon name="check-small" size="small" />
            </Show>
          </span>
        </Show>
        <HomeSessionLeading
          project={props.record.project}
          session={props.record.session}
          server={props.server}
          activeServer={props.activeServer}
          revealProjectOnHover={!!showProjectName()}
        />
        <span
          class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName}
          </span>
        </Show>
        {/* The whole meta cluster (tags · attention · changes · tokens · time) yields to the
            hover-reveal action icons — hiding only the time left the icons drawn OVER the
            token/changes badges (owner-hit 2026-07-22). opacity keeps layout, so the title
            never slides under the icons; hover-conceal handles touch, where the icons are
            always visible. */}
        <span
          class="ml-auto flex shrink-0 items-center gap-2"
          classList={{
            // In selection mode the action strip stands down, so the meta needn't yield.
            "hover-conceal group-hover/session:opacity-0 group-focus-within/session:opacity-0": !props.selecting,
          }}
        >
          <Show when={rowTags().length > 0}>
            <span data-slot="home-session-tags" class="flex shrink-0 items-center gap-1">
              <For each={rowTags().slice(0, 2)}>
                {(tag) => (
                  <span class="rounded-full bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] leading-none text-v2-text-text-muted [font-weight:470]">
                    {tag}
                  </span>
                )}
              </For>
              <Show when={rowTags().length > 2}>
                <span class="text-[11px] leading-none text-v2-text-text-faint">+{rowTags().length - 2}</span>
              </Show>
            </span>
          </Show>
          <HomeSessionAttention session={props.record.session} activeServer={props.activeServer} />
          <Show when={changes()}>
            {(c) => (
              <span
                data-slot="home-session-changes"
                class="shrink-0 flex items-center gap-1 rounded-[4px] bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] leading-none text-v2-text-text-muted [font-weight:530]"
                // "workspace" is load-bearing: the diff is the FOLDER's uncommitted state, which
                // this chat may only partly own (issues.md nit — outside edits showed as the chat's).
                title={`+${c().additions} −${c().deletions} · ${c().files} changed in workspace`}
              >
                <span class="text-v2-state-fg-success">+{c().additions}</span>
                <span class="text-v2-state-fg-danger">−{c().deletions}</span>
              </span>
            )}
          </Show>
          <Show when={live()}>
            {(stats) => (
              <span
                data-slot="home-session-live"
                class="shrink-0 flex items-center gap-1 rounded-[4px] bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-v2-text-text-accent [font-weight:530]"
                title={language.t("home.session.live.title")}
              >
                <span
                  aria-hidden="true"
                  class="size-1.5 rounded-full bg-v2-icon-icon-accent motion-safe:animate-pulse"
                />
                ~{compactTokens(stats().approxTokens)} · {stats().tps} t/s
              </span>
            )}
          </Show>
          <Show when={tokens().generated > 0}>
            <span
              data-slot="home-session-tokens"
              class="shrink-0 flex items-center gap-1 rounded-[4px] bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-v2-text-text-muted [font-weight:530]"
              title={language.t("home.session.tokens.title", {
                generated: tokens().generated.toLocaleString(),
                output: tokens().output.toLocaleString(),
                reasoning: tokens().reasoning.toLocaleString(),
              })}
            >
              <Icon name="cpu" size="small" class="text-v2-icon-icon-muted" />
              {compactTokens(tokens().generated)}
            </span>
          </Show>
          <span
            data-slot="home-session-time"
            class="shrink-0 text-[11px] leading-none tabular-nums text-v2-text-text-faint [font-weight:440]"
          >
            {timeLabel()}
          </span>
        </span>
      </button>
      {/* group-focus-within (not just self focus-within): keyboard-focusing the ROW must reveal
          the actions in the same beat it hides the meta cluster — self-only focus left a focused
          row with meta hidden and nothing shown in its place. Stands down in selection mode. */}
      <Show when={!props.selecting}>
      <div class="hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/session:opacity-100 group-focus-within/session:opacity-100">
        <Show when={working()}>
          <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("home.session.stop")}>
            <IconButtonV2
              data-action="home-session-stop"
              variant="ghost-muted"
              size="large"
              icon={<Icon name="stop" size="small" />}
              aria-label={language.t("home.session.stop")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.stopSession(props.record.session)
              }}
            />
          </TooltipV2>
        </Show>
        <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("home.session.info")}>
          <IconButtonV2
            data-action="home-session-info"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="info" size="small" />}
            aria-label={language.t("home.session.info")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void dialog.show(() => (
                <DialogSessionInfo session={props.record.session} projectName={props.record.projectName} />
              ))
            }}
          />
        </TooltipV2>
        <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("home.session.clone")}>
          <IconButtonV2
            data-action="home-session-clone"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="fork" size="small" />}
            aria-label={language.t("home.session.clone")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void props.cloneSession(props.record.session)
            }}
          />
        </TooltipV2>
        <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("home.session.export")}>
          <IconButtonV2
            data-action="home-session-export"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="download" size="small" />}
            aria-label={language.t("home.session.export")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void props.exportSession(props.record.session)
            }}
          />
        </TooltipV2>
        <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("session.delete.title")}>
          <IconButtonV2
            data-action="home-session-delete"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="trash" size="small" />}
            aria-label={language.t("session.delete.title")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              confirmDelete()
            }}
          />
        </TooltipV2>
        <Show when={SHOW_HOME_SESSION_ARCHIVE}>
          <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("common.archive")}>
            <IconButtonV2
              data-action="home-session-archive"
              variant="ghost-muted"
              size="large"
              icon={<IconV2 name="archive" />}
              aria-label={language.t("common.archive")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.archiveSession(props.record.session)
              }}
            />
          </TooltipV2>
        </Show>
      </div>
      </Show>
    </div>
    <For each={children()}>
      {(row) => (
        <button
          type="button"
          data-component="home-session-child-row"
          class={`${HOME_ROW} h-8 min-w-0 flex-none gap-2 py-2 pr-10`}
          style={{ "padding-left": `${12 + row.depth * 16}px` }}
          onClick={() => props.openSession(row.session)}
        >
          <span aria-hidden="true" class="shrink-0 text-[12px] leading-none text-v2-text-text-faint">
            └
          </span>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-left text-[13px] text-v2-text-text-muted [font-weight:470]">
            {sessionTitle(row.session.title) || row.session.id}
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-2">
            <HomeSessionAttention session={row.session} activeServer={props.activeServer} />
            <span class="shrink-0 text-[11px] leading-none tabular-nums text-v2-text-text-faint [font-weight:440]">
              {homeSessionTimeLabel(row.session.time.updated ?? row.session.time.created, language.intl())}
            </span>
          </span>
        </button>
      )}
    </For>
  </>
  )
}

/** Deleting a chat is permanent (messages + history) — always confirm explicitly. */
/** Bulk-action confirm (mass delete/archive — owner 2026-07-22). One dialog, parameterized:
 *  the danger variant marks the irreversible delete; archive reuses it for symmetry. */
function DialogBulkSessions(props: {
  count: number
  title: string
  description: string
  actionLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog title={props.title} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-12-regular text-text-weak">{props.description}</span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant={props.danger ? "primary" : "secondary"}
            size="large"
            data-action="home-session-bulk-confirm"
            disabled={busy()}
            onClick={() => {
              setBusy(true)
              void props.onConfirm().finally(() => dialog.close())
            }}
          >
            {props.actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DialogDeleteSession(props: { name: string; onConfirm: () => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog title={language.t("session.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("session.delete.confirm", { name: props.name })}
          </span>
          <span class="text-12-regular text-text-weak">{language.t("session.delete.description")}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            data-action="home-session-delete-confirm"
            disabled={busy()}
            onClick={() => {
              setBusy(true)
              void props.onConfirm().finally(() => dialog.close())
            }}
          >
            {language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function HomeSessionsEmpty(props: { onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex min-h-full flex-col items-center gap-4 px-6 pt-[52px] text-center">
      <div class="shrink-0 text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
        {language.t("home.sessions.empty")}
      </div>
      <p class="mb-1 text-center text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
        {language.t("home.sessions.empty.description")}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2 data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  // sessionTimeMillis, not a raw read: a live-event-folded record could carry ISO-string times
  // (see utils/session-time.ts) and fromMillis THROWS on strings — this faulted the whole
  // sessions pane (owner-hit 2026-07-21). Normalization at the store boundary is the real fix;
  // the tolerant read keeps this pure function total regardless.
  const recordDay = (record: HomeSessionRecord) =>
    DateTime.fromMillis(sessionTimeMillis(record.session.time.updated ?? record.session.time.created))
  const todaySessions = records.filter((record) => recordDay(record).hasSame(now, "day"))
  const yesterdaySessions = records.filter((record) => recordDay(record).hasSame(yesterday, "day"))
  const olderSessions = records.filter((record) => {
    const time = recordDay(record)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export function LegacyHome() {
  const sync = useServerSync()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync().data.path.home)
  const serverUnreachable = createMemo(() => global.servers.health[server.key]?.healthy === false)
  // T3 (entities.md): no server project list — the server's working directory is the one
  // known folder to suggest.
  const recent = createMemo(() => {
    const cwd = sync().data.path.directory
    return cwd ? [cwd] : []
  })

  const serverDotClass = createMemo(() => {
    const healthy = global.servers.health[server.key]?.healthy
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(server: ServerConnection.Any, directory: string) {
    const serverCtx = global.ensureServerCtx(server)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function chooseProject() {
    if (serverUnreachable()) return
    const s = server.current
    if (!s) return

    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(s, directory)
        }
      } else if (result) {
        openProject(s, result)
      }
    }

    pickDirectory({
      server: s,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={recent().length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button
                icon="folder-add-left"
                size="normal"
                class="pl-2 pr-3"
                disabled={serverUnreachable()}
                onClick={chooseProject}
              >
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(worktree) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, worktree)}
                  >
                    {worktree.replace(homedir(), "~")}
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync().ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" disabled={serverUnreachable()} onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" disabled={serverUnreachable()} onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
