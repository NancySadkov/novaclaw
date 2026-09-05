import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@novaclaw/ui/context"
import { isRecord } from "@novaclaw/schema/record"
import { batch, createEffect, createMemo, createRoot, on, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK, type DirectorySDK } from "./sdk"
import type { Platform } from "./platform"
import { useServerSDK } from "./server-sdk"
import { useLanguage } from "./language"
import { base64Encode } from "@novaclaw/core/util/encode"
import { defaultTitle, titleNumber } from "./terminal-title"
import { shouldKeepExitedTab } from "@/pages/terminal-exit"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"
import { showToast } from "@/utils/toast"
import { useConfirm } from "@/components/dialog-confirm"
import type { V2PtyInstanceListResponse } from "@novaclaw/sdk/v2/types"

export type LocalPTY = {
  /** Durable UI identity. It survives server-PTY replacement so a tab, its active selection, and its
   * handles do not become a different entity when the user asks for a new shell. */
  id: string
  /** Ephemeral server process identity. Absent while creation is in flight. */
  ptyID?: string
  /** Location variant owning the server PTY. Absent for the ordinary directory location. */
  workspaceID?: string
  status: "starting" | "running" | "disconnected" | "exited"
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
  /** Resolved shell executable, straight from `Pty.Info.command` — the server already knows it and
   * the client used to throw it away. Named honestly at the render site: w64devkit's BusyBox `ash`
   * is not Bash and must never be labelled as one (terminal.md, the product contract). Optional
   * because tabs persisted before this field existed have no value for it. */
  shell?: string
  /** Working directory the shell actually started in, from `Pty.Info.cwd`. */
  cwd?: string
  /** Set only when the shell ended ABNORMALLY — a clean exit closes the tab instead. Its presence is
   * what marks a tab exited; see `shouldKeepExitedTab`. */
  exitCode?: number
}

const WORKSPACE_KEY = "__workspace__"
const MAX_TERMINAL_SESSIONS = 20

