export * as EmailOAuth from "./email-oauth"

import type { DeviceCodeStart, OAuthClient, OAuthConfig, OAuthFactory, PollResult, TokenSet } from "./email"

// The REAL Microsoft OAuth2 device-code client (messenger-plan §2.1, P9) — the live-gated half of
// the email driver's auth, kept in its own file like telegram-user-mtcute.ts. Microsoft enforced
// modern-auth-only for personal Outlook/365 (Basic Auth + app passwords fully off 2026-04-30), so
// the mailbox is reached via OAuth2: a device-code flow (RFC 8628) yields a refresh token, and
// every connect refreshes it to an XOAUTH2 access token. Zero dependencies — just `fetch` and
// `application/x-www-form-urlencoded`. The response PARSING is pure + unit-tested; the HTTP calls
// are exercised in the live gate (they need a real client_id + the user's browser consent).

const endpoint = (tenant: string, path: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${path}`

const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")

// ── pure response parsing (unit-tested) ──────────────────────────────────────────────────────────

/** Parse the device-code start response. Throws a legible Error on a malformed body. */
export const parseDeviceCode = (body: unknown): DeviceCodeStart => {
  const value = (body ?? {}) as Record<string, unknown>
  const deviceCode = value["device_code"]
  const userCode = value["user_code"]
  const verificationUri = value["verification_uri"] ?? value["verification_url"]
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string")
    throw new Error(typeof value["error"] === "string" ? String(value["error_description"] ?? value["error"]) : "malformed device-code response")
  const interval = typeof value["interval"] === "number" ? value["interval"] : 5
  const expiresIn = typeof value["expires_in"] === "number" ? value["expires_in"] : 900
  return { deviceCode, userCode, verificationUri, interval, expiresIn }
}

/** Parse a token endpoint response — success → tokens, else map the OAuth `error` to a PollResult.
 *  `nowMs` computes the absolute expiry. */
export const parseTokenResponse = (body: unknown, nowMs: number): PollResult => {
  const value = (body ?? {}) as Record<string, unknown>
  const accessToken = value["access_token"]
  const refreshToken = value["refresh_token"]
  if (typeof accessToken === "string" && typeof refreshToken === "string") {
    const expiresIn = typeof value["expires_in"] === "number" ? value["expires_in"] : 3600
    return { kind: "token", token: { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000 } }
  }
  const error = typeof value["error"] === "string" ? value["error"] : "invalid_grant"
  const description = typeof value["error_description"] === "string" ? value["error_description"] : error
  // The device-code poll states (RFC 8628 §3.5): pending/slow_down are NORMAL waits; the rest end it.
  if (error === "authorization_pending") return { kind: "pending" }
  if (error === "slow_down") return { kind: "slow-down" }
  if (error === "authorization_declined") return { kind: "error", message: "You declined the sign-in.", retryable: false }
  if (error === "expired_token")
    return { kind: "error", message: "The sign-in code expired — start again.", retryable: false }
  return { kind: "error", message: description, retryable: false }
}

/** Parse a refresh response into a TokenSet — Microsoft may or may not rotate the refresh token, so
 *  fall back to the one we sent. Throws on an error body (a revoked/expired token → the driver maps
 *  it to a challenge). */
export const parseRefreshResponse = (body: unknown, previousRefreshToken: string, nowMs: number): TokenSet => {
  const value = (body ?? {}) as Record<string, unknown>
  const accessToken = value["access_token"]
  if (typeof accessToken !== "string") {
    const description = typeof value["error_description"] === "string" ? value["error_description"] : "refresh failed"
    throw new Error(String(description))
  }
  const refreshToken = typeof value["refresh_token"] === "string" ? value["refresh_token"] : previousRefreshToken
  const expiresIn = typeof value["expires_in"] === "number" ? value["expires_in"] : 3600
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000 }
}

// ── the live client (fetch-backed) ────────────────────────────────────────────────────────────────

const postForm = async (url: string, fields: Record<string, string>): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  })
  // Both success and OAuth-error bodies are JSON; the parsers above discriminate on the fields.
  return await response.json().catch(() => ({}))
}

export const make = (config: OAuthConfig): OAuthClient => {
  const scope = config.scopes.join(" ")
  return {
    startDeviceCode: async () =>
      parseDeviceCode(await postForm(endpoint(config.tenant, "devicecode"), { client_id: config.clientId, scope })),
    pollToken: async (deviceCode) =>
      parseTokenResponse(
        await postForm(endpoint(config.tenant, "token"), {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.clientId,
          device_code: deviceCode,
        }),
        Date.now(),
      ),
    refresh: async (refreshToken) =>
      parseRefreshResponse(
        await postForm(endpoint(config.tenant, "token"), {
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: refreshToken,
          scope,
        }),
        refreshToken,
        Date.now(),
      ),
  }
}

export const factory: OAuthFactory = (config) => make(config)
