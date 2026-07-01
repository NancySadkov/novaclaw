import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogProcesses } from "@/components/dialog-processes"
import { useSettingsDialog } from "@/components/settings-dialog"
import { AppPlaceholder } from "@/pages/home-screen/app-placeholder"
import type { HomeApp } from "./registry"

// The built-in NovaClaw apps. Each `open()` REUSES an existing opener (route navigation, a dialog, the
// settings surface) — nothing is re-implemented. Returned from a hook so the openers bind to the
// current component scope; the home screen merges these with `registeredApps()` (plugin / agent apps).
// Search / Terminal / Devices ship as real tiles with a "coming soon" panel until their surfaces land.
export function useBuiltinApps(): () => HomeApp[] {
  const navigate = useNavigate()
  const dialog = useDialog()
  const openSettings = useSettingsDialog()
  const openModels = useSettingsDialog("models")
  const comingSoon = (title: string) => () => void dialog.show(() => <AppPlaceholder title={title} />)

  return () => [
    { id: "new-chat", title: "New Chat", icon: "plus", accent: "#e6b422", source: "builtin", open: () => navigate("/new-session") },
    { id: "chats", title: "Chats", icon: "menu", accent: "#8b5cf6", source: "builtin", open: () => navigate("/chats") },
    { id: "processes", title: "Processes", icon: "status", accent: "#22d3ee", source: "builtin", open: () => void dialog.show(() => <DialogProcesses />) },
    { id: "settings", title: "Settings", icon: "settings-gear", accent: "#a1a1aa", source: "builtin", open: () => openSettings() },
    { id: "models", title: "Models", icon: "grid-plus", accent: "#a78bfa", source: "builtin", open: () => openModels() },
    { id: "search", title: "Search", icon: "magnifying-glass", accent: "#60a5fa", source: "builtin", open: comingSoon("Search") },
    { id: "terminal", title: "Terminal", icon: "monitor", accent: "#34d399", source: "builtin", open: comingSoon("Terminal") },
    { id: "devices", title: "Devices", icon: "workspace", accent: "#fb923c", source: "builtin", open: comingSoon("Devices") },
  ]
}
