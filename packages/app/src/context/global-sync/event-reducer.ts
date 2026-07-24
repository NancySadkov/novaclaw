import { Binary } from "@novaclaw/core/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  PermissionV2Request,
  QuestionRequest,
  SessionV2Info as Session,
  SessionStatus,
  SessionChangeDiff,
  Todo,
} from "@novaclaw/sdk/v2/client"
import type { State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { diffs as list } from "@/utils/diffs"
import { normalizeSessionTimes } from "@/utils/session-time"

const SESSION_CONTENT_EVENTS = new Set([
  "session.diff",
  "todo.updated",
  "session.status",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
])

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  refresh: () => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
  }
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  for (const sessionID of stale) {
    setSessionTodo?.(sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  vcsCache?: VcsCache
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  retainedLimit?: number
  sessionContent?: boolean
  permission?: State["permission"]
}) {
  const event = input.event
  if (input.sessionContent === false && SESSION_CONTENT_EVENTS.has(event.type)) return
  const limit = Math.max(input.store.limit, input.retainedLimit ?? 0)
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    case "session.created": {
      // Store-boundary contract: time fields are epoch millis (live-event payloads carry ISO
      // strings — see utils/session-time.ts).
      const info = normalizeSessionTimes((event.properties as { info: Session }).info)
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit, permission: input.permission ?? input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = normalizeSessionTimes((event.properties as { info: Session }).info)
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (input.store.session[result.index]!.time.archived === info.time.archived) break
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit, permission: input.permission ?? input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.next.moved": {
      // The composer's folder chip migrates a chat to a new directory via moveSession → this control
      // event. The id-keyed record store folds it (control-fold), but this PER-DIRECTORY list must
      // too: otherwise the OLD folder's store keeps a copy carrying the stale directory while the NEW
      // folder's store holds the fresh one, and the Chats list — which dedups by directory+id —
      // renders the chat TWICE, one row per folder (owner-hit 2026-07-24). Folding the move's new
      // location onto our copy converges the two copies to the same directory so the dedup collapses
      // them to one row. Fanned to every open directory store by the dispatcher, so whichever store
      // holds the stale copy gets corrected regardless of which directory the event was stamped with.
      const props = event.properties as {
        sessionID?: string
        location?: { directory?: string }
        subdirectory?: string
      }
      if (!props.sessionID || !props.location?.directory) break
      const result = Binary.search(input.store.session, props.sessionID, (s) => s.id)
      if (!result.found) break
      input.setStore(
        "session",
        result.index,
        produce((draft) => {
          draft.location = props.location as Session["location"]
          ;(draft as unknown as Record<string, unknown>).subpath = props.subdirectory ?? undefined
        }),
      )
      break
    }
    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: SessionChangeDiff[] }
      input.setStore("session_diff", props.sessionID, reconcile(list(props.diff), { key: "file" }))
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      input.setSessionTodo?.(props.sessionID, props.todos)
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    // F1e S5/S7: the native SessionMessage store (`serverSync().nativeMessages`, fed from
    // `session.next.*`) is the sole transcript path — the server no longer emits a translated
    // V1 `message.*` vocabulary at all (the bridge projections retired in S7).
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    // F1e S6: the app folds the native `permission.v2.*` vocab (raw EventV2 stream); the
    // V1 `permission.asked/replied` projection is ignored here and retires in S7.
    case "permission.v2.asked": {
      const permission = event.properties as PermissionV2Request
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.v2.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
  }
}
