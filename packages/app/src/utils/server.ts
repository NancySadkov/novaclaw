import { createNovaclawClient } from "@novaclaw/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "novaclaw"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  if (!token) return
  // NOT decode64: its round-trip guard re-encodes with the app's UNPADDED base64url encoder,
  // so any PADDED standard-base64 token (btoa output — authTokenFromCredentials itself) fails
  // the guard and silently drops the credentials. Auth tokens may arrive in either alphabet,
  // padded or not; the ":" separator check below is the malformed-input filter.
  let decoded: string
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/")
    decoded = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4))
  } catch {
    return
  }
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "novaclaw",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createNovaclawClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createNovaclawClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}
