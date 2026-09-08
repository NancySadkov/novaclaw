import { createMemo } from "solid-js"
import { useNotification } from "@/context/notification"
import { attentionSessionIds } from "./attention-ids"

export { attentionSessionIds } from "./attention-ids"

/** Reactive ids of chats with unseen output on the active server. */
export function useChatsAttention(): () => string[] {
  const notification = useNotification()
  return createMemo(() => attentionSessionIds({ unseen: notification.session.unseenSessionIds() }))
}
