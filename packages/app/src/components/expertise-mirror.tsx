import type { Config } from "@novaclaw/sdk/v2/client"
import { createEffect } from "solid-js"
import type { Component } from "solid-js"
import { useSettings } from "@/context/settings"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"

// T9 (uix.md §6c): mirror the client expertise level into the ACTIVE instance's config so the
// server side (the runner's plain-language hint) can meet the user at their level. Best-effort,
// last-writer-wins across devices; re-runs on level change and when the server's bootstrap
// settles. Deliberately self-sufficient (global.ensureServerCtx, the server-sdk memo's own path)
// so it mounts at the ConnectionGate — NOT inside the server-sync createRoot (no provider tree
// there; that placement crashed the whole app at boot) and NOT via useServerSync (the sync
// provider is route-scoped and absent at the gate).
export const ExpertiseMirror: Component = () => {
  const settings = useSettings()
  const global = useGlobal()
  const server = useServer()

  createEffect(() => {
    const level = settings.general.expertiseLevel()
    const conn = server.current
    if (!conn) return
    const sync = global.ensureServerCtx(conn).sync
    if (!sync.data.ready) return
    if ((sync.data.config as { expertise?: string }).expertise === level) return
    void sync.updateConfig({ expertise: level } as Config).catch(() => {})
  })

  return null
}
