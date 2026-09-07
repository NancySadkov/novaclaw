import type { Config, NovaclawClient, Path, SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@novaclaw/core/util/path"
import { retry } from "@novaclaw/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError, isUnreachableError, isMissingDirectoryError } from "@/utils/server-errors"
import type { Translator } from "@/context/language"
import { CancelledError, QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@novaclaw/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { afterFirstPaint } from "@/utils/after-first-paint"
import type { InitError } from "@/pages/error"

// ⚠️ Structurally matched to `context/server-sync.tsx`'s `GlobalStore`, `error` included: that file
// hands `setBootStore` in as `setGlobalStore`, so the two are compared by shape and MUST move
// together. Narrow one alone and you get TS2719 — "two different types with this name exist, but
// they are unrelated" — which is how the dead `"complete"` arm below was found.
type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  provider: NormalizedProviderListResponse
  config: Config
  reload: undefined | "pending"
}

/**
 * The 50 ms cap is this call site's own requirement, not a third spelling of the deferral: boot must
 * not wait indefinitely on a frame a visible-but-not-yet-painting window has not produced.
 */
function waitForPaint() {
  return new Promise<void>((resolve) => {
    afterFirstPaint(resolve, { timeoutMs: 50 })
  })
}

// A TanStack cancellation is not a failure: the SSE-reconnect recovery invalidates a scope with
// cancelRefetch, which cancels any in-flight fetch before re-running it — surfacing that as an
// error toast would report the RECOVERY as a fault.
export function isCancelledError(error: unknown) {
  return error instanceof CancelledError
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason)
    .filter((reason) => !isCancelledError(reason))
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: Translator
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: NovaclawClient) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: ({ signal }) => retry(() => sdk.global.config.get({ signal }).then((x) => x.data!)),
  })

/**
 * Readiness is "the global bootstrap FINISHED **and** SUCCEEDED" — the two are not the same thing.
 * Every `GlobalStore` getter in `context/server-sync.tsx` falls back to a private EMPTY literal when
 * its query holds no data, so a settled-but-failed boot is byte-for-byte indistinguishable from an
 * instance that genuinely has no providers, no config and no path. Splitting them is what stops the
 * app declaring itself ready over a config it never loaded.
 */
export function globalReady(input: { pending: boolean; error: InitError | undefined }) {
  return !input.pending && !input.error
}

/**
 * The store field is typed `InitError` because `pages/error.tsx` already knows how to render that
 * shape — a named server fault (which arrives as `{name, data}`, sometimes wrapped in a fetch
 * `Error`'s `cause.body`) keeps its structure and its issue list; anything else is carried as the
 * readable message `formatServerError` produces, under the `UnknownError` name that file formats.
 */
function toInitError(error: unknown, translate: Translator): InitError {
  const body =
    error instanceof Error && error.cause && typeof error.cause === "object" && "body" in error.cause
      ? (error.cause as { body: unknown }).body
      : error
  if (body && typeof body === "object" && "name" in body && "data" in body) {
    const candidate = body as { name: unknown; data: unknown }
    if (typeof candidate.name === "string" && typeof candidate.data === "object" && candidate.data !== null) {
      return { name: candidate.name, data: candidate.data as Record<string, unknown> }
    }
  }
  return { name: "UnknownError", data: { message: formatServerError(error, translate) } }
}

export async function bootstrapGlobal(input: {
  serverSDK: NovaclawClient
  scope: ServerScope
  requestFailedTitle: string
  translate: Translator
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK)),
  ]
  const slowErrs = errors(await runAll(slow))
  // A boot that succeeds after a failed one must CLEAR the verdict, or a healed instance stays
  // not-ready forever — `updateConfig` refetches this query precisely so a repair can take effect.
  if (slowErrs.length === 0) {
    input.setGlobalStore("error", undefined)
    return
  }
  input.setGlobalStore("error", toInitError(slowErrs[0], input.translate))
  console.error("Failed to bootstrap instance globals", slowErrs[0])
  // 🔴 A liveness fact is told ONCE, by the surface that owns liveness. These three fetches go out
  // together on every (re)connect, so an instance that is momentarily not there fails all three and
  // used to raise "Request failed — Failed to fetch (+2 more)": one fact, three times, as an error
  // the user can do nothing about, while the connection screen and banner were already saying it in
  // words that promise recovery. A server that ANSWERED with a fault still toasts — that is
  // something the user can act on, and `globalStore.error` alone would only reach the error page.
  if (slowErrs.every(isUnreachableError)) return
  showErrors({
    errors: slowErrs,
    title: input.requestFailedTitle,
    translate: input.translate,
    formatMoreCount: input.formatMoreCount,
  })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

export function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: NovaclawClient
  signal?: AbortSignal
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.v2.session.get({ sessionID }, { signal: input.signal })).then((x) => {
        const session = x.data?.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, sdk: NovaclawClient) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: ({ signal }) =>
      retry(() => sdk.provider.list(undefined, { signal }).then((x) => normalizeProviderList(x.data!))),
  })

