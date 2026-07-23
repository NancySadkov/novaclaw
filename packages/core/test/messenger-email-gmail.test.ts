import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { EmailGmailDriver } from "@novaclaw/core/messenger/driver/email-gmail"
import { EmailOAuthGoogle } from "@novaclaw/core/messenger/driver/email-oauth-google"
import type { AuthCodeClient } from "@novaclaw/core/messenger/driver/email-oauth-google"
import type { EmailClient, OutboundEmail, RawEmail, TokenSet } from "@novaclaw/core/messenger/driver/email"
import type { ConnectContext } from "@novaclaw/core/messenger/driver"
import { OAuthLoopback } from "@novaclaw/core/messenger/oauth-loopback"
import { testEffect } from "./lib/effect"

// Gmail driver gate (messenger-plan P9; owner ask 2026-07-23) — the friendly "Sign in with Google"
// auth-code + loopback flow. The PURE half (Google token/refresh parsing, PKCE, the consent-URL
// builder) is unit-tested here; the loopback catcher is exercised against a REAL localhost server;
// the driver's login + connect run against fake Google + loopback + mail seams (the live gate needs a
// real verified Google client + browser consent).

const it = testEffect(Layer.empty)

// ── the Google OAuth response parsing + PKCE + URL builder (pure) ─────────────────────────────────

describe("EmailOAuthGoogle pure helpers", () => {
  it.effect("token exchange requires access + refresh; refresh keeps the token; errors throw legibly", () =>
    Effect.sync(() => {
      const ok = EmailOAuthGoogle.parseGoogleToken({ access_token: "at", refresh_token: "rt", expires_in: 3600 }, 1000)
      expect(ok).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3600_000 })
      // No refresh token → Google withheld it (prior grant); a legible, actionable error.
      expect(() => EmailOAuthGoogle.parseGoogleToken({ access_token: "at", expires_in: 3600 }, 0)).toThrow(/refresh token/i)
      // An OAuth error body surfaces its description.
      expect(() => EmailOAuthGoogle.parseGoogleToken({ error: "invalid_grant", error_description: "bad code" }, 0)).toThrow("bad code")

      // Refresh: Google does NOT rotate the refresh token, so we keep the one we sent.
      const refreshed = EmailOAuthGoogle.parseGoogleRefresh({ access_token: "at2", expires_in: 3600 }, "rt", 2000)
      expect(refreshed).toEqual({ accessToken: "at2", refreshToken: "rt", expiresAt: 2000 + 3600_000 })
      expect(() => EmailOAuthGoogle.parseGoogleRefresh({ error: "invalid_grant", error_description: "revoked" }, "rt", 0)).toThrow("revoked")
    }),
  )

  it.effect("PKCE S256 matches the RFC 7636 Appendix B test vector; verifier is base64url", () =>
    Effect.sync(() => {
      // RFC 7636 §Appendix B canonical vector.
      expect(EmailOAuthGoogle.codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      )
      const verifier = EmailOAuthGoogle.generateCodeVerifier()
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes → 43 base64url chars, no padding
      expect(EmailOAuthGoogle.generateState()).toMatch(/^[A-Za-z0-9_-]+$/)
    }),
  )

  it.effect("buildAuthorizeUrl requests offline access + consent + PKCE, binds state + login_hint", () =>
    Effect.sync(() => {
      const url = new URL(
        EmailOAuthGoogle.buildAuthorizeUrl({
          clientId: "cid.apps.googleusercontent.com",
          scopes: ["https://mail.google.com/"],
          state: "st_1",
          codeChallenge: "chal_1",
          redirectUri: "http://127.0.0.1:5051/",
          loginHint: "me@gmail.com",
        }),
      )
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
      expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com")
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5051/")
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("scope")).toBe("https://mail.google.com/")
      expect(url.searchParams.get("access_type")).toBe("offline") // → a refresh token
      expect(url.searchParams.get("prompt")).toBe("consent") // → re-issue the refresh token
      expect(url.searchParams.get("code_challenge")).toBe("chal_1")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("state")).toBe("st_1")
      expect(url.searchParams.get("login_hint")).toBe("me@gmail.com")
    }),
  )
})

// ── the loopback catcher (a real localhost server) ───────────────────────────────────────────────

