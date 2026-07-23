export * as EmailGmailDriver from "./email-gmail"

import { Deferred, Effect } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import type { Driver, LoginPending, LoginSupport } from "../driver"
import { ChallengeError, ConnectError, LoginCodeError } from "../driver"
import type { EmailAccountConfig, EmailClientFactory, EmailDefaults, StoredCredential } from "./email"
import { CAPS, makeConnect, parseEmailConfig, resolveEmailAuth } from "./email"
import type { AuthCodeFactory } from "./email-oauth-google"
import { codeChallengeS256, generateCodeVerifier, generateState } from "./email-oauth-google"
import type { LoopbackFactory } from "../oauth-loopback"

// The GMAIL driver (messenger-plan P9; owner ask 2026-07-23) — the friendly lay "Sign in with
// Google" path. A thin sibling of the email driver: it REUSES the entire IMAP/SMTP connection pump
// (email.ts `makeConnect`) and only swaps the AUTH flow — Google's auth-code + loopback BROWSER flow
// (email-oauth-google.ts + oauth-loopback.ts) instead of Outlook's device-code. Gmail hosts + scope
// are fixed, so the user types only their address and clicks a button; NovaClaw opens the browser,
// catches the 127.0.0.1 redirect, and exchanges the code — nothing to type back. Basic Auth (an app
// password) still works as a fallback (paste it as the secret), same as the generic email driver.
//
// ⚠️ CLIENT ID/SECRET — the one external prerequisite. Gmail IMAP/SMTP needs the RESTRICTED scope
// https://mail.google.com/, so the OAuth client must be Google-VERIFIED (a CASA assessment) or be
// the user's OWN Google Cloud "Desktop app" client with themselves added as a test user. Until
// NovaClaw ships a verified client, GMAIL_DEFAULT_CLIENT_ID stays empty and the user supplies their
// own (the clientId/clientSecret settings). Drop the verified client's id/secret into the two
// constants below (or wire them to config for self-healing) and blank settings "just work".

const GMAIL_DEFAULTS: EmailDefaults = {
  imapHost: "imap.gmail.com",
  imapPort: 993,
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  tenant: "", // unused for Google (Microsoft-only)
}

// The one restricted scope Gmail IMAP/SMTP needs. `access_type=offline`+`prompt=consent` (in the URL
// builder) get the refresh token — that's not a scope.
const GMAIL_SCOPES = ["https://mail.google.com/"] as const

// Owner fill-in: NovaClaw's Google-verified "Desktop app" OAuth client. Empty until one is
// registered + verified; a user's own client (via settings) overrides these regardless.
const GMAIL_DEFAULT_CLIENT_ID = ""
const GMAIL_DEFAULT_CLIENT_SECRET = ""

/** The effective OAuth client for an account: the account's own clientId/secret if set, else the
 *  built-in verified default. `undefined` when neither exists (login/refresh then reports it clearly). */
const effectiveClient = (config: EmailAccountConfig): { readonly clientId: string; readonly clientSecret?: string } | undefined => {
  const clientId = config.clientId ?? (GMAIL_DEFAULT_CLIENT_ID.length > 0 ? GMAIL_DEFAULT_CLIENT_ID : undefined)
  if (clientId === undefined) return undefined
  const clientSecret = config.clientSecret ?? (GMAIL_DEFAULT_CLIENT_SECRET.length > 0 ? GMAIL_DEFAULT_CLIENT_SECRET : undefined)
  return clientSecret === undefined ? { clientId } : { clientId, clientSecret }
}

