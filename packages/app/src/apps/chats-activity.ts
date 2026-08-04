// What the Chats hero tile says about itself while agents are working (owner 2026-07-26).
//
// The tile used to carry a fixed tagline. A launcher tile has room to be USEFUL: how many agents are
// running right now, and how fast they are producing. Both numbers already exist per session —
// `session_working` for the status and `session_live` for the client-side ~tokens/sec — so this only
// aggregates them; nothing new is measured or fetched.
import { createMemo } from "solid-js"
import { useServerSync } from "@/context/server-sync"

export interface ChatsActivity {
  /** Sessions whose agent is running right now. */
  readonly running: number
  /** Combined ~tokens/sec across those sessions; 0 when every stream has gone quiet. */
  readonly tps: number
}

/** Reactive running-count + combined throughput for the active server. */
export function useChatsActivity(): () => ChatsActivity {
  const serverSync = useServerSync()
  return createMemo(() => {
    const session = serverSync().session
    const ids = Object.keys(session.data.info)
    let running = 0
    let tps = 0
    for (const id of ids) {
      if (!session.data.session_working(id)) continue
      running += 1
      tps += session.data.session_live(id)?.tps ?? 0
    }
    return { running, tps: Math.round(tps) }
  })
}

/**
 * The one line the hero shows. Undefined when nothing is running, so the tile falls back to its subtitle
 * rather than announcing "0 running" — a launcher should be quiet when there is nothing to report.
 */
export function activityLabel(activity: ChatsActivity): string | undefined {
  if (activity.running === 0) return undefined
  const agents = `${activity.running} ${activity.running === 1 ? "agent" : "agents"} working`
  // A running agent that is between steps (a tool call, say) legitimately reports 0 t/s — showing
  // "· 0 t/s" would read as stalled, so the rate is only added once there is one.
  return activity.tps > 0 ? `${agents} · ~${activity.tps} t/s` : agents
}