describe("OAuthLoopback (real 127.0.0.1 server)", () => {
  it.live("catches a matching-state redirect and hands back the code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loopback = yield* OAuthLoopback.startLoopback({ expectedState: "st_ok", provider: "Gmail" })
        expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
        const res = yield* Effect.promise(() => fetch(`${loopback.redirectUri}?state=st_ok&code=AUTH_CODE_123`))
        expect(res.status).toBe(200)
        expect(yield* Effect.promise(() => loopback.waitForCode)).toBe("AUTH_CODE_123")
      }),
    ),
  )

  it.live("400s a mismatched state (CSRF) and never yields a code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loopback = yield* OAuthLoopback.startLoopback({ expectedState: "st_ok" })
        loopback.waitForCode.catch(() => {}) // scope close rejects it — mark handled so the test stays quiet
        const res = yield* Effect.promise(() => fetch(`${loopback.redirectUri}?state=WRONG&code=x`))
        expect(res.status).toBe(400)
      }),
    ),
  )

  it.live("an error redirect rejects waitForCode with the provider's reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loopback = yield* OAuthLoopback.startLoopback({ expectedState: "st_ok" })
        // Attach the handler BEFORE the redirect fires (real use: the driver's fiber awaits it immediately).
        const outcome = loopback.waitForCode.then(() => "resolved").catch((error: Error) => error.message)
        const res = yield* Effect.promise(() => fetch(`${loopback.redirectUri}?state=st_ok&error=access_denied&error_description=You+said+no`))
        expect(res.status).toBe(200)
        expect(yield* Effect.promise(() => outcome)).toContain("You said no")
      }),
    ),
  )
})

// ── the Gmail driver against fake seams ──────────────────────────────────────────────────────────

const gmailAccount = new Messenger.AccountInfo({
  id: Messenger.AccountID.make("msa_gmail_oauth"),
  driverID: "email-gmail",
  label: "My Gmail",
  enabled: true,
  settings: { email: "me@gmail.com", clientId: "cid.apps.googleusercontent.com", clientSecret: "gsecret" },
})

const makeFakeGoogle = () => {
  const state = { exchanged: 0, refreshed: 0, lastCode: "", lastVerifier: "", lastRedirect: "", lastRefreshToken: "" }
  const client: AuthCodeClient = {
    buildAuthorizeUrl: ({ state: st, redirectUri }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${st}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
      state.exchanged += 1
      state.lastCode = code
      state.lastVerifier = codeVerifier
      state.lastRedirect = redirectUri
      return { accessToken: "g_access_1", refreshToken: "g_refresh_1", expiresAt: 9_999_999_999_999 } satisfies TokenSet
    },
    refresh: async (refreshToken) => {
      state.refreshed += 1
      state.lastRefreshToken = refreshToken
      return { accessToken: `g_access_${state.refreshed + 1}`, refreshToken, expiresAt: 9_999_999_999_999 } satisfies TokenSet
    },
  }
  return { factory: () => client, state }
}

/** A fake loopback whose redirect we drive by hand (resolveCode) to test the poll/completion timing. */
const makeFakeLoopback = () => {
  const state = { started: 0, opened: [] as string[], expectedState: "" }
  let resolveCode!: (code: string) => void
  const waitForCode = new Promise<string>((resolve) => {
    resolveCode = resolve
  })
  const factory = (params: { expectedState: string; provider?: string; timeoutMs?: number }) =>
    Effect.sync(() => {
      state.started += 1
      state.expectedState = params.expectedState
      return { redirectUri: "http://127.0.0.1:65000/", waitForCode }
    })
  const openBrowser = (url: string) => Effect.sync(() => void state.opened.push(url))
  return { factory, openBrowser, state, resolveCode }
}

const makeFakeMail = () => {
  const state = { auth: undefined as string | undefined, closed: false }
  const client: EmailClient = {
    fetchSince: async () => ({ uidValidity: 1, messages: [] as RawEmail[] }),
    fetchRecent: async () => ({ messages: [] as RawEmail[] }),
    send: async (_email: OutboundEmail) => ({ messageID: "x" }),
    startUid: 0,
    uidValidity: 1,
    close: async () => void (state.closed = true),
  }
  const factory = async (config: { auth: { accessToken?: string; password?: string } }) => {
    state.auth = config.auth.accessToken ?? (config.auth.password ? `pw:${config.auth.password}` : undefined)
    return client
  }
  return { factory, state }
}

const ctxFor = (secret: string | undefined): ConnectContext => ({
  account: gmailAccount,
  secret,
  cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
})

