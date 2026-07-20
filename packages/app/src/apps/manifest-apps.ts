import { createEffect, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { isIconName } from "@novaclaw/ui/icon"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { loadPersistedApps, persistedManifests, type AppManifest } from "./persisted"
import type { HomeApp } from "./registry"

// Lives apart from persisted.ts so server-sync can import the DATA module (loadPersistedApps)
// without pulling the context hooks in — that would be an import cycle.

const DEFAULT_ICON = "square-arrow-top-right"
const DEFAULT_ACCENT = "#38bdf8"

/**
 * Persisted manifests as live HomeApps — openers bind to the calling component's scope. Also
 * loads the manifest list whenever the focused server changes (refetch-on-event is wired in
 * server-sync, which calls loadPersistedApps on `app.registered`).
 */
export function useManifestApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const global = useGlobal()
  const platform = usePlatform()
  const server = useServer()
  const tabs = useTabs()
  const conn = createMemo(() => server.current ?? global.servers.list()[0])

  createEffect(() => {
    const c = conn()
    if (c) void loadPersistedApps(c.http)
  })

  const open = (manifest: AppManifest) => {
    if (manifest.open.type === "route") return navigate(manifest.open.value)
    // platform.openLink, never bare window.open: on desktop it routes through the open-link
    // IPC → shell.openExternal (the user's browser, not a raw Electron child window); on web
    // it uses an anchor click that popup blockers can't silently eat.
    if (manifest.open.type === "url") return platform.openLink(manifest.open.value)
    const c = conn()
    if (!c) return
    const ctx = global.ensureServerCtx(c)
    const directory = ctx.sync.data.path.directory || ctx.sync.data.path.home
    if (!directory) return
    tabs.newDraft({ server: ServerConnection.key(c), directory }, manifest.open.value)
  }

  return () =>
    persistedManifests().map(
      (manifest): HomeApp => ({
        id: manifest.id,
        title: manifest.title,
        // Validate the agent-supplied icon against the sprite — an unknown name would render a silent
        // blank glyph, so fall back to a sensible default instead (L3).
        icon: manifest.icon && isIconName(manifest.icon) ? manifest.icon : DEFAULT_ICON,
        accent: manifest.accent || DEFAULT_ACCENT,
        ...(manifest.subtitle ? { subtitle: manifest.subtitle } : {}),
        source: "agent",
        open: () => open(manifest),
      }),
    )
}
