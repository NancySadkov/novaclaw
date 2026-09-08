import { Nudge } from "@novaclaw/core/nudge"
import type { ConfigNudge } from "@novaclaw/core/config/nudge"

export type Refusal = "name" | "text" | "pattern" | "hook" | "duplicate"

const validTime = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

export function planNudgeSave(input: {
  readonly nudges: readonly ConfigNudge.Info[]
  readonly editingID?: string
  readonly draft: ConfigNudge.Info
}):
  | { readonly ok: true; readonly next: readonly ConfigNudge.Info[] }
  | { readonly ok: false; readonly reason: Refusal } {
  const draft = { ...input.draft, name: input.draft.name.trim(), text: input.draft.text.trim() }
  if (!draft.name) return { ok: false, reason: "name" }
  if (!draft.text) return { ok: false, reason: "text" }
  if (input.nudges.some((item) => item.id === draft.id && item.id !== input.editingID))
    return { ok: false, reason: "duplicate" }
  if (draft.hook.type === "text-match" && !Nudge.validPattern(draft.hook.pattern))
    return { ok: false, reason: "pattern" }
  if (
    (draft.hook.type === "tool-call" && !draft.hook.tool.trim()) ||
    (draft.hook.type === "mcp-call" && !draft.hook.server.trim()) ||
    ((draft.hook.type === "file-read" || draft.hook.type === "file-write") && !draft.hook.extension.trim()) ||
    (draft.hook.type === "time-of-day" && (!validTime(draft.hook.after) || !validTime(draft.hook.before)))
  )
    return { ok: false, reason: "hook" }
  return {
    ok: true,
    next: input.editingID
      ? input.nudges.map((item) => (item.id === input.editingID ? draft : item))
      : [...input.nudges, draft],
  }
}
