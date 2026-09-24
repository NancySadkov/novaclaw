import { useLocation, useNavigate } from "@solidjs/router"
import type { Accessor } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

export function useSettingsNavigation(defaultTab?: string) {
  const location = useLocation()
  const navigate = useNavigate()
  return () => {
    if (location.pathname === "/settings") return
    const query = new URLSearchParams({ returnTo: location.pathname + location.search })
    if (defaultTab) query.set("tab", defaultTab)
    navigate(`/settings?${query}`)
  }
}

export function useOfficerMessengerSettings(agentID: Accessor<string>) {
  const location = useLocation()
  const navigate = useNavigate()
  return () => {
    const query = new URLSearchParams({ tab: "messengers", returnTo: location.pathname + location.search })
    navigate(`/officers/${encodeURIComponent(agentID())}/settings?${query}`)
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const open = useSettingsNavigation()

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: open,
    },
  ])

  return open
}