export const loadAgentsQuery = (scope: ServerScope, directory: string | null, sdk: NovaclawClient) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: ({ signal }) => retry(() => sdk.app.agents(undefined, { signal }).then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, sdk: NovaclawClient) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: ({ signal }) => retry(() => sdk.path.get(undefined, { signal }).then((x) => x.data!)),
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: NovaclawClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: Translator
  global: {
    config: Config
    path: Path
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
  onDirectoryMissing?: (directory: string) => void
  signal?: AbortSignal
}) {
  if (input.signal?.aborted) return
  const wasMissing = input.store.status === "missing"
  const loading = input.store.status !== "complete"
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  // Seed the QUERY cache, never the store: `State.path` is a getter over the per-directory
  // path query (child-store.ts), so a store write can't land — Solid merges it into the
  // query's own store proxy instead, which is exactly the dev "Cannot mutate a Store
  // directly" warn with the write silently swallowed. setQueryData is what the getter reads.
  if (seededPath) {
    const pathOptions = loadPathQuery(input.scope, input.directory, input.sdk)
    if (!input.queryClient.getQueryData(pathOptions.queryKey)) {
      input.queryClient.setQueryData(pathOptions.queryKey, seededPath)
    }
  }
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading && !wasMissing) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  return (async () => {
    if (!seededPath) {
      try {
        const response = await input.sdk.path.get(undefined, { signal: input.signal })
        const path = response.data
        if (input.signal?.aborted) return
        if (path) input.queryClient.setQueryData(loadPathQuery(input.scope, input.directory, input.sdk).queryKey, path)
        if (wasMissing) input.setStore("status", "partial")
      } catch (error) {
        if (isCancelledError(error) || isAbortError(error) || input.signal?.aborted) return
        if (isMissingDirectoryError(error)) {
          input.setStore("status", "missing")
          if (!wasMissing) {
            if (input.onDirectoryMissing) input.onDirectoryMissing(input.directory)
            if (!input.onDirectoryMissing)
              showToast({
                title: input.translate("toast.project.directoryMissing.title"),
                description: input.translate("toast.project.directoryMissing.description", {
                  directory: input.directory,
                }),
              })
          }
          return
        }
        console.error("Failed to check project directory", error)
        showToast({
          variant: "error",
          title: input.translate("toast.project.reloadFailed.title", { project: getFilename(input.directory) }),
          description: formatServerError(error, input.translate),
        })
        return
      }
    }

    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient
          .ensureQueryData(loadAgentsQuery(input.scope, input.directory, input.sdk))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(() =>
          input.sdk.config.get(undefined, { signal: input.signal }).then((x) => {
            if (!input.signal?.aborted) input.setStore("config", reconcile(x.data!, { merge: false }))
          }),
        ),
      () =>
        retry(() =>
          input.sdk.v2.session.active({ signal: input.signal }).then(async (x) => {
            if (input.signal?.aborted) return
            // Native /active reports {type:"running"}; the store vocabulary is "busy".
            const activeIDs = Object.keys(x.data?.data ?? {})
            if (input.session) {
              await Promise.all(
                activeIDs.map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
              )
              // `/active` is an in-memory drain snapshot. A terminal drain can remain in it while
              // post-run cleanup unwinds; the durable result outranks that transient overlap.
              const statuses: Record<string, { type: "busy" }> = Object.fromEntries(
                activeIDs
                  .filter((sessionID) => input.session!.get(sessionID)?.result === undefined)
                  .map((sessionID) => [sessionID, { type: "busy" as const }]),
              )
              input.session.set(
                "session_status",
                produce((draft) => {
                  for (const sessionID of Object.keys(draft)) {
                    if (statuses[sessionID]) continue
                    if (input.session?.get(sessionID)?.location.directory === input.directory) delete draft[sessionID]
                  }
                }),
              )
              for (const [sessionID, status] of Object.entries(statuses)) {
                input.session.set("session_status", sessionID, reconcile(status))
              }
            }
            if (!input.session)
              input.setStore(
                "session_status",
                Object.fromEntries(activeIDs.map((sessionID) => [sessionID, { type: "busy" as const }])),
              )
          }),
        ),
      () =>
        retry(() =>
          // `/api/vcs` — the branch badge's source, wrapped `{ location, data }` like every other
          // contract route since the family moved there on 2026-09-03.
          input.sdk.v2.vcs.get(undefined, { signal: input.signal }).then((x) => {
            if (input.signal?.aborted) return
            const next = x.data?.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      input.mcp &&
        (() =>
          retry(() =>
            input.sdk.command.list(undefined, { signal: input.signal }).then((x) => {
              if (!input.signal?.aborted) input.setStore("command", x.data ?? [])
            }),
          )),
      input.mcp && (() => input.queryClient.fetchQuery(loadMcpQuery(input.scope, input.directory, input.sdk))),
      () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, input.directory, input.sdk)),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow)).filter((error) => !isAbortError(error))
    if (input.signal?.aborted) return
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}
