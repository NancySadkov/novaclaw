export * as UserProfile from "./user-profile"

// B4 — the user-profile layer of the composed system prompt. Sits BETWEEN the
// persona baseline (B3) and the project/agent layers: persona → user-profile →
// project → agent-system. Tells the model WHO it is helping (name + background)
// so "personal touches" edit this middle layer and never fork the shipped base.
//
// Pure + dependency-free: config in, string out (persona.ts pattern).

/** The user_profile block of the user config (V1 + V2 carry the same shape). */
export interface Config {
  /** Master switch — when true the profile is shared with the model (V2: via the `profile` tool). */
  readonly enabled?: boolean
  readonly name?: string
  readonly about?: string
}

/**
 * Resolve the user-profile system-prompt block. `fallbackName` covers the older
 * `username` config field when the profile has no name of its own. Returns
 * undefined when there is nothing to say — no empty scaffolding in the prompt.
 */
export function resolve(config: Config | undefined, options?: { fallbackName?: string }): string | undefined {
  const name = config?.name?.trim() || options?.fallbackName?.trim() || undefined
  const about = config?.about?.trim() || undefined
  if (!name && !about) return undefined
  const lines = ["About your user:"]
  if (name) lines.push(`- Name: ${name}`)
  if (about) lines.push(`- Background: ${about}`)
  return lines.join("\n")
}
