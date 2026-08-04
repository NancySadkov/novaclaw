import { useNavigate } from "@solidjs/router"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useChatsAttention } from "@/apps/chats-attention"
import { activityLabel, useChatsActivity } from "@/apps/chats-activity"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPlaceholder } from "@/pages/home-screen/app-placeholder"
import { HelpTour } from "@/pages/home-screen/help-tour"
import { SocialPanel } from "@/pages/home-screen/social-panel"
import { appName, appSubtitle, BUILTIN_APP_LABELS, type BuiltinAppId, type Translate } from "./app-label"
import type { HomeApp } from "./registry"

// The built-in NovaClaw apps. Each `open()` REUSES an existing opener (route navigation, a dialog, the
// settings surface) — nothing is re-implemented. Returned from a hook so the openers bind to the
// current component scope; the home screen merges these with `registeredApps()` (plugin / agent apps).
//
// App-set decisions (2026-07-01, refined 2026-07-02): there is NO "New Chat" tile — new sessions live
// inside the Chats app, which is the HERO tile (the one eye-anchor; everything else is done through
// chat with an agent). Models + Devices are Settings tabs, not home apps. Notes / Files / Trash /
// Processes route to real pages/dialogs; only Search remains a placeholder (a self-documenting
// panel that teaches the chat-first model).
//
// Tile palette: gold is reserved for the hero (the single warm accent on the cool purple field —
// that contrast is what guides the eye); every other tile gets a cool hue so none competes.
//
// ⚠️ Words come from `home.app.<id>.{name,subtitle}` (see `app-label.ts`), NOT from literals here.
// They used to be hardcoded English, which made the most visible strings in the product the only ones
// the language picker could not reach. The English text still exists once, in `BUILTIN_APP_LABELS`,
// as the fallback for a build whose keys went missing — `app-label.test.ts` pins it against `en`.
export function useBuiltinApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const dialog = useDialog()
  const language = useLanguage()
  const openSettings = useSettingsDialog()
  const chatsAttention = useChatsAttention()
  const chatsActivity = useChatsActivity()

  // `t` is typed to the literal key union; `home.app.<id>.*` is assembled at runtime because a
  // contributed app's id is not known at build time. Same bridge `help-tour.tsx` uses per step.
  const t: Translate = (key, params) => language.t(key as Parameters<typeof language.t>[0], params)
  const name = (id: BuiltinAppId) => appName(t, id, BUILTIN_APP_LABELS[id].name)
  // Every built-in ships a subtitle, so this narrows to `string` — `appSubtitle` returns `undefined`
  // only when there is nothing at all to say, which cannot happen for an entry in the table.
  const sub = (id: BuiltinAppId): string =>
    appSubtitle(t, id, BUILTIN_APP_LABELS[id].subtitle) ?? BUILTIN_APP_LABELS[id].subtitle

  const comingSoon = (id: BuiltinAppId, icon: string, accent: string) => () =>
    void dialog.show(() => <AppPlaceholder title={name(id)} icon={icon} accent={accent} subtitle={sub(id)} />)

  return () => [
    {
      id: "chats",
      title: name("chats"),
      icon: "speech-bubble",
      // The hero's accent IS the preset's primary accent, so the one eye-anchor re-themes with the
      // color scheme (gold on Nova, amber on Autumn, coral on Summer). uix.md §7.
      accent: "var(--nc-accent-solid)",
      glyphTone: "dark",
      hero: true,
      // Describes what the tile OPENS — a list of your conversations. The old line ("Ask anything — your
      // agents do the work") described the composer at the bottom of the home screen, not this tile, so it
      // promised something tapping here does not do (owner 2026-07-26).
      subtitle: sub("chats"),
      source: "builtin",
      // While agents are working the tile reports it instead: "2 agents working · ~47 t/s".
      status: () => activityLabel(chatsActivity()),
      open: () => navigate("/chats"),
      // Chats wanting attention (pending permission/question + unseen) — uix-improvement slice 2.
      badge: () => chatsAttention().length || undefined,
    },
    {
      id: "notes",
      title: name("notes"),
      icon: "edit",
      accent: "#8b5cf6",
      subtitle: sub("notes"),
      source: "builtin",
      open: () => navigate("/notes"),
    },
    {
      id: "calendar",
      title: name("calendar"),
      icon: "calendar",
      accent: "#6366f1",
      subtitle: sub("calendar"),
      source: "builtin",
      open: () => navigate("/calendar"),
    },
    {
      id: "recipes",
      title: name("recipes"),
      icon: "checklist",
      accent: "#f97316",
      subtitle: sub("recipes"),
      source: "builtin",
      open: () => navigate("/recipes"),
    },
    {
      id: "files",
      title: name("files"),
      icon: "folder",
      accent: "#3b82f6",
      subtitle: sub("files"),
      source: "builtin",
      open: () => navigate("/files"),
    },
    // Processes RETIRED (uix-improvement slice 6): Chats absorbed the user-facing view (threads
    // tree, status pills-as-attention, tokens in the info sheet). The Developer `ps` — kill /
    // suspend, scheduler snapshot, raw ids — lands in the future Debug app (todo.md → Make UIX
    // perfect). The "processes" id stays RESERVED so a plugin can't squat it meanwhile.
    {
      id: "search",
      title: name("search"),
      icon: "magnifying-glass-menu",
      accent: "#34d399",
      subtitle: sub("search"),
      source: "builtin",
      open: comingSoon("search", "magnifying-glass-menu", "#34d399"),
    },
    {
      id: "terminal",
      title: name("terminal"),
      icon: "terminal",
      accent: "#64748b",
      subtitle: sub("terminal"),
      source: "builtin",
      // Chat is the shell for everyone else; the raw terminal appears only after the user opts into
      // Advanced or Developer expertise. Its PTY always runs on the selected instance.
      minLevel: "advanced",
      open: () => navigate("/terminal"),
    },
    {
      id: "registry",
      title: name("registry"),
      icon: "cpu",
      accent: "#0ea5e9",
      subtitle: sub("registry"),
      source: "builtin",
      // Raw database editing is a Developer surface (uix.md §6.4; the sanctioned re-homing of
      // the old `db` sqlite3 shell — todo.md tie-break #3).
      minLevel: "developer",
      open: () => navigate("/registry"),
    },
    {
      id: "debug",
      title: name("debug"),
      icon: "console",
      accent: "#a78bfa",
      subtitle: sub("debug"),
      source: "builtin",
      // Raw diagnostics are a Developer surface (uix.md §6.4; dependability P5 — the calm
      // banner/ErrorPage stay clean, the detail lives here).
      minLevel: "developer",
      open: () => navigate("/debug"),
    },
    {
      id: "memory-graph",
      title: name("memory-graph"),
      icon: "branch",
      accent: "#8b5cf6",
      subtitle: sub("memory-graph"),
      source: "builtin",
      // The advanced node-link view of the graph memory (kb-graph P5; the lay controls live in
      // Settings → Memory). Path-tracing is a Developer surface (uix.md §6.4).
      minLevel: "developer",
      open: () => navigate("/memory-graph"),
    },
    {
      id: "trash",
      title: name("trash"),
      icon: "trash",
      // Cool teal, not the old saturated red — gold is the ONLY warm accent (the hero). uix.md §3/P3.
      accent: "#14b8a6",
      subtitle: sub("trash"),
      source: "builtin",
      open: () => navigate("/trash"),
    },
    {
      id: "social",
      title: name("social"),
      // A generic people glyph, NOT the Discord mark: the tile leads to Discord, Reddit AND the website, so
      // wearing one company's trademark both misdescribes it and borrows a mark we have no licence to use as
      // our own iconography. The Discord ROW inside the panel keeps its logo — that one really is Discord.
      icon: "community",
      // Cool indigo-blue, so it doesn't compete with the gold hero (uix.md §3/P3).
      accent: "#5865f2",
      subtitle: sub("social"),
      source: "builtin",
      // Sits next to Help on purpose: when the tour doesn't answer it, humans do.
      open: () => void dialog.show(() => <SocialPanel />),
    },
    {
      id: "help",
      title: name("help"),
      icon: "help",
      // Cool indigo, not the old pink — keeps the single-warm-accent discipline. uix.md §3/P3.
      accent: "#6366f1",
      subtitle: sub("help"),
      source: "builtin",
      open: () => void dialog.show(() => <HelpTour />),
    },
    {
      id: "settings",
      title: name("settings"),
      icon: "settings-gear",
      accent: "#8d8fa6",
      subtitle: sub("settings"),
      source: "builtin",
      open: () => openSettings(),
    },
  ]
}
