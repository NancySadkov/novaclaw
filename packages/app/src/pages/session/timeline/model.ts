import type { SessionMessage, SessionMessageUser } from "@novaclaw/sdk/v2/client"
import { createMemo, createResource, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { selectVisibleMessages } from "@/pages/session/revert-view"
import { same } from "@/utils/same"

const emptyUserMessages: SessionMessageUser[] = []

/**
 * F1e S5: the session timeline model is native. User-message navigation
 * (`userMessages` / `visibleUserMessages` / `lastUserMessage`) and the render gate
 * (`ready` / `resource`) read the native `SessionMessage[]` store
 * (`serverSync().nativeMessages`), not the retired V1 `data.message` store. The
 * `resource` load is what flips `ready` true so the timeline mounts; the native
 * timeline then reconciles via its own idempotent `.load()`. History pagination is
 * deferred (native long-session hardening) — `history.loadOlder` is a no-op and
 * `loadOlderTimeline` below stays for when cursor pagination is wired.
 */
export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()

  const [resource] = createResource(
    () => input.sessionID(),
    async (id) => {
      if (!id) return
      // Degrade, never dead-end: an errored resource RETHROWS at every read, and this one is
      // read in the session shell — an auth/network failure here used to nuke the whole app
      // onto the root ErrorPage (observed live 2026-07-21 via a stale-credential 401). The
      // timeline renders empty and the reconnect/auth surfaces own the story instead.
      await serverSync()
        .nativeMessages.load(id)
        .catch((error) => console.error("timeline message load failed", { sessionID: id, error }))
    },
  )

  const messages = createMemo<readonly SessionMessage[]>(() => {
    const id = input.sessionID()
    return id ? (serverSync().nativeMessages.messages(id) ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || serverSync().nativeMessages.messages(id) !== undefined
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => selectVisibleUserMessages(userMessages(), input.revertMessageID()),
    emptyUserMessages,
    { equals: same },
  )

  return {
    history: {
      loadOlder: async (_options?: { before?: () => void; after?: (done: boolean) => void }) => {},
      loading: () => false,
      more: () => false,
    },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    resource,
    userMessages,
    visibleUserMessages,
  }
}

export function selectUserMessages(messages: readonly SessionMessage[]) {
  return messages.filter((message): message is SessionMessageUser => message.type === "user")
}

/**
 * User-message navigation under a staged revert. Delegates to the shared rule in
 * `session/revert-view.ts` — the transcript, the dock and the `/undo` commands all read that ONE
 * partition, so a message can never be hidden here while still drawn there (the 2026-07-29 bug).
 */
export function selectVisibleUserMessages(messages: readonly SessionMessageUser[], revertMessageID?: string) {
  return selectVisibleMessages(messages, revertMessageID)
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  await input.loadMore(id).catch((error) => {
    if (input.sessionID() === id) input.after?.(true)
    throw error
  })
  if (input.sessionID() !== id) return
  input.after?.(true)
}
