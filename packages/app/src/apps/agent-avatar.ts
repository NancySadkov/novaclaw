import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

export const MAX_AGENT_AVATAR_BYTES = 5 * 1024 * 1024
export const AGENT_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export const uploadAgentAvatar = async (server: ServerConnection.HttpBase, agentID: string, file: File) => {
  const mime = file.type.split(";", 1)[0]?.trim().toLowerCase()
  if (!mime || !AGENT_AVATAR_TYPES.has(mime)) throw new Error("Choose a PNG, JPEG, GIF or WebP image")
  if (file.size === 0 || file.size > MAX_AGENT_AVATAR_BYTES)
    throw new Error(`Choose an image no larger than ${MAX_AGENT_AVATAR_BYTES / 1024 / 1024} MB`)
  return instanceFetch<{ hash: string; mime: string }>(server, {
    method: "PUT",
    route: `api/agent/${encodeURIComponent(agentID)}/avatar`,
    headers: { "content-type": mime, accept: "application/json" },
    rawBody: new Uint8Array(await file.arrayBuffer()),
  })
}

export const removeAgentAvatar = (server: ServerConnection.HttpBase, agentID: string) =>
  instanceFetch<void>(server, {
    method: "DELETE",
    route: `api/agent/${encodeURIComponent(agentID)}/avatar`,
  })