export type CloneOptions = {
  /** The connection layer already received a server-confirmed 404 for the old PTY. */
  confirmedGone?: boolean
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberFromTitle(title: string) {
  return titleNumber(title, MAX_TERMINAL_SESSIONS)
}

export function newTerminalClientID() {
  return `terminal-${crypto.randomUUID()}`
}

export function bindCreatedTerminal(
  local: LocalPTY,
  info: { readonly id: string; readonly title?: string; readonly command?: string; readonly cwd?: string },
): LocalPTY {
  return {
    ...local,
    // `id` deliberately comes from `local`: replacing a process must not replace the tab entity.
    ptyID: info.id,
    status: "running",
    title: info.title ?? local.title,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
    rows: undefined,
    cols: undefined,
    exitCode: undefined,
    shell: info.command,
    cwd: info.cwd,
  }
}

export function disconnectLiveTerminals(all: LocalPTY[]): LocalPTY[] {
  let changed = false
  const next = all.map((terminal) => {
    if (terminal.status === "exited" || terminal.status === "disconnected") return terminal
    changed = true
    return { ...terminal, status: "disconnected" as const }
  })
  return changed ? next : all
}

function pty(value: unknown): LocalPTY | undefined {
  if (!isRecord(value)) return

  const storedID = text(value.id)
  if (!storedID) return

  // Before T2 the one `id` was the server PTY id. Give those records a deterministic, distinct
  // client identity so migration is idempotent and the active-tab pointer can be translated.
  const storedPTYID = text(value.ptyID)
  const isClientID = storedID.startsWith("terminal-") || storedID.startsWith("legacy-tab:")
  const legacy = storedPTYID === undefined && !isClientID
  const id = legacy ? `legacy-tab:${storedID}` : storedID
  const ptyID = storedPTYID ?? (legacy ? storedID : undefined)
  const storedStatus = text(value.status)
  // A pending HTTP request cannot survive reload. Naming it disconnected is the honest recoverable
  // state; pretending it is still starting strands a spinner forever.
  const status =
    storedStatus === "starting" ? "disconnected" : storedStatus === "disconnected" ? "disconnected" : "running"

  const title = text(value.title) ?? ""
  const number = num(value.titleNumber)
  const rows = num(value.rows)
  const cols = num(value.cols)
  const buffer = text(value.buffer)
  const scrollY = num(value.scrollY)
  const cursor = num(value.cursor)
  const shell = text(value.shell)
  const cwd = text(value.cwd)
  const workspaceID = text(value.workspaceID)

  return {
    id,
    ...(ptyID === undefined ? {} : { ptyID }),
    status,
    title,
    titleNumber: number && number > 0 ? number : (numberFromTitle(title) ?? 0),
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(workspaceID !== undefined ? { workspaceID } : {}),
  }
}

export function migrateTerminalState(value: unknown) {
  if (!isRecord(value)) return value

  const seen = new Set<string>()
  const legacyIDs = new Map<string, string>()
  const all = (Array.isArray(value.all) ? value.all : []).flatMap((item) => {
    // Exited tabs are a within-session diagnosis. The server retains at most 25 of them, but after a
    // reload their Ghostty buffer is no longer authoritative and the old process cannot reconnect.
    if (isRecord(item) && (item.status === "exited" || num(item.exitCode) !== undefined)) return []
    const next = pty(item)
    if (!next || seen.has(next.id)) return []
    seen.add(next.id)
    if (isRecord(item)) {
      const oldID = text(item.id)
      if (oldID) legacyIDs.set(oldID, next.id)
    }
    return [next]
  })

  const storedActive = text(value.active)
  const active = storedActive === undefined ? undefined : (legacyIDs.get(storedActive) ?? storedActive)

  return {
    active: active && seen.has(active) ? active : all[0]?.id,
    all,
  }
}

type InstancePTY = V2PtyInstanceListResponse[number]

export function reconcileTerminalSnapshot(
  all: LocalPTY[],
  remote: readonly InstancePTY[],
  options: { readonly ids?: ReadonlySet<string>; readonly makeID?: () => string } = {},
): LocalPTY[] {
  const byPTY = new Map(remote.map((entry) => [entry.data.id, entry]))
  const claimed = new Set<string>()
  const existingNumbers = new Set(all.map((item) => item.titleNumber).filter((number) => number > 0))
  const nextNumber = () => {
    for (let number = 1; ; number++) {
      if (existingNumbers.has(number)) continue
      existingNumbers.add(number)
      return number
    }
  }

  const reconciled = all.map((local) => {
    const entry = local.ptyID ? byPTY.get(local.ptyID) : undefined
    if (entry) claimed.add(entry.data.id)
    if (options.ids && !options.ids.has(local.id)) return local
    if (!entry) {
      if (!local.ptyID || local.status === "exited" || local.status === "disconnected") return local
      return { ...local, status: "disconnected" as const }
    }
    return {
      ...local,
      ptyID: entry.data.id,
      workspaceID: entry.location.workspaceID,
      status: entry.data.status,
      title: entry.data.title,
      shell: entry.data.command,
      cwd: entry.data.cwd,
      exitCode: entry.data.exitCode,
    }
  })

  for (const entry of remote) {
    if (claimed.has(entry.data.id)) continue
    const parsed = numberFromTitle(entry.data.title)
    const titleNumber = parsed && !existingNumbers.has(parsed) ? parsed : nextNumber()
    existingNumbers.add(titleNumber)
    reconciled.push({
      id: (options.makeID ?? newTerminalClientID)(),
      ptyID: entry.data.id,
      workspaceID: entry.location.workspaceID,
      status: entry.data.status,
      title: entry.data.title,
      titleNumber,
      shell: entry.data.command,
      cwd: entry.data.cwd,
      exitCode: entry.data.exitCode,
    })
  }
  return reconciled
}

export function getWorkspaceTerminalCacheKey(dir: string, scope: ServerScopeValue = ServerScope.local) {
  return ScopedKey.from(scope, dir, WORKSPACE_KEY)
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

type TerminalSession = ReturnType<typeof createWorkspaceTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

const caches = new Set<Map<string, TerminalCacheEntry>>()

const trimTerminal = (pty: LocalPTY) => {
  if (!pty.buffer && pty.cursor === undefined && pty.scrollY === undefined) return pty
  return {
    ...pty,
    buffer: undefined,
    cursor: undefined,
    scrollY: undefined,
  }
}

function terminalPersistTarget(scope: ServerScopeValue, dir: string, legacy?: string[]) {
  return Persist.serverWorkspace(scope, dir, "terminal", legacy)
}

export function clearWorkspaceTerminals(
  dir: string,
  sessionIDs?: string[],
  platform?: Platform,
  scope: ServerScopeValue = ServerScope.local,
) {
  const key = getWorkspaceTerminalCacheKey(dir, scope)
  for (const cache of caches) {
    const entry = cache.get(key)
    entry?.value.clear()
  }

  void removePersisted(terminalPersistTarget(scope, dir), platform)

  if (scope !== ServerScope.local) return
  const legacy = new Set(getLegacyTerminalStorageKeys(dir))
  for (const id of sessionIDs ?? []) {
    for (const key of getLegacyTerminalStorageKeys(dir, id)) {
      legacy.add(key)
    }
  }
  for (const key of legacy) {
    void removePersisted({ key }, platform)
  }
}

export async function stopAllInstanceTerminals(client: DirectorySDK["client"], directory: string, clear: () => void) {
  const result = await client.v2.pty.instanceRemoveAll({ location: { directory } })
  clear()
  return result.data ?? 0
}

export async function stopWorkspaceTerminal(
  client: DirectorySDK["client"],
  directory: string,
  id: string,
  workspaceID?: string,
) {
  await client.v2.pty.remove({
    ptyID: id,
    location: { directory, ...(workspaceID ? { workspace: workspaceID } : {}) },
  })
}

export async function inspectTerminalClose(
  client: DirectorySDK["client"],
  directory: string,
  ptyID: string,
  workspaceID?: string,
): Promise<"idle" | "foreground" | "unknown"> {
  return client.v2.pty
    .activity({
      ptyID,
      location: { directory, ...(workspaceID ? { workspace: workspaceID } : {}) },
    })
    .then((response) => response.data?.data.state ?? "unknown")
    .catch(() => "unknown")
}

export async function prepareTerminalReplacement(
  client: DirectorySDK["client"],
  directory: string,
  terminal: Pick<LocalPTY, "ptyID" | "workspaceID">,
  options: CloneOptions,
  confirmClose: (state: "foreground" | "unknown") => Promise<boolean>,
  reportCloseError: (error: unknown) => void,
): Promise<"ready" | "cancelled" | "failed"> {
  if (!terminal.ptyID || options.confirmedGone) return "ready"

  const activity = await inspectTerminalClose(client, directory, terminal.ptyID, terminal.workspaceID)
  if (activity !== "idle" && !(await confirmClose(activity))) return "cancelled"
  try {
    await stopWorkspaceTerminal(client, directory, terminal.ptyID, terminal.workspaceID)
    return "ready"
  } catch (error) {
    reportCloseError(error)
    return "failed"
  }
}

function createWorkspaceTerminalSession(
  sdk: DirectorySDK,
  dir: string,
  scope: ServerScopeValue,
  reportCloseError: (error: unknown) => void,
  confirmClose: (state: "foreground" | "unknown") => Promise<boolean>,
  legacySessionID?: string,
) {
  const legacy = scope === ServerScope.local ? getLegacyTerminalStorageKeys(dir, legacySessionID) : []

  const [store, setStore, _, ready] = persisted(
    {
      ...terminalPersistTarget(scope, dir, legacy),
      migrate: migrateTerminalState,
    },
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  void ready.promise
    .then(async () => {
      const hydratedIDs = new Set(store.all.map((item) => item.id))
      const response = await sdk.client.v2.pty.instanceList({ location: { directory: sdk.directory } })
      if (disposed || !response.data) return
      setStore("all", (all) => reconcileTerminalSnapshot(all, response.data, { ids: hydratedIDs }))
      if (!store.active && store.all[0]) setStore("active", store.all[0].id)
    })
    .catch((error: unknown) => console.error("Failed to reconcile instance terminals", error))

  const pickNextTerminalNumber = () => {
    const existingTitleNumbers = new Set(
      store.all.flatMap((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return [direct]
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return []
        return [parsed]
      }),
    )

    return (
      Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
        (number) => !existingTitleNumbers.has(number),
      ) ?? 1
    )
  }

  const removeLocal = (id: string) => {
    const all = store.all
    const index = all.findIndex((x) => x.id === id)
    if (index === -1) return
    const active = store.active === id ? (index === 0 ? all[1]?.id : all[0]?.id) : store.active
    batch(() => {
      setStore("active", active)
      setStore(
        "all",
        produce((draft) => {
          draft.splice(index, 1)
        }),
      )
    })
  }

  // ⚠️ The exit CODE used to be read off this event and thrown away — every exit removed the tab,
  // including the abnormal ones, so a shell that died took the output explaining why with it. See
  // `shouldKeepExitedTab` for the rule; the short version is that exit 0 closes (what every terminal
  // does) and a failure stays put, marked, with its buffer intact.
  const unsub = sdk.event.on("pty.exited", (event: { properties: { id: string; exitCode?: number } }) => {
    const { id: ptyID, exitCode } = event.properties
    const item = store.all.find((item) => item.ptyID === ptyID)
    if (!item) return
    if (!shouldKeepExitedTab(exitCode)) {
      removeLocal(item.id)
      return
    }
    const index = store.all.findIndex((candidate) => candidate.id === item.id)
    if (index === -1) return
    setStore("all", index, (current) => ({ ...current, status: "exited", exitCode }))
  })
  onCleanup(unsub)

  const unsubDeleted = sdk.event.on("pty.deleted", (event: { properties: { id: string } }) => {
    const index = store.all.findIndex((item) => item.ptyID === event.properties.id)
    if (index === -1 || store.all[index]?.status === "exited") return
    setStore("all", index, (item) => ({ ...item, status: "disconnected" }))
  })
  onCleanup(unsubDeleted)

  // Deliberate instance disposal is stronger than one socket dropping: the server has closed the
  // entire location layer and its PTY finalizer has killed every live process tree. Reflect that
  // fact immediately instead of leaving tabs apparently running until each websocket notices EOF.
  const unsubDisposed = sdk.event.on("server.instance.disposed", () => {
    setStore("all", disconnectLiveTerminals)
  })
  onCleanup(unsubDisposed)

  const update = (client: DirectorySDK["client"], directory: string, pty: Partial<LocalPTY> & { id: string }) => {
    const index = store.all.findIndex((x) => x.id === pty.id)
    // Closing a tab removes its server PTY before Solid unmounts the terminal view. Its cleanup
    // snapshot is stale at that point and must not recreate/update a session that is already gone.
    if (index === -1) return
    const previous = store.all[index]
    setStore("all", index, (item) => ({ ...item, ...pty }))
    if (!previous?.ptyID) return
    client.v2.pty
      .update({
        ptyID: previous.ptyID,
        location: { directory, workspace: previous?.workspaceID },
        title: pty.title,
        size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
      })
      .catch((error: unknown) => {
        const currentIndex = store.all.findIndex((item) => item.id === pty.id)
        if (currentIndex >= 0) setStore("all", currentIndex, previous)
        console.error("Failed to update terminal", error)
      })
  }

  const cloning = new Set<string>()
  const clone = async (
    client: DirectorySDK["client"],
    directory: string,
    id: string,
    options: CloneOptions = {},
  ) => {
    if (cloning.has(id)) return
    cloning.add(id)
    try {
      const index = store.all.findIndex((x) => x.id === id)
      const pty = store.all[index]
      if (!pty) return

      // A manually requested replacement is an ownership transaction: a disconnected WebSocket
      // does not prove that the server PTY is dead. Keep its id until activity is inspected and
      // removal succeeds, so a failed stop/create leaves the user an actionable old tab rather
      // than an invisible shell. The automatic path passes confirmedGone only after a 404 probe.
      const replacement = await prepareTerminalReplacement(
        client,
        directory,
        pty,
        options,
        confirmClose,
        reportCloseError,
      )
      if (replacement !== "ready") return
      const oldRemoved = pty.ptyID !== undefined

      const currentIndex = store.all.findIndex((item) => item.id === id)
      if (currentIndex === -1) return
      setStore("all", currentIndex, (item) => ({ ...item, status: "starting", ptyID: undefined, exitCode: undefined }))
      const next = await client.v2.pty
        .create({
          location: { directory, workspace: pty.workspaceID },
          title: pty.title,
        })
        .catch((error: unknown) => {
          console.error("Failed to clone terminal", error)
          const currentIndex = store.all.findIndex((item) => item.id === id)
          if (currentIndex >= 0) {
            // The old id is no longer valid after a successful stop. Never resurrect it in the UI.
            setStore("all", currentIndex, oldRemoved ? { ...pty, status: "disconnected", ptyID: undefined } : pty)
          }
          return undefined
        })
      if (!next?.data?.data) return

      const createdIndex = store.all.findIndex((item) => item.id === id)
      if (createdIndex === -1) {
        // The user closed the starting tab before creation returned. Terminate the now-orphaned PTY
        // instead of leaking a process with no UI handle.
        await stopWorkspaceTerminal(client, directory, next.data.data.id, pty.workspaceID).catch(() => undefined)
        return
      }

      batch(() => {
        // Every volatile/dead-process field is cleared by the pure constructor. `setStore(path, object)`
        // MERGES, so omission here would carry an exit code or old shell through a successful clone.
        setStore("all", createdIndex, bindCreatedTerminal(pty, next.data.data))
      })
    } finally {
      cloning.delete(id)
    }
  }

  return {
    ready,
    all: createMemo(() => store.all),
    active: createMemo(() => store.active),
    clear() {
      batch(() => {
        setStore("active", undefined)
        setStore("all", [])
      })
    },
    new() {
      const nextNumber = pickNextTerminalNumber()
      const id = newTerminalClientID()
      const starting: LocalPTY = {
        id,
        status: "starting",
        title: defaultTitle(nextNumber),
        titleNumber: nextNumber,
      }
      setStore("all", store.all.length, starting)
      setStore("active", id)

      sdk.client.v2.pty
        .create({ location: { directory: sdk.directory }, title: defaultTitle(nextNumber) })
        .then(async (pty) => {
          const info = pty.data?.data
          const ptyID = info?.id
          if (!ptyID) {
            const index = store.all.findIndex((item) => item.id === id)
            if (index >= 0) setStore("all", index, (item) => ({ ...item, status: "disconnected" }))
            return
          }
          const index = store.all.findIndex((item) => item.id === id)
          if (index === -1) {
            await stopWorkspaceTerminal(sdk.client, sdk.directory, ptyID).catch(() => undefined)
            return
          }
          const newTerminal = bindCreatedTerminal(starting, info)
          setStore("all", index, newTerminal)
        })
        .catch((error: unknown) => {
          console.error("Failed to create terminal", error)
          const index = store.all.findIndex((item) => item.id === id)
          if (index >= 0) setStore("all", index, (item) => ({ ...item, status: "disconnected" }))
        })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      update(sdk.client, sdk.directory, pty)
    },
    trim(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      if (index === -1) return
      setStore("all", index, (pty) => trimTerminal(pty))
    },
    trimAll() {
      setStore("all", (all) => {
        const next = all.map(trimTerminal)
        if (next.every((pty, index) => pty === all[index])) return all
        return next
      })
    },
    async clone(id: string, options?: CloneOptions) {
      await clone(sdk.client, sdk.directory, id, options)
    },
    bind() {
      const client = sdk.client
      return {
        trim(id: string) {
          const index = store.all.findIndex((x) => x.id === id)
          if (index === -1) return
          setStore("all", index, (pty) => trimTerminal(pty))
        },
        update(pty: Partial<LocalPTY> & { id: string }) {
          update(client, sdk.directory, pty)
        },
        async clone(id: string, options?: CloneOptions) {
          await clone(client, sdk.directory, id, options)
        },
        connected(id: string) {
          const index = store.all.findIndex((item) => item.id === id)
          if (index >= 0) setStore("all", index, (item) => ({ ...item, status: "running" }))
        },
        disconnected(id: string) {
          const index = store.all.findIndex((item) => item.id === id)
          if (index >= 0 && store.all[index]?.status !== "exited")
            setStore("all", index, (item) => ({ ...item, status: "disconnected" }))
        },
        retry(id: string) {
          const index = store.all.findIndex((item) => item.id === id)
          if (index >= 0 && store.all[index]?.ptyID) setStore("all", index, (item) => ({ ...item, status: "running" }))
        },
      }
    },
    open(id: string) {
      setStore("active", id)
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      const local = store.all.find((item) => item.id === id)
      if (!local) return
      try {
        if (local.ptyID) {
          if (local.status === "running") {
            const activity = await inspectTerminalClose(sdk.client, sdk.directory, local.ptyID, local.workspaceID)
            if (activity !== "idle" && !(await confirmClose(activity))) return
          }
          await stopWorkspaceTerminal(sdk.client, sdk.directory, local.ptyID, local.workspaceID)
        }
      } catch (error) {
        // Keep the tab visible: hiding it would strand a possibly-running process with no recovery
        // handle. The connection banner can still establish that a server-confirmed 404 is gone.
        console.error("Failed to close terminal", error)
        reportCloseError(error)
        return
      }

      const index = store.all.findIndex((f) => f.id === id)
      if (index !== -1) {
        batch(() => {
          if (store.active === id) {
            const next = index > 0 ? store.all[index - 1]?.id : store.all[1]?.id
            setStore("active", next)
          }
          setStore(
            "all",
            produce((all) => {
              all.splice(index, 1)
            }),
          )
        })
      }
    },
    async stopAll() {
      return stopAllInstanceTerminals(sdk.client, sdk.directory, () => {
        batch(() => {
          setStore("active", undefined)
          setStore("all", [])
        })
      })
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const confirm = useConfirm()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()
    const scope = () => serverSDK().scope
    const directory = createMemo(() => base64Encode(sdk().directory))

    caches.add(cache)
    onCleanup(() => caches.delete(cache))

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const loadWorkspace = (dir: string, legacySessionID: string | undefined, serverScope: ServerScopeValue) => {
      // Terminals are workspace-scoped so tabs persist while switching sessions in the same directory.
      const key = getWorkspaceTerminalCacheKey(dir, serverScope)
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createWorkspaceTerminalSession(
          sdk(),
          dir,
          serverScope,
          (error) =>
            showToast({
              variant: "error",
              title: language.t("terminal.closeFailed"),
              description: String(error),
            }),
          (state) =>
            confirm({
              title: language.t("terminal.closeRunning.title"),
              description: language.t(
                state === "foreground"
                  ? "terminal.closeRunning.description"
                  : "terminal.closeRunning.unknownDescription",
              ),
              confirmLabel: language.t("terminal.closeRunning.action"),
              destructive: true,
            }),
          legacySessionID,
        ),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const workspace = createMemo(() => loadWorkspace(directory(), params.id, scope()))

    createEffect(
      on(
        () => ({ dir: directory(), id: params.id, scope: scope() }),
        (next, prev) => {
          if (!prev?.dir) return
          if (next.dir === prev.dir && next.id === prev.id && next.scope === prev.scope) return
          if (next.dir === prev.dir && next.id && next.scope === prev.scope) return
          loadWorkspace(prev.dir, prev.id, prev.scope).trimAll()
        },
        { defer: true },
      ),
    )

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: () => workspace().new(),
      update: (pty: Partial<LocalPTY> & { id: string }) => workspace().update(pty),
      trim: (id: string) => workspace().trim(id),
      trimAll: () => workspace().trimAll(),
      clone: (id: string) => workspace().clone(id),
      bind: () => workspace().bind(),
      open: (id: string) => workspace().open(id),
      close: (id: string) => workspace().close(id),
      stopAll: () => workspace().stopAll(),
      move: (id: string, to: number) => workspace().move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
