import type { SessionMessage, SessionMessageUser } from "@novaclaw/sdk/v2/client"
import { createEffect, createMemo, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { selectVisibleMessages } from "@/pages/session/revert-view"
import { same } from "@/utils/same"

const emptyUserMessages: SessionMessageUser[] = []

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()

  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    void serverSync()
      .nativeMessages.load(id)
      .catch((error) => console.error("timeline message load failed", { sessionID: id, error }))
  })

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
