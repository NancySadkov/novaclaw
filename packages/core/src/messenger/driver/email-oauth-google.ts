export * as EmailOAuthGoogle from "./email-oauth-google"

import { createHash, randomBytes } from "node:crypto"
import type { TokenSet } from "./email"

// The Google OAuth2 auth-code + PKCE client for the Gmail driver (messenger-plan P9; owner ask
// 2026-07-23) — the friendly lay "Sign in with Google" path. Unlike Outlook's device-code flow,
// Google's desktop mail OAuth is the auth-code + loopback-redirect BROWSER flow: open the consent
// page → the user approves → Google redirects to http://127.0.0.1:PORT/?code=… → exchange the code
// for tokens. Gmail IMAP/SMTP uses the RESTRICTED scope https://mail.google.com/, so the OAuth
// client must be Google-verified (or the user's own Cloud "Desktop app" client with themselves as a
// test user). Zero dependencies — `fetch` + node:crypto for PKCE. The response PARSING, URL building,
// and PKCE are pure + unit-tested; the HTTP calls need a real client + the user's browser consent.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

const base64url = (bytes: Buffer): string => bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")

/** A fresh PKCE code verifier — 32 random bytes, base64url (43 chars, RFC 7636 unreserved set). */
export const generateCodeVerifier = (): string => base64url(randomBytes(32))

/** The S256 PKCE challenge for a verifier — base64url(SHA256(verifier)). Pure + unit-tested. */
export const codeChallengeS256 = (verifier: string): string => base64url(createHash("sha256").update(verifier).digest())

/** A random opaque `state` for CSRF binding of the redirect to this attempt. */
export const generateState = (): string => base64url(randomBytes(16))

export const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&")

// ── pure response parsing (unit-tested) ──────────────────────────────────────────────────────────

/** Parse Google's authorization-code exchange response. Success requires BOTH an access token and a
 *  refresh token — the exchange uses access_type=offline + prompt=consent, so Google returns a
 *  refresh token; if it didn't, the user previously granted access and Google won't re-issue one
 *  without a fresh consent (a legible, actionable error). Throws on any error body. */
export const parseGoogleToken = (body: unknown, nowMs: number): TokenSet => {
  const value = (body ?? {}) as Record<string, unknown>
  const accessToken = value["access_token"]
  if (typeof accessToken !== "string") {
    const description =
      typeof value["error_description"] === "string"
        ? value["error_description"]
        : typeof value["error"] === "string"
          ? value["error"]
          : "Google sign-in did not return an access token"
    throw new Error(String(description))
  }
  const refreshToken = value["refresh_token"]
  if (typeof refreshToken !== "string" || refreshToken.length === 0)
    throw new Error(
      "Google did not return a refresh token — remove NovaClaw at myaccount.google.com → Third-party access, then sign in again so consent re-prompts.",
    )
  const expiresIn = typeof value["expires_in"] === "number" ? value["expires_in"] : 3600
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000 }
}

/** Parse a refresh response into a TokenSet. Google does NOT rotate the refresh token, so keep the
 *  one we sent. Throws on an error body (revoked/expired → the driver maps it to a challenge). */
export const parseGoogleRefresh = (body: unknown, previousRefreshToken: string, nowMs: number): TokenSet => {
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

/** Build the Google consent URL. `access_type=offline` + `prompt=consent` guarantee a refresh token;
 *  PKCE S256 binds the code to this attempt; `login_hint` pre-fills the account chooser. Pure. */
export const buildAuthorizeUrl = (params: {
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly state: string
  readonly codeChallenge: string
  readonly redirectUri: string
  readonly loginHint?: string
}): string => {
  const query: Record<string, string> = {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }
  if (params.loginHint && params.loginHint.length > 0) query["login_hint"] = params.loginHint
  return `${AUTH_ENDPOINT}?${form(query)}`
}

// ── the seam (mirrors OAuthClient in email.ts, for auth-code instead of device-code) ─────────────

export interface AuthCodeConfig {
  readonly clientId: string
  /** Google "Desktop app" clients issue a secret; it is NOT confidential for an installed app but
   *  the token endpoint still expects it. Optional — omitted for PKCE-only public clients. */
  readonly clientSecret?: string
  readonly scopes: readonly string[]
}

export interface AuthCodeClient {
  readonly buildAuthorizeUrl: (params: {
    readonly state: string
    readonly codeChallenge: string
    readonly redirectUri: string
    readonly loginHint?: string
  }) => string
  readonly exchangeCode: (params: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string }) => Promise<TokenSet>
  readonly refresh: (refreshToken: string) => Promise<TokenSet>
}

export type AuthCodeFactory = (config: AuthCodeConfig) => AuthCodeClient

// ── the live client (fetch-backed) ────────────────────────────────────────────────────────────────

const postForm = async (fields: Record<string, string>): Promise<unknown> => {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  })
  // Both success and OAuth-error bodies are JSON; the parsers above discriminate on the fields.
  return await response.json().catch(() => ({}))
}

export const make = (config: AuthCodeConfig): AuthCodeClient => ({
  buildAuthorizeUrl: ({ state, codeChallenge, redirectUri, loginHint }) =>
    buildAuthorizeUrl({ clientId: config.clientId, scopes: config.scopes, state, codeChallenge, redirectUri, loginHint }),
  exchangeCode: async ({ code, codeVerifier, redirectUri }) =>
    parseGoogleToken(
      await postForm({
        grant_type: "authorization_code",
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      Date.now(),
    ),
  refresh: async (refreshToken) =>
    parseGoogleRefresh(
      await postForm({
        grant_type: "refresh_token",
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        refresh_token: refreshToken,
      }),
      refreshToken,
      Date.now(),
    ),
})

export const factory: AuthCodeFactory = (config) => make(config)
