// The global "take me to the chat that needs me" affordance (uix-improvement slice 3): one command +
// keybind that works from ANYWHERE in the shell. Target priority: the most recently updated chat
// WAITING on the user (pending permission/question) → the most recent chat with unseen output → the
// latest chat the client knows → the Chats list. Registered from NewLayout so it is always live.
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@novaclaw/core/util/encode"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { useServerSync } from "@/context/server-sync"
import { useChatsAttentionSets } from "./chats-attention"

export function useJumpToAttention(): () => void {
  const sets = useChatsAttentionSets()
  const serverSync = useServerSync()
  const notification = useNotification()
  const navigate = useNavigate()

  return () => {
    const data = serverSync().session.data
    const updatedAt = (id: string) => {
      const time = data.info[id]?.time
      return time?.updated ?? time?.created ?? 0
    }
    const newest = (ids: readonly string[]) =>
      ids.length ? [...ids].sort((a, b) => updatedAt(b) - updatedAt(a))[0] : undefined

    let id = newest(sets().waiting) ?? newest(sets().unseen)
    // A session's directory usually comes from its resolved record; an unseen chat the store
    // hasn't resolved yet can still be routed via its notification's directory.
    let directory = id
      ? (data.info[id]?.location.directory ??
        notification.session
          .all(id)
          .findLast((item) => item.directory !== undefined)?.directory)
      : undefined

    if (!id) {
      const latest = Object.values(data.info)
        .filter((session) => !!session && !session.time.archived)
        .sort((a, b) => (b!.time.updated ?? b!.time.created) - (a!.time.updated ?? a!.time.created))[0]
      if (latest) {
        id = latest.id
        directory = latest.location.directory
      }
    }

    if (!id || !directory) {
      navigate("/chats")
      return
    }
    navigate(`/${base64Encode(directory)}/session/${id}`)
  }
}

/** Register the always-live command + keybind. Call once from the shell layout. */
export function useJumpToAttentionCommand(): void {
  const command = useCommand()
  const language = useLanguage()
  const jump = useJumpToAttention()
  command.register("chats-attention", () => [
    {
      id: "chats.jumpToAttention",
      title: language.t("command.chats.jump"),
      category: language.t("command.category.session"),
      keybind: "mod+j",
      onSelect: jump,
    },
  ])
}