describe("EmailGmailDriver login (Google auth-code + loopback)", () => {
  it.effect("meta advertises the browser login style and a Gmail identity", () =>
    Effect.sync(() => {
      const google = makeFakeGoogle()
      const loop = makeFakeLoopback()
      const mail = makeFakeMail()
      const driver = EmailGmailDriver.make(mail.factory, google.factory, loop.factory, loop.openBrowser)
      expect(driver.id).toBe("email-gmail")
      expect(driver.meta.name).toBe("Gmail")
      expect(driver.meta.auth).toBe("login")
      expect(driver.meta.loginStyle).toBe("browser")
    }),
  )

  it.live("begin opens the browser; complete waits then yields the stored refresh token", () =>
    Effect.gen(function* () {
      const google = makeFakeGoogle()
      const loop = makeFakeLoopback()
      const mail = makeFakeMail()
      const driver = EmailGmailDriver.make(mail.factory, google.factory, loop.factory, loop.openBrowser)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* driver.login!.begin({ account: gmailAccount, inputs: {} })
          // The browser was opened at a Google consent URL bound to the loopback's state.
          expect(loop.state.started).toBe(1)
          expect(loop.state.opened).toHaveLength(1)
          expect(loop.state.opened[0]).toContain("accounts.google.com")
          expect(loop.state.opened[0]).toContain(`state=${loop.state.expectedState}`)
          expect(pending.instructions).toContain("Google sign-in")

          // Before the redirect: complete() reports "still waiting" (retryable), like device-code.
          const waiting = yield* pending.complete("").pipe(Effect.flip)
          expect(waiting._tag).toBe("MessengerDriver.LoginCodeError")
          if (waiting._tag === "MessengerDriver.LoginCodeError") expect(waiting.retryable).toBe(true)

          // The user approves → the loopback yields the code → the fiber exchanges it.
          loop.resolveCode("AUTH_CODE_XYZ")
          yield* Effect.sleep(Duration.millis(20)) // let the login fiber run the exchange

          const done = yield* pending.complete("")
          const stored = JSON.parse(done.session) as { refreshToken: string; email: string }
          expect(stored).toEqual({ refreshToken: "g_refresh_1", email: "me@gmail.com" })
          expect(done.session).not.toContain("g_access_1") // never the access token
          // The code + PKCE verifier + loopback redirect reached the exchange.
          expect(google.state.exchanged).toBe(1)
          expect(google.state.lastCode).toBe("AUTH_CODE_XYZ")
          expect(google.state.lastVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
          expect(google.state.lastRedirect).toBe("http://127.0.0.1:65000/")
        }),
      )
    }),
  )

  it.effect("begin fails legibly when no Google OAuth client is configured", () =>
    Effect.gen(function* () {
      const google = makeFakeGoogle()
      const loop = makeFakeLoopback()
      const mail = makeFakeMail()
      const driver = EmailGmailDriver.make(mail.factory, google.factory, loop.factory, loop.openBrowser)
      const noClient = new Messenger.AccountInfo({
        id: Messenger.AccountID.make("msa_gmail_noclient"),
        driverID: "email-gmail",
        label: "Gmail",
        enabled: true,
        settings: { email: "me@gmail.com" }, // no clientId, and no shipped default
      })
      const failure = yield* driver.login!.begin({ account: noClient, inputs: {} }).pipe(Effect.scoped, Effect.flip)
      expect(failure._tag).toBe("MessengerDriver.ConnectError")
      if (failure._tag === "MessengerDriver.ConnectError") expect(failure.reason).toContain("client")
      expect(loop.state.started).toBe(0) // never started a loopback
    }),
  )
})

describe("EmailGmailDriver connect", () => {
  it.live("refreshes the Google token to the XOAUTH2 access token on the Gmail wire", () =>
    Effect.gen(function* () {
      const google = makeFakeGoogle()
      const loop = makeFakeLoopback()
      const mail = makeFakeMail()
      const driver = EmailGmailDriver.make(mail.factory, google.factory, loop.factory, loop.openBrowser)
      const signedIn = JSON.stringify({ refreshToken: "g_refresh_1", email: "me@gmail.com" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* driver.connect(ctxFor(signedIn))
          expect(google.state.refreshed).toBe(1)
          expect(google.state.lastRefreshToken).toBe("g_refresh_1")
          expect(mail.state.auth).toBe("g_access_2") // the refreshed XOAUTH2 access token reached the wire
        }),
      )
    }),
  )

  it.live("an app password still works (Basic Auth fallback — no OAuth invoked)", () =>
    Effect.gen(function* () {
      const google = makeFakeGoogle()
      const loop = makeFakeLoopback()
      const mail = makeFakeMail()
      const driver = EmailGmailDriver.make(mail.factory, google.factory, loop.factory, loop.openBrowser)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* driver.connect(ctxFor("abcd efgh ijkl mnop")) // a raw app password, not OAuth JSON
          expect(mail.state.auth).toBe("pw:abcd efgh ijkl mnop")
          expect(google.state.refreshed).toBe(0)
        }),
      )
    }),
  )
})
