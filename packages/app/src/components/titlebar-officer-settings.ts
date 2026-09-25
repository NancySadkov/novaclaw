import type { Tab } from "@/context/tabs"

const officerScreenID = (pathname: string, screen: string) => {
  const match = new RegExp(`^/officers/([^/]+)/${screen}/?$`).exec(pathname)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
}

export const settingsOfficerID = (pathname: string) => officerScreenID(pathname, "settings")

export const teamChatOfficerID = (pathname: string) => officerScreenID(pathname, "team")

export function officerSettingsTab(tab: Tab, agentID: string | undefined, server: string) {
  return (
    agentID !== undefined && tab.type === "session" && !tab.worker && tab.agent === agentID && tab.server === server
  )
}

export function officerSettingsDestination(pathname: string, search: string, tab: Tab) {
  if (settingsOfficerID(pathname) === undefined || tab.type !== "session" || tab.worker || !tab.agent) return undefined
  const query = new URLSearchParams(search)
  const returnTo = query.get("returnTo")
  const suffix = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? `?${new URLSearchParams({ returnTo })}` : ""
  return `/officers/${encodeURIComponent(tab.agent)}/settings${suffix}`
}
