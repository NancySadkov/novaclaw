import { OfficerName } from "@novaclaw/core/agent/officer-name"

const BUILTIN_NAMES = new Set(["nova", ...OfficerName.POOL])
const NUMBERED_OFFICER = /-\d+$/
export const BESPOKE_AGENT_PORTRAITS = new Set(["nova", "xenia", "daedalus", "myron"])

/**
 * The portrait resources shipped for Nova and every name Nova may draw for an officer.
 *
 * A numbered collision (for example `theron-2`) is still Theron's visual identity. Custom ids do
 * not guess at a file: the renderer keeps its existing glyph/initial fallback without a 404.
 */
export const agentPortraitSource = (id: string): string | undefined => {
  const name = id.trim().toLowerCase().replace(NUMBERED_OFFICER, "")
  if (!BUILTIN_NAMES.has(name)) return undefined
  return `/assets/agents/portraits/${name}.${BESPOKE_AGENT_PORTRAITS.has(name) ? "webp" : "svg"}`
}

/**
 * The portrait to show for a colleague: none when the row carries its own `avatar`, the shipped
 * one otherwise. The colleague's identity is the instance's; the pool is only the placeholder
 * for a colleague that has not said what it looks like (2026-09-03 — it was the other way round).
 */
export const agentPortraitPlaceholder = (id: string, avatar: string | undefined): string | undefined =>
  avatar ? undefined : agentPortraitSource(id)
