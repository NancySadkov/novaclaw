// The "chats wanting attention" aggregate (uix-improvement slice 2) — the one id-set behind the
// Chats launcher-tile badge (and the slice-3 needs-attention cluster). A chat wants attention when
// it is WAITING ON THE USER (a pending permission ask that auto-accept won't settle, or a pending
// question) or has unseen output. Active server only; everything reads the client stores.
import { createMemo } from "solid-js"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useServerSync } from "@/context/server-sync"
import { attentionSessionIds } from "./attention-ids"

export { attentionSessionIds } from "./attention-ids"

/** Reactive ids of chats wanting attention on the active server. */
export function useChatsAttention(): () => string[] {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  return createMemo(() => {
    const data = serverSync().session.data
    return attentionSessionIds({
      permission: data.permission,
      question: data.question,
      unseen: notification.session.unseenSessionIds(),
      countsAsk: (ask) => !permission.autoResponds(ask, data.info[ask.sessionID]?.directory),
    })
  })
}
