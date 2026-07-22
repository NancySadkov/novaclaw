import { retry } from "@novaclaw/core/util/retry"
import type {
  NovaclawClient,
  PermissionV2Request,
  QuestionRequest,
  SessionV2Info as Session,
  SessionStatus,
  SessionChangeDiff,
  Todo,
} from "@novaclaw/sdk/v2/client"
import { createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@novaclaw/core/util/binary"
import { diffs as cleanDiffs } from "@/utils/diffs"
import { normalizeSessionTimes } from "@/utils/session-time"
import { rootSession } from "@/utils/session-route"
import { applyControlPatch, controlPatch } from "./global-sync/control-fold"
import * as LiveRate from "./global-sync/live-rate"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sessionInfoLimit = 2_048

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

export function createServerSession(client: NovaclawClient, options?: { retry?: typeof retry }) {
  void options
  // Live generation telemetry (Chats ps row): per-session delta accumulation lives OUTSIDE the
  // reactive store (deltas arrive at token-chunk frequency); a throttled version signal wakes
  // readers ≤ ~1.5x/sec. Cleared when the session's status settles (idle/exited).
  const liveRates = new Map<string, LiveRate.LiveRateState>()
  const [liveVersion, setLiveVersion] = createSignal(0)
  let livePending = false
  const noteLive = (sessionID: string, chars: number) => {
    let state = liveRates.get(sessionID)
    if (!state) {
      state = LiveRate.createState()
      liveRates.set(sessionID, state)
    }
    LiveRate.note(state, chars, Date.now())
    if (!livePending) {
      livePending = true
      setTimeout(() => {
        livePending = false
        setLiveVersion((version) => version + 1)
      }, 700)
    }
  }
  const clearLive = (sessionID: string) => {
    if (!liveRates.delete(sessionID)) return
    setLiveVersion((version) => version + 1)
  }
  const [data, setData] = createStore({
    info: {} as Record<string, Session | undefined>,
    session_status: {} as Record<string, SessionStatus>,
    session_diff: {} as Record<string, SessionChangeDiff[]>,
    todo: {} as Record<string, Todo[]>,
    permission: {} as Record<string, PermissionV2Request[]>,
    question: {} as Record<string, QuestionRequest[]>,
    // The tags component (notes/entities.md T0): sessionID → tags, fed by `session.tags.updated`
    // events + the /api/tag bootstrap. Organization over chats — replaces project grouping.
    tag: {} as Record<string, string[]>,
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
    // Live ~tokens + t/s for a RUNNING agent (undefined when nothing is streaming). Reads the
    // throttled version signal, so a Chats row re-renders at the throttle cadence, not per delta.
    session_live(id: string): LiveRate.LiveRateSnapshot | undefined {
      liveVersion()
      const state = liveRates.get(id)
      if (!state) return undefined
      return LiveRate.snapshot(state, Date.now())
    },
  })
  const requests = new Map<string, Promise<Session>>()
  const inflight = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const seen = new Set<string>()
  const infoSeen = new Set<string>()
  const pinned = new Map<string, number>()
  const generations = new Map<string, object>()
  const generation = (sessionID: string) => {
    const current = generations.get(sessionID)
    if (current) return current
    const created = {}
    generations.set(sessionID, created)
    return created
  }
  const [meta, setMeta] = createStore({
    at: {} as Record<string, number | undefined>,
  })

  const remember = (input: Session) => {
    // Store-boundary contract: time fields are epoch millis (live-event payloads carry ISO
    // strings — see utils/session-time.ts).
    const session = normalizeSessionTimes(input)
    setData("info", session.id, reconcile(session))
    infoSeen.delete(session.id)
    infoSeen.add(session.id)
    if (infoSeen.size > sessionInfoLimit) {
      const preserve = new Set([
        ...pinned.keys(),
        ...requests.keys(),
        ...inflight.keys(),
        ...inflightDiff.keys(),
        ...inflightTodo.keys(),
        ...Object.entries(data.permission)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.question)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([sessionID]) => sessionID),
      ])
      for (const sessionID of preserve) {
        let current = data.info[sessionID]
        while (current) {
          preserve.add(current.id)
          current = current.parentID ? data.info[current.parentID] : undefined
        }
      }
      const stale: string[] = []
      for (const sessionID of infoSeen) {
        if (infoSeen.size - stale.length <= sessionInfoLimit) break
        if (!preserve.has(sessionID)) stale.push(sessionID)
      }
      stale.forEach((sessionID) => infoSeen.delete(sessionID))
      stale.forEach((sessionID) => generations.delete(sessionID))
      setData(
        "info",
        produce((draft) => stale.forEach((sessionID) => delete draft[sessionID])),
      )
    }
    return session
  }

  const resolve = (sessionID: string, options?: { force?: boolean }) => {
    const cached = data.info[sessionID]
    if (cached && !options?.force) return Promise.resolve(cached)
    const pending = requests.get(sessionID)
    if (pending) return pending
    const active = generation(sessionID)
    const request = client.v2.session.get({ sessionID }).then((result) => {
      const info = result.data?.data
      if (!info) throw new Error(`Session not found: ${sessionID}`)
      if (generations.get(sessionID) !== active) return info
      return remember(info)
    })
    requests.set(sessionID, request)
    const cleanup = () => {
      if (requests.get(sessionID) === request) requests.delete(sessionID)
      if (
        generations.get(sessionID) === active &&
        !data.info[sessionID] &&
        !requests.has(sessionID) &&
        !inflight.has(sessionID) &&
        !inflightDiff.has(sessionID) &&
        !inflightTodo.has(sessionID)
      )
        generations.delete(sessionID)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  const peekLineage = (sessionID: string) => {
    const session = data.info[sessionID]
    if (!session) return
    const seen = new Set([session.id])
    let root = session
    while (root.parentID) {
      if (seen.has(root.parentID)) throw new Error(`Session parent cycle: ${root.parentID}`)
      seen.add(root.parentID)
      const parent = data.info[root.parentID]
      if (!parent) return
      root = parent
    }
    return { session, root }
  }

  const evict = (sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    sessionIDs.forEach((sessionID) => {
      generations.delete(sessionID)
      requests.delete(sessionID)
      inflight.delete(sessionID)
      inflightDiff.delete(sessionID)
      inflightTodo.delete(sessionID)
    })
    setData(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          delete draft.at[sessionID]
        }
      }),
    )
  }

  const protectedSessions = () =>
    new Set([
      ...pinned.keys(),
      ...requests.keys(),
      ...inflight.keys(),
      ...inflightDiff.keys(),
      ...inflightTodo.keys(),
      ...Object.entries(data.permission)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.question)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID),
    ])

  const touch = (sessionID: string) =>
    evict(
      pickSessionCacheEvictions({ seen, keep: sessionID, limit: SESSION_CACHE_LIMIT, preserve: protectedSessions() }),
    )

  const sync = (sessionID: string, options?: { force?: boolean; messageLimit?: number }) => {
    touch(sessionID)
    return runInflight(inflight, sessionID, async () => {
      if (data.info[sessionID] && !options?.force) return
      await resolve(sessionID, options)
    })
  }

  const eventSessionID = (event: { type: string; properties?: unknown }) => {
    const properties = event.properties
    if (!properties || typeof properties !== "object") return
    if ("sessionID" in properties && typeof properties.sessionID === "string") return properties.sessionID
    if (
      "info" in properties &&
      properties.info &&
      typeof properties.info === "object" &&
      "sessionID" in properties.info &&
      typeof properties.info.sessionID === "string"
    )
      return properties.info.sessionID
    if (
      "part" in properties &&
      properties.part &&
      typeof properties.part === "object" &&
      "sessionID" in properties.part &&
      typeof properties.part.sessionID === "string"
    )
      return properties.part.sessionID
  }

  const apply = (event: { type: string; properties?: unknown }) => {
    const eventID = eventSessionID(event)
    if (eventID) {
      touch(eventID)
      if (
        !data.info[eventID] &&
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        event.type !== "session.deleted"
      )
        void resolve(eventID).catch(() => {})
    }
    // Live-rate accumulation (Chats ps row): text/reasoning stream fragments are live-only
    // events — count their chars toward the running agent's ~tokens/t-s badge. Nothing else
    // folds them here, so short-circuit after noting.
    if (event.type === "session.next.text.delta" || event.type === "session.next.reasoning.delta") {
      const props = event.properties as { sessionID?: string; delta?: string }
      if (typeof props.sessionID === "string" && typeof props.delta === "string")
        noteLive(props.sessionID, props.delta.length)
      return
    }
    // P2 (ui-arch-hardening): fold V2 CONTROL events into the cached record so open views stay
    // live (an uncached record was already queued for a fetch above, which returns fresh).
    const control = controlPatch(event)
    if (control && data.info[control.sessionID]) {
      setData(
        "info",
        control.sessionID,
        produce((draft) => {
          if (draft) applyControlPatch(draft, control.patch)
        }),
      )
      return
    }
    switch (event.type) {
      case "session.created":
        remember((event.properties as { info: Session }).info)
        return
      case "session.updated": {
        const info = (event.properties as { info: Session }).info
        remember(info)
        if (info.time.archived) evict([info.id])
        return
      }
      case "session.deleted": {
        const sessionID = (event.properties as { info: Session }).info.id
        infoSeen.delete(sessionID)
        setData(
          "info",
          produce((draft) => void delete draft[sessionID]),
        )
        evict([sessionID])
        return
      }
      case "session.tags.updated": {
        const props = event.properties as { sessionID: string; tags: string[] }
        setData("tag", props.sessionID, [...props.tags])
        return
      }
      case "session.diff": {
        const props = event.properties as { sessionID: string; diff: SessionChangeDiff[] }
        setData("session_diff", props.sessionID, reconcile(cleanDiffs(props.diff), { key: "file" }))
        return
      }
      case "todo.updated": {
        const props = event.properties as { sessionID: string; todos: Todo[] }
        setData("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
        return
      }
      case "session.status": {
        const props = event.properties as { sessionID: string; status: SessionStatus }
        setData("session_status", props.sessionID, reconcile(props.status))
        // The run settled — drop its live-rate tracker so the ps badge clears with the spinner.
        if (props.status.type === "idle" || props.status.type === "exited") clearLive(props.sessionID)
        return
      }
      // F1e S6: native `permission.v2.*` vocab; the V1 projection is ignored (retires in S7).
      case "permission.v2.asked": {
        const permission = event.properties as PermissionV2Request
        const permissions = data.permission[permission.sessionID]
        if (!permissions) {
          setData("permission", permission.sessionID, [permission])
          return
        }
        const result = Binary.search(permissions, permission.id, (item) => item.id)
        if (result.found) setData("permission", permission.sessionID, result.index, reconcile(permission))
        if (!result.found)
          setData(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(result.index, 0, permission)),
          )
        return
      }
      case "permission.v2.replied": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "permission",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
        return
      }
      case "question.asked": {
        const question = event.properties as QuestionRequest
        const questions = data.question[question.sessionID]
        if (!questions) {
          setData("question", question.sessionID, [question])
          return
        }
        const result = Binary.search(questions, question.id, (item) => item.id)
        if (result.found) setData("question", question.sessionID, result.index, reconcile(question))
        if (!result.found)
          setData(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(result.index, 0, question)),
          )
        return
      }
      case "question.replied":
      case "question.rejected": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "question",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
      }
    }
  }

  // Bootstrap the instance-wide tag map (live updates arrive via `session.tags.updated`).
  const loadTags = () =>
    retry(() => client.v2.session.tags.all())
      .then((result) => {
        setData("tag", reconcile((result.data?.data ?? {}) as Record<string, string[]>))
      })
      .catch(() => undefined)

  return {
    data,
    set: setData,
    get: (sessionID: string) => data.info[sessionID],
    peek: (sessionID: string) => data.info[sessionID],
    remember,
    resolve,
    loadTags,
    lineage: {
      peek: peekLineage,
      async resolve(sessionID: string) {
        const session = await resolve(sessionID)
        return { session, root: await rootSession(session, resolve) }
      },
    },
    sync,
    fresh(sessionID: string, ttl: number) {
      return Date.now() - (meta.at[sessionID] ?? 0) <= ttl
    },
    diff(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.session_diff[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightDiff, sessionID, () => {
        const active = generation(sessionID)
        return retry(() => client.v2.session.get({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          // V1-nuke slice C: the drain-end changes summary rides the native record (Session.Info.summary).
          setData("session_diff", sessionID, reconcile(cleanDiffs([...(result.data?.data?.summary?.diffs ?? [])]), { key: "file" }))
        })
      })
    },
    todo(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.todo[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightTodo, sessionID, () => {
        const active = generation(sessionID)
        return retry(() => client.v2.session.todo({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          setData("todo", sessionID, reconcile([...(result.data?.data ?? [])], { key: "id" }))
        })
      })
    },
    evict(sessionID: string) {
      if (protectedSessions().has(sessionID)) return
      seen.delete(sessionID)
      evict([sessionID])
    },
    pin(sessionID: string) {
      pinned.set(sessionID, (pinned.get(sessionID) ?? 0) + 1)
      touch(sessionID)
    },
    unpin(sessionID: string) {
      const count = pinned.get(sessionID)
      if (!count || count === 1) pinned.delete(sessionID)
      if (count && count > 1) pinned.set(sessionID, count - 1)
    },
    apply,
  }
}

export type ServerSession = ReturnType<typeof createServerSession>
