import { createSignal } from "solid-js"

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
}

// A plain module-level signal is the whole registry — global reactive state, no provider to wire.
// (Only computations need an owner; a bare signal does not.)
const [apps, setApps] = createSignal<readonly HomeApp[]>([])

/** The apps registered at runtime (plugins / agents). The home screen merges these after the built-ins. */
export const registeredApps = apps

/** Register (or replace, by id) a dynamically-contributed app. */
export function registerApp(app: HomeApp): void {
  setApps((prev) => [...prev.filter((a) => a.id !== app.id), app])
}

/** Remove a previously registered app. */
export function unregisterApp(id: string): void {
  setApps((prev) => prev.filter((a) => a.id !== id))
}
