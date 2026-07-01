import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogProcesses } from "@/components/dialog-processes"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPlaceholder } from "@/pages/home-screen/app-placeholder"
import { HelpTour } from "@/pages/home-screen/help-tour"
import type { HomeApp } from "./registry"

// The built-in NovaClaw apps. Each `open()` REUSES an existing opener (route navigation, a dialog, the
// settings surface) — nothing is re-implemented. Returned from a hook so the openers bind to the
// current component scope; the home screen merges these with `registeredApps()` (plugin / agent apps).
//
// App-set decisions (2026-07-01): there is NO "New Chat" tile — new sessions live inside the Chats app.
// Models + Devices are Settings tabs, not home apps. Notes (shared free-form notes) and Files (the
// AI-ready file manager) are first-class apps; both ship as placeholders until their surfaces land.
export function useBuiltinApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const dialog = useDialog()
  const openSettings = useSettingsDialog()
  const comingSoon = (title: string) => () => void dialog.show(() => <AppPlaceholder title={title} />)

  return () => [
    { id: "chats", title: "Chats", icon: "chats", accent: "#8b5cf6", source: "builtin", open: () => navigate("/chats") },
    { id: "notes", title: "Notes", icon: "edit", accent: "#e6b422", source: "builtin", open: comingSoon("Notes") },
    { id: "files", title: "Files", icon: "folder-add-left", accent: "#3b82f6", source: "builtin", open: comingSoon("Files") },
    { id: "processes", title: "Processes", icon: "status", accent: "#22d3ee", source: "builtin", open: () => void dialog.show(() => <DialogProcesses />) },
    { id: "search", title: "Search", icon: "magnifying-glass", accent: "#34d399", source: "builtin", open: comingSoon("Search") },
    { id: "terminal", title: "Terminal", icon: "monitor", accent: "#64748b", source: "builtin", open: comingSoon("Terminal") },
    { id: "help", title: "Help", icon: "help", accent: "#f472b6", source: "builtin", open: () => void dialog.show(() => <HelpTour />) },
    { id: "settings", title: "Settings", icon: "settings-gear", accent: "#a1a1aa", source: "builtin", open: () => openSettings() },
  ]
}
