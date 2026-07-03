import { createSignal } from "solid-js"
import type { ExpertiseLevel } from "@/context/settings"

// The NovaClaw "app" model — the extensibility keystone of the home screen (the OS metaphor: the home
// is an app launcher, and built-in / plugin / AI-agent apps all register the same way). A HomeApp is a
// launchable tile: an id, a display title, a sprite icon, an accent hue for its tile, and an `open()`
// that reuses an existing opener (navigate / dialog / command). Built-in apps come from
// `useBuiltinApps()`; anything else (plugins, agent-contributed apps) calls `registerApp()`.

export interface HomeApp {
  readonly id: string
  readonly title: string
  readonly icon: string // sprite icon name (@novaclaw/ui/icon)
  readonly accent: string // CSS color for the tile gradient/glow
  readonly source: "builtin" | "plugin" | "agent"
  readonly open: () => void
  /** Renders as the 2×2 anchor tile that guides the eye (one per home — Chats). */
  readonly hero?: boolean
  /** One-line description; shown on the hero tile and in hover tooltips. */
  readonly subtitle?: string
  /** Glyph color on the tile. "dark" for light accents (gold) where white would wash out. */
  readonly glyphTone?: "light" | "dark"
  /** Hide this tile below the given expertise level (uix.md §6.4 — e.g. Terminal is Developer-only). */
  readonly minLevel?: ExpertiseLevel
}

// A plain module-level signal is the whole registry — global reactive state, no provider to wire.
// (Only computations need an owner; a bare signal does not.)
const [apps, setApps] = createSignal<readonly HomeApp[]>([])

/** The apps registered at runtime (plugins / agents). The home screen merges these after the built-ins. */
export const registeredApps = apps

// The built-in app ids are reserved — a plugin/agent app can't shadow or duplicate them. Mirrors the
// server guard (core/app-registry.ts RESERVED_IDS) so the browser path can't sneak one past it (L2).
const RESERVED_IDS = new Set(["chats", "notes", "files", "processes", "search", "terminal", "trash", "help", "settings"])

/** Register (or replace, by id) a dynamically-contributed app. */
export function registerApp(app: HomeApp): void {
  if (RESERVED_IDS.has(app.id)) {
    console.warn(`[apps] ignoring registerApp("${app.id}") — that id is reserved by a built-in app`)
    return
  }
  // `hero` (the single 2×2 gold anchor) is a built-in privilege — never let a contributed app claim it.
  const safe = app.hero ? { ...app, hero: false } : app
  setApps((prev) => [...prev.filter((a) => a.id !== safe.id), safe])
}

/** Remove a previously registered app. */
export function unregisterApp(id: string): void {
  setApps((prev) => prev.filter((a) => a.id !== id))
}