export const make = (
  mailFactory: EmailClientFactory,
  authCodeFactory: AuthCodeFactory,
  loopbackFactory: LoopbackFactory,
  openBrowser: (url: string) => Effect.Effect<void>,
  options?: { readonly pollIntervalMs?: number },
): Driver => {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000

  const login: LoginSupport = {
    begin: ({ account }) =>
      Effect.gen(function* () {
        const config = yield* parseEmailConfig(account, GMAIL_DEFAULTS)
        const clientSpec = effectiveClient(config)
        if (clientSpec === undefined)
          return yield* Effect.fail(
            new ConnectError({
              reason:
                "Gmail sign-in needs a Google OAuth client. Paste a Google Cloud 'Desktop app' client ID (and secret) in Settings, or use an app password instead (paste it as the secret).",
            }),
          )
        const client = authCodeFactory({ clientId: clientSpec.clientId, clientSecret: clientSpec.clientSecret, scopes: GMAIL_SCOPES })

        // PKCE + CSRF state bind the code to THIS attempt; the loopback catches the redirect. The
        // loopback + the awaiting fiber both live in begin()'s Scope (the login attempt owns it), so
        // they close on complete/cancel/expiry.
        const state = generateState()
        const verifier = generateCodeVerifier()
        const loopback = yield* loopbackFactory({ expectedState: state, provider: "Gmail" })
        const url = client.buildAuthorizeUrl({
          state,
          codeChallenge: codeChallengeS256(verifier),
          redirectUri: loopback.redirectUri,
          loginHint: config.email,
        })
        yield* openBrowser(url)

        // A fiber awaits the redirect → exchanges the code → parks the result in a Deferred. complete()
        // (called by the wizard, possibly polled) reads it: still-open → retryable "still waiting";
        // resolved → the session credential; failed → the terminal error. Mirrors device-code's poll.
        const result = yield* Deferred.make<StoredCredential, LoginCodeError | ChallengeError>()
        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => loopback.waitForCode,
            catch: (error) => new LoginCodeError({ reason: `Google sign-in didn't complete: ${String(error)}`, retryable: false }),
          }).pipe(
            Effect.flatMap((code) =>
              Effect.tryPromise({
                try: () => client.exchangeCode({ code, codeVerifier: verifier, redirectUri: loopback.redirectUri }),
                catch: (error) => new ChallengeError({ message: `Google rejected the sign-in for ${config.email} (${String(error)}).` }),
              }),
            ),
            Effect.map((token) => ({ refreshToken: token.refreshToken, email: config.email }) satisfies StoredCredential),
            Effect.matchCauseEffect({
              onFailure: (cause) => Deferred.failCause(result, cause),
              onSuccess: (stored) => Deferred.succeed(result, stored),
            }),
          ),
        )

        const complete: LoginPending["complete"] = () =>
          Effect.gen(function* () {
            if (!(yield* Deferred.isDone(result)))
              return yield* Effect.fail(
                new LoginCodeError({ reason: "Still waiting for you to finish the Google sign-in in your browser…", retryable: true }),
              )
            const stored = yield* Deferred.await(result)
            return { session: JSON.stringify(stored) }
          })

        return {
          instructions: `A browser window is opening for Google sign-in — approve access for ${config.email}. If it didn't open, copy this link into your browser:\n${url}`,
          complete,
        } satisfies LoginPending
      }),
  }

  const connect = makeConnect(
    mailFactory,
    pollIntervalMs,
    (account) => parseEmailConfig(account, GMAIL_DEFAULTS),
    (config, secret) =>
      resolveEmailAuth(
        config,
        secret,
        (c) => {
          const clientSpec = effectiveClient(c)
          return clientSpec === undefined ? undefined : authCodeFactory({ clientId: clientSpec.clientId, clientSecret: clientSpec.clientSecret, scopes: GMAIL_SCOPES }).refresh
        },
        "Google",
      ),
  )

  return {
    id: "email-gmail",
    meta: {
      id: "email-gmail",
      name: "Gmail",
      icon: "speech-bubble",
      auth: "login",
      loginStyle: "browser",
      settings: [
        { type: "text", key: "email", message: "Your Gmail address", placeholder: "you@gmail.com" },
        {
          type: "text",
          key: "clientId",
          message: "Google OAuth client ID",
          placeholder: "…apps.googleusercontent.com",
        },
        {
          type: "text",
          key: "clientSecret",
          message: "Google OAuth client secret",
          placeholder: "from your Google Cloud Desktop-app client",
        },
      ],
      // No upfront prompts: begin() opens the browser and returns a waiting state; the loopback
      // catches the redirect. The wizard renders a "waiting" step (loginStyle: "browser"), no code.
      loginPrompts: [],
      capabilities: CAPS,
    },
    capabilities: () => CAPS,
    login,
    connect,
  }
}
