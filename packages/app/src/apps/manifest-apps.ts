import { createEffect, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { manifestRoutePath } from "@novaclaw/core/app-route"
import { isIconName } from "@novaclaw/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { appName, appSubtitle, type Translate } from "./app-label"
import { unshadowedManifests } from "./manifest-shadow"
import { loadPersistedApps, persistedManifests, type AppManifest } from "./persisted"
import type { HomeApp } from "./registry"
import { scopedDirectory } from "@/utils/routing-directory"

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
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const tabs = useTabs()
  const conn = createMemo(() => server.current ?? global.servers.list()[0])

  // Agent-contributed apps go through the SAME label path as the built-ins: if this build happens to
  // ship `home.app.<id>.*` for one, it translates; otherwise the manifest's own words are used. An
  // agent is never required to have a key in our bundles, and a manifest whose title is blank or is
  // itself an i18n key degrades to a legible name derived from the id rather than rendering raw.
  const t: Translate = (key, params) => language.t(key as Parameters<typeof language.t>[0], params)

  createEffect(() => {
    const c = conn()
    if (c) void loadPersistedApps(c.http, ServerConnection.key(c))
  })

  const open = (manifest: AppManifest) => {
    if (manifest.open.type === "route") {
      const route = manifestRoutePath(manifest.open.value)
      if (!route) {
        console.warn(`[apps] ignoring unavailable manifest route id "${manifest.open.value}"`)
        return
      }
      return navigate(route)
    }
    // platform.openLink, never bare window.open: on desktop it routes through the open-link
    // IPC → shell.openExternal (the user's browser, not a raw Electron child window); on web
    // it uses an anchor click that popup blockers can't silently eat.
    if (manifest.open.type === "url") return platform.openLink(manifest.open.value)
    const c = conn()
    if (!c) return
    const ctx = global.ensureServerCtx(c)
    const directory = scopedDirectory(ctx.sync.data.path)
    if (!directory) return
    tabs.newDraft({ server: ServerConnection.key(c), directory }, manifest.open.value)
  }

  return () =>
    unshadowedManifests(persistedManifests(conn() ? ServerConnection.key(conn()!) : undefined)).map(
      (manifest): HomeApp => {
        const subtitle = appSubtitle(t, manifest.id, manifest.subtitle)
        const icon = manifest.icon && isIconName(manifest.icon) ? manifest.icon : undefined
        return {
          id: manifest.id,
          title: appName(t, manifest.id, manifest.title),
          // Validate the agent-supplied icon against the sprite — an unknown name would render a silent
          // blank glyph, so fall back to a sensible default instead (L3).
          icon: icon ?? DEFAULT_ICON,
          accent: manifest.accent || DEFAULT_ACCENT,
          // A manifest that customized NOTHING (no valid icon, no accent) gets the UI kit's generic
          // app artwork so it sits in the launcher's visual language; one that chose an icon or accent
          // keeps the gradient tile — its customization stays visible.
          ...(icon || manifest.accent ? {} : { tile: "/assets/skin/tiles/generic_app.png" }),
          ...(subtitle ? { subtitle } : {}),
          source: manifest.source ?? "agent",
          open: () => open(manifest),
        }
      },
    )
}
