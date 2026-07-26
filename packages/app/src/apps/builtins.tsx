import { useNavigate } from "@solidjs/router"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useChatsAttention } from "@/apps/chats-attention"
import { activityLabel, useChatsActivity } from "@/apps/chats-activity"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPlaceholder } from "@/pages/home-screen/app-placeholder"
import { HelpTour } from "@/pages/home-screen/help-tour"
import { SocialPanel } from "@/pages/home-screen/social-panel"
import type { HomeApp } from "./registry"

// The built-in NovaClaw apps. Each `open()` REUSES an existing opener (route navigation, a dialog, the
// settings surface) — nothing is re-implemented. Returned from a hook so the openers bind to the
// current component scope; the home screen merges these with `registeredApps()` (plugin / agent apps).
//
// App-set decisions (2026-07-01, refined 2026-07-02): there is NO "New Chat" tile — new sessions live
// inside the Chats app, which is the HERO tile (the one eye-anchor; everything else is done through
// chat with an agent). Models + Devices are Settings tabs, not home apps. Notes / Files / Trash /
// Processes route to real pages/dialogs; only Search / Terminal remain placeholders (a self-documenting
// panel that teaches the chat-first model).
//
// Tile palette: gold is reserved for the hero (the single warm accent on the cool purple field —
// that contrast is what guides the eye); every other tile gets a cool hue so none competes.
export function useBuiltinApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const dialog = useDialog()
  const openSettings = useSettingsDialog()
  const chatsAttention = useChatsAttention()
  const chatsActivity = useChatsActivity()
  const comingSoon = (app: Omit<HomeApp, "open" | "source">) => () =>
    void dialog.show(() => <AppPlaceholder title={app.title} icon={app.icon} accent={app.accent} subtitle={app.subtitle} />)

  return () => [
    {
      id: "chats",
      title: "Chats",
      icon: "speech-bubble",
      // The hero's accent IS the preset's primary accent, so the one eye-anchor re-themes with the
      // color scheme (gold on Nova, amber on Autumn, coral on Summer). uix.md §7.
      accent: "var(--nc-accent-solid)",
      glyphTone: "dark",
      hero: true,
      // Describes what the tile OPENS — a list of your conversations. The old line ("Ask anything — your
      // agents do the work") described the composer at the bottom of the home screen, not this tile, so it
      // promised something tapping here does not do (owner 2026-07-26).
      subtitle: "Your conversations, and everything still running",
      source: "builtin",
      // While agents are working the tile reports it instead: "2 agents working · ~47 t/s".
      status: () => activityLabel(chatsActivity()),
      open: () => navigate("/chats"),
      // Chats wanting attention (pending permission/question + unseen) — uix-improvement slice 2.
      badge: () => chatsAttention().length || undefined,
    },
    {
      id: "notes",
      title: "Notes",
      icon: "edit",
      accent: "#8b5cf6",
      subtitle: "Everyday notes, shared with your agents",
      source: "builtin",
      open: () => navigate("/notes"),
    },
    {
      id: "calendar",
      title: "Calendar",
      icon: "calendar",
      accent: "#6366f1",
      subtitle: "Schedule agents to run on a repeating date",
      source: "builtin",
      open: () => navigate("/calendar"),
    },
    {
      id: "recipes",
      title: "Recipes",
      icon: "checklist",
      accent: "#f97316",
      subtitle: "Ready-made prompts your agents can cook",
      source: "builtin",
      open: () => navigate("/recipes"),
    },
    {
      id: "files",
      title: "Files",
      icon: "folder",
      accent: "#3b82f6",
      subtitle: "Browse folders and ask AI to work on them",
      source: "builtin",
      open: () => navigate("/files"),
    },
    // Processes RETIRED (uix-improvement slice 6): Chats absorbed the user-facing view (threads
    // tree, status pills-as-attention, tokens in the info sheet). The Developer `ps` — kill /
    // suspend, scheduler snapshot, raw ids — lands in the future Debug app (todo.md → Make UIX
    // perfect). The "processes" id stays RESERVED so a plugin can't squat it meanwhile.
    {
      id: "search",
      title: "Search",
      icon: "magnifying-glass-menu",
      accent: "#34d399",
      subtitle: "Find anything across chats and files",
      source: "builtin",
      open: comingSoon({ id: "search", title: "Search", icon: "magnifying-glass-menu", accent: "#34d399", subtitle: "Find anything across chats and files" }),
    },
    {
      id: "terminal",
      title: "Terminal",
      icon: "terminal",
      accent: "#64748b",
      subtitle: "A shell, for when you want one",
      source: "builtin",
      // Chat is the shell for everyone else; the raw terminal only appears in Developer (uix.md §6.4).
      minLevel: "developer",
      open: comingSoon({ id: "terminal", title: "Terminal", icon: "terminal", accent: "#64748b", subtitle: "A shell, for when you want one" }),
    },
    {
      id: "registry",
      title: "Registry",
      icon: "cpu",
      accent: "#0ea5e9",
      subtitle: "The instance database, editable — handle with care",
      source: "builtin",
      // Raw database editing is a Developer surface (uix.md §6.4; the sanctioned re-homing of
      // the old `db` sqlite3 shell — todo.md tie-break #3).
      minLevel: "developer",
      open: () => navigate("/registry"),
    },
    {
      id: "debug",
      title: "Debug",
      icon: "console",
      accent: "#a78bfa",
      subtitle: "Connection, error log, sessions — under the hood",
      source: "builtin",
      // Raw diagnostics are a Developer surface (uix.md §6.4; dependability P5 — the calm
      // banner/ErrorPage stay clean, the detail lives here).
      minLevel: "developer",
      open: () => navigate("/debug"),
    },
    {
      id: "memory-graph",
      title: "Memory graph",
      icon: "branch",
      accent: "#8b5cf6",
      subtitle: "Explore what NovaClaw remembers, as a graph",
      source: "builtin",
      // The advanced node-link view of the graph memory (kb-graph P5; the lay controls live in
      // Settings → Memory). Path-tracing is a Developer surface (uix.md §6.4).
      minLevel: "developer",
      open: () => navigate("/memory-graph"),
    },
    {
      id: "trash",
      title: "Trash",
      icon: "trash",
      // Cool teal, not the old saturated red — gold is the ONLY warm accent (the hero). uix.md §3/P3.
      accent: "#14b8a6",
      subtitle: "Restore anything deleted in the last 2 days",
      source: "builtin",
      open: () => navigate("/trash"),
    },
    {
      id: "social",
      title: "Community",
      // A generic people glyph, NOT the Discord mark: the tile leads to Discord, Reddit AND the website, so
      // wearing one company's trademark both misdescribes it and borrows a mark we have no licence to use as
      // our own iconography. The Discord ROW inside the panel keeps its logo — that one really is Discord.
      icon: "community",
      // Cool indigo-blue, so it doesn't compete with the gold hero (uix.md §3/P3).
      accent: "#5865f2",
      subtitle: "Discord, Reddit and the website — other people who run NovaClaw",
      source: "builtin",
      // Sits next to Help on purpose: when the tour doesn't answer it, humans do.
      open: () => void dialog.show(() => <SocialPanel />),
    },
    {
      id: "help",
      title: "Help",
      icon: "help",
      // Cool indigo, not the old pink — keeps the single-warm-accent discipline. uix.md §3/P3.
      accent: "#6366f1",
      subtitle: "A short tour of what NovaClaw can do",
      source: "builtin",
      open: () => void dialog.show(() => <HelpTour />),
    },
    {
      id: "settings",
      title: "Settings",
      icon: "settings-gear",
      accent: "#8d8fa6",
      subtitle: "Providers, models, servers, recovery",
      source: "builtin",
      open: () => openSettings(),
    },
  ]
}
