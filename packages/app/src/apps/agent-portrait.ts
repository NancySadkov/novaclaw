import type { ServerConnection } from "@/context/server"
import { instanceFetchResponse, type InstanceSend } from "@/utils/instance-fetch"

/** Only the authenticated instance may turn this route-shaped value into image bytes. */
export const isAgentPortraitURL = (avatar: string | undefined): avatar is string =>
  avatar?.startsWith("/api/agent/") === true && avatar.includes("/avatar")

/**
 * Read a portrait through the same authenticated seam as every other instance request.
 *
 * An `<img src>` cannot attach the selected instance's Basic-auth header. Pointing it directly at
 * this protected route therefore worked only while the instance had no password: the normal
 * password-protected desktop fell back to initials for every colleague. The component renders the
 * object URL made from these authenticated bytes instead.
 */
export const fetchAgentPortrait = (
  server: ServerConnection.HttpBase,
  avatar: string,
  fetch?: InstanceSend,
): Promise<Blob> => {
  if (!isAgentPortraitURL(avatar)) throw new Error("An agent portrait must be an instance avatar route")
  return instanceFetchResponse(server, { route: avatar.replace(/^\/+/, ""), fetch }, async (response) => {
    const contentType = response.headers.get("content-type")?.toLowerCase()
    if (!contentType?.startsWith("image/")) throw new Error("Agent portrait response was not an image")
    const blob = await response.blob()
    if (blob.size === 0) throw new Error("Agent portrait response was empty")
    return blob
  })
}

const portraitCache = new Map<string, Promise<Blob>>()
const PORTRAIT_CACHE_LIMIT = 16

/**
 * How long to wait before re-reading a portrait that failed.
 *
 * 🔴 A refusal during the instance's first seconds is not a verdict on the avatar. The route string
 * is unchanged when the same portrait later succeeds, so a component that gives up keeps the
 * colleague's initials for the life of the window. Bounded, like the reconnect ladder: an instance
 * that is genuinely gone is asked once every 30 s rather than continuously.
 */
export const PORTRAIT_RETRY_BASE_MS = 1_000
export const PORTRAIT_RETRY_CAP_MS = 30_000
export const portraitRetryDelayMs = (attempt: number): number =>
  Math.min(PORTRAIT_RETRY_CAP_MS, PORTRAIT_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 20))

export const loadAgentPortrait = (server: ServerConnection.HttpBase, avatar: string, fetch?: InstanceSend): Promise<Blob> => {
  if (!/[?&]v=[^&]+/.test(avatar)) return fetchAgentPortrait(server, avatar, fetch)
  const key = JSON.stringify([server.url, server.username, server.password, avatar])
  const cached = portraitCache.get(key)
  if (cached) {
    portraitCache.delete(key)
    portraitCache.set(key, cached)
    return cached
  }
  const pending = fetchAgentPortrait(server, avatar, fetch).catch((error) => {
    if (portraitCache.get(key) === pending) portraitCache.delete(key)
    throw error
  })
  portraitCache.set(key, pending)
  if (portraitCache.size > PORTRAIT_CACHE_LIMIT) portraitCache.delete(portraitCache.keys().next().value!)
  return pending
}

/** Two name initials keep an officer identifiable in the compact portrait strip. */
export const agentInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase() || "?"
