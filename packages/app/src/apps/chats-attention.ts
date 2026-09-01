// The "chats wanting attention" aggregate (uix-improvement slice 2) — the one id-set behind the
// Chats launcher-tile badge (and the slice-3 needs-attention cluster). A chat wants attention when
// it is WAITING ON THE USER (a pending question) or has unseen output. Active server only;
// everything reads the client stores.
import { createMemo } from "solid-js"
import { useNotification } from "@/context/notification"
import { useServerSync } from "@/context/server-sync"
import { attentionSets } from "./attention-ids"

export { attentionSessionIds, attentionSets } from "./attention-ids"

/** Reactive attention tiers (waiting-on-user · unseen) for the active server. */
export function useChatsAttentionSets(): () => { waiting: string[]; unseen: string[] } {
  const serverSync = useServerSync()
  const notification = useNotification()
  return createMemo(() => {
    const data = serverSync().session.data
    return attentionSets({
      question: data.question,
      unseen: notification.session.unseenSessionIds(),
    })
  })
}

/** Reactive ids of chats wanting attention on the active server (both tiers, deduped). */
export function useChatsAttention(): () => string[] {
  const sets = useChatsAttentionSets()
  return createMemo(() => [...sets().waiting, ...sets().unseen])
}
