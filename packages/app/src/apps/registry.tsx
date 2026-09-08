import { createSignal } from "solid-js"
import type { ExpertiseLevel } from "@/context/settings"
import { legibleAppName } from "./app-label"

// The NovaClaw "app" model — the extensibility keystone of the home screen (the OS metaphor: the home
// is an app launcher, and built-in / plugin / AI-agent apps all register the same way). A HomeApp is a
// launchable tile: an id, a display title, a sprite icon, an accent hue for its tile, and an `open()`
// that reuses an existing opener (navigate / dialog / command). Built-in apps come from
// `useBuiltinApps()`; anything else (plugins, agent-contributed apps) calls `registerApp()`.
//
// ⚠️ WORDS: `title` and `subtitle` are ALREADY-RESOLVED display text, never i18n keys. The registry
// deliberately does not resolve keys for you, because it has to serve apps we did not write:
//
//   built-in / agent-manifest   `builtins.tsx` and `manifest-apps.ts` resolve `home.app.<id>.*`
//                               through `app-label.ts` before they get here, so they translate.
//   plugin (`registerApp`)      supplies its own words. A plugin needs NO key in our bundles — and
//                               if it passes one anyway, `registerApp` replaces it (below) so the
//                               user never sees `home.app.foo.name` on a tile.
//
// A plugin that wants to follow the language picker re-registers on locale change; `registerApp`
// replaces by id, so that is a supported one-liner rather than a special case.

export interface HomeApp {
  readonly id: string
  /** Display text, already translated. NOT an i18n key — see the WORDS note above. */
  readonly title: string
  readonly icon: string // sprite icon name (@novaclaw/ui/v2/icon)
  readonly accent: string // CSS color for the tile gradient/glow
  /**
   * Finished tile artwork (URL) from the NOVA UI kit — a complete purple/gold app icon that replaces
   * the generated gradient+glyph square. Built-ins ship one; contributed apps without artwork keep
   * the gradient recipe, so `icon`/`accent` stay the fallback and the registry needs no asset.
   */
  readonly tile?: string
  /** The tile URL is a transparent foreground glyph; paint the launcher's standard frame behind it. */
  readonly tileNeedsFrame?: boolean
  readonly source: "builtin" | "plugin" | "agent"
  readonly open: () => void
  /** Renders as the 2×2 anchor tile that guides the eye (one per home — Tasks). */
  readonly hero?: boolean
  /** One-line description, already translated; shown on the hero tile and in hover tooltips. */
  readonly subtitle?: string
  /** Glyph color on the tile. "dark" for light accents (gold) where white would wash out. */
  readonly glyphTone?: "light" | "dark"
  /** Hide this tile below the given expertise level (uix.md §6.4 — e.g. Terminal is Developer-only). */
  readonly minLevel?: ExpertiseLevel
  /**
   * Reactive attention count for the tile's badge (evaluated in the tile's render scope, so it
   * may close over signals/memos). Render a badge when > 0 — the iOS vocabulary for "this app
   * wants you". Built-in example: Tasks = threads with a pending question or unseen output.
   */
  readonly badge?: () => number | undefined
  /**
   * The HERO tile's readout: a few live numbers instead of a tagline (owner, 2026-08-13 — the tile
   * reports system load, and carries no app label because the artwork already names the app).
   *
   * Hero-only, like `hero` itself: `registerApp` strips `hero` from contributed apps, so a plugin
   * cannot claim this surface either. Reactive — evaluated in the tile's render scope.
   */
  readonly stats?: () => readonly HeroStat[]
}

/** One number on the hero tile: a short value, the word under it, and how alarmed to look. */
export interface HeroStat {
  readonly id: string
  /** Already formatted and localized — "3", "47", "63%", or an em dash when unknown. */
  readonly value: string
  /** The word under the value, already translated ("running", "tokens/s", "memory"). */
  readonly label: string
  /** `idle` dims a zero so the eye skips it; `warn` is the instance's own pressure verdict. */
  readonly tone?: "idle" | "warn"
}

// A plain module-level signal is the whole registry — global reactive state, no provider to wire.
// (Only computations need an owner; a bare signal does not.)
const [apps, setApps] = createSignal<readonly HomeApp[]>([])

/** The apps registered at runtime (plugins / agents). The home screen merges these after the built-ins. */
export const registeredApps = apps

// The built-in app ids are reserved — a plugin/agent app can't shadow or duplicate them. Mirrors the
// server guard (core/app-registry.ts RESERVED_IDS) so the browser path can't sneak one past it (L2).
//
// ⚠️ **The mirror is the point: fix both halves or neither.** This one guards the in-process
// `registerApp` a plugin calls directly; the core one guards the HTTP/tool path. An id reserved on
// only one side is squattable through the other, which is how `debug` — the tile a user reaches
// when the product is ALREADY broken — was open to a plugin until 2026-07-29. The lists live in
// different packages and the renderer cannot import the core module (it reaches `node:fs`), so
// they cannot be one constant; `packages/core/test/app-reserved-ids.test.ts` reads both files and
// fails on any divergence, and on any built-in tile that is not listed.
const RESERVED_IDS = new Set([
  "tasks",
  // Retired id of the tile now called `tasks` (2026-08-13) — reserved, like `processes`/`search`.
  "chats",
  "notes",
  "files",
  "processes",
  "registry",
  "debug",
  // The roster (AGENTS.md — the structural metaphor). Reserved on both sides before it can be
  // squatted: an app that could impersonate the place a user goes to meet their colleagues is the
  // last id to leave open.
  "contacts",
  "memory-graph",
  "search",
  "terminal",
  "trash",
  "help",
  "social",
  "settings",
  "calendar",
  "recipes",
  "skills",
])

/** Register (or replace, by id) a dynamically-contributed app. */
export function registerApp(app: HomeApp): void {
  if (RESERVED_IDS.has(app.id)) {
    console.warn(`[apps] ignoring registerApp("${app.id}") — that id is reserved by a built-in app`)
    return
  }
  // `hero` (the single 2×2 gold anchor) is a built-in privilege — never let a contributed app claim it.
  const hero = app.hero ? { ...app, hero: false } : app
  // A tile must always carry words a person can read. A blank title, or one that is really an i18n
  // key its author expected us to resolve, degrades to a name derived from the id ("stock-prices" →
  // "Stock prices"). Rendering `home.app.stock-prices.name` at a user is the failure this prevents;
  // the server's `validateManifest` rejects a blank title, but `registerApp` is reachable in-process
  // and has no such gate, so the guard lives here too.
  const title = legibleAppName(hero.id, hero.title)
  const safe = title === hero.title ? hero : { ...hero, title }
  setApps((prev) => [...prev.filter((a) => a.id !== safe.id), safe])
}

/** Remove a previously registered app. */
export function unregisterApp(id: string): void {
  setApps((prev) => prev.filter((a) => a.id !== id))
}
