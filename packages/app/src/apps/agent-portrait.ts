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
