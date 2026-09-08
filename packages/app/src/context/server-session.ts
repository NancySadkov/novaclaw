import { retry } from "@novaclaw/core/util/retry"
import type {
  NovaclawClient,
  SessionV2Info as Session,
  SessionStatus,
  SessionPresenceSnapshot,
  SessionChangeDiff,
  Todo,
} from "@novaclaw/sdk/v2/client"
import { createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@novaclaw/core/util/binary"
import { isSessionWorking } from "@/context/session-working"
import { diffs as cleanDiffs } from "@/utils/diffs"
import { normalizeSessionTimes } from "@/utils/session-time"
import { rootSession } from "@/utils/session-route"
import { applyControlPatch, controlPatch } from "./global-sync/control-fold"
import * as LiveRate from "./global-sync/live-rate"
import { reportBootPhase } from "../utils/boot-phase"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import { withRequestDeadline } from "@/utils/request-deadline"

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

export function createServerSession(
  client: NovaclawClient,
  settings?: { retry?: typeof retry; requestTimeoutMs?: number },
) {
  const retryRequest = settings?.retry ?? retry
  // Live generation telemetry (Chats ps row): per-session delta accumulation lives OUTSIDE the
  // reactive store (deltas arrive at token-chunk frequency); a throttled version signal wakes
  // readers ≤ ~1.5x/sec. Cleared when the session's status settles (idle/exited).
  const liveRates = new Map<string, LiveRate.LiveRateState>()
  const [liveVersion, setLiveVersion] = createSignal(0)
  let livePending = false
  const noteLive = (sessionID: string, chars: number, source: "generation" | "compaction") => {
    let state = liveRates.get(sessionID)
    if (!state) {
      state = LiveRate.createState()
      liveRates.set(sessionID, state)
    }
    LiveRate.note(state, chars, Date.now(), source)
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
    // The tags component (notes/reports/entities-review-2026-07-06.md T0): sessionID → tags, fed by `session.tags.updated`
    // events + the /api/tag bootstrap. Organization over chats — replaces project grouping.
    tag: {} as Record<string, string[]>,
    // The presence component: sessionID → who is attached, who is driving, and whether two
    // surfaces are reaching for the chat at once. Fed by `session.presence.updated` + the
    // /api/presence bootstrap. A session absent from this map has nobody attached.
    // ⚠️ Presence deliberately does NOT carry a busy flag — `session_working` below is the one
    // answer to "is it working", and a second one that could disagree is the defect this avoids.
    session_presence: {} as Record<string, SessionPresenceSnapshot | undefined>,
    session_working(id: string) {
      return isSessionWorking(this.session_status[id])
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
    // Completion is durable while `session.status` is live-only. Folding a completed session must
    // therefore repair a missed or overwritten terminal event instead of preserving stale `busy`.
    if (session.result !== undefined) {
      setData("session_status", session.id, reconcile({ type: "exited" }))
      clearLive(session.id)
    }
    infoSeen.delete(session.id)
    infoSeen.add(session.id)
    if (infoSeen.size > sessionInfoLimit) {
      const preserve = new Set([
        ...pinned.keys(),
        ...requests.keys(),
        ...inflight.keys(),
        ...inflightDiff.keys(),
        ...inflightTodo.keys(),
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
    const request = withRequestDeadline({
      label: "Loading this session",
      timeoutMs: settings?.requestTimeoutMs,
      run: (signal) => client.v2.session.get({ sessionID }, { signal }),
    }).then((result) => {
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
    // Live-rate accumulation (Home + All Officers): every model-generated stream channel counts.
    // Tool input is where a large file-writing call arrives; compaction is a separate model stream.
    // `generatedDelta` owns that vocabulary so a future surface cannot accidentally count only the
    // prose-shaped half again.
    const generated = LiveRate.generatedDelta(event)
    if (generated) {
      if (event.type === "session.next.text.delta" || event.type === "session.next.reasoning.delta") {
        // The last phase of the boot timeline: the first generated character to
        // reach the renderer. Deliberately here rather than at a request or a status change — what
        // the measurement is for is time until the user SEES something, and only a delta proves that.
        // Repeats are dropped by the timeline itself, so this needs no guard of its own.
        reportBootPhase("first-chat-token")
      }
      noteLive(generated.sessionID, generated.chars, generated.source)
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
      case "session.presence.updated": {
        const props = event.properties as { sessionID: string; presence: SessionPresenceSnapshot }
        // `unattended` is the absence of presence, not a value worth storing — dropping the key
        // keeps "is anyone here?" a single question instead of two that can disagree.
        if (props.presence.state === "unattended") {
          setData(
            "session_presence",
            produce((draft) => void delete draft[props.sessionID]),
          )
          return
        }
        setData("session_presence", props.sessionID, reconcile(props.presence))
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
    }
  }

  // Bootstrap the instance-wide tag map (live updates arrive via `session.tags.updated`).
  const loadTags = () =>
    retryRequest(() => client.v2.session.tags.all())
      .then((result) => {
        setData("tag", reconcile((result.data?.data ?? {}) as Record<string, string[]>))
      })
      .catch(() => undefined)

  // Bootstrap who is attached where (live updates arrive via `session.presence.updated`).
  //
  // ⚠️ Resolves to whether the instance actually ANSWERED. A failed read still resolves (callers
  // `void` this), so a surface that stamps "presence as of now" on completion would vouch for rows
  // it never re-read. The Debug app's `ps` column uses this to decide between asserting attendance
  // and marking it unverified.
  const loadPresence = () =>
    retryRequest(() => client.v2.session.presence.all())
      .then((result) => {
        setData("session_presence", reconcile((result.data?.data ?? {}) as Record<string, SessionPresenceSnapshot>))
        return true
      })
      .catch(() => false)

  /**
   * Attach / heartbeat / take over / detach, in one idempotent call.
   *
   * The response IS the fresh snapshot, so the surface that called never waits for its own event
   * to come back round the bus — which is what makes a take-over feel immediate to the person who
   * pressed it and still calm on every other screen.
   */
  const reportPresence = (input: {
    sessionID: string
    viewerID: string
    label: string
    kind?: "human" | "agent" | "peer"
    writing?: boolean
    action?: "report" | "claim" | "detach"
  }) =>
    client.v2.session.presence
      .report({
        sessionID: input.sessionID,
        viewerID: input.viewerID,
        kind: input.kind ?? "human",
        label: input.label,
        ...(input.writing === undefined ? {} : { writing: input.writing }),
        action: input.action ?? "report",
      })
      .then((result) => {
        const snapshot = result.data?.data
        if (!snapshot) return undefined
        if (snapshot.state === "unattended") {
          setData(
            "session_presence",
            produce((draft) => void delete draft[input.sessionID]),
          )
          return snapshot
        }
        setData("session_presence", input.sessionID, reconcile(snapshot))
        return snapshot
      })
      .catch(() => undefined)

  return {
    data,
    set: setData,
    loadPresence,
    reportPresence,
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
        return retryRequest(() => client.v2.session.get({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          // V1-nuke slice C: the drain-end changes summary rides the native record (Session.Info.summary).
          setData(
            "session_diff",
            sessionID,
            reconcile(cleanDiffs([...(result.data?.data?.summary?.diffs ?? [])]), { key: "file" }),
          )
        })
      })
    },
    todo(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.todo[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightTodo, sessionID, () => {
        const active = generation(sessionID)
        return retryRequest(() => client.v2.session.todo({ sessionID })).then((result) => {
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
