import { useNavigate } from "@solidjs/router"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { DialogProcesses } from "@/components/dialog-processes"
import { useChatsAttention } from "@/apps/chats-attention"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPlaceholder } from "@/pages/home-screen/app-placeholder"
import { HelpTour } from "@/pages/home-screen/help-tour"
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
      subtitle: "Ask anything — your agents do the work",
      source: "builtin",
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
      id: "files",
      title: "Files",
      icon: "folder",
      accent: "#3b82f6",
      subtitle: "Browse folders and ask AI to work on them",
      source: "builtin",
      open: () => navigate("/files"),
    },
    {
      id: "processes",
      title: "Processes",
      icon: "status",
      accent: "#22d3ee",
      subtitle: "What your agents are doing right now",
      source: "builtin",
      open: () => void dialog.show(() => <DialogProcesses />),
    },
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
