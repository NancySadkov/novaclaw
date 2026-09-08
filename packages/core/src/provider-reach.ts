export * as ProviderReach from "./provider-reach"

import { Effect } from "effect"
import { Offline } from "./offline"

/**
 * Does a configured provider actually ANSWER?
 *
 * The second of Nova Health's two missing probes
 * (`notes/reports/nova-health-inputs-2026-08-11.md`). `ProviderV2` knows what is CONFIGURED; nothing
 * knew what responds, so "your model provider is down" was a thing a user could only discover by
 * sending a turn and watching it fail.
 *
 * ## Four verdicts, because three of them are routinely confused
 *
 * `ok` · `unreachable` · `blocked` · `unknown`. The one that matters is **`blocked`**, and this
 * module exists partly to keep it distinct: when offline mode refuses an egress, the request fails,
 * and calling that "unreachable" would tell a user their provider is broken when the truth is that
 * *they turned the airgap on*. `offline.ts` already went to some length for exactly this — the
 * platform's error union has no arm for a policy verdict, so it smuggles an `EgressBlocked` marker
 * through the cause rather than let a block read as a malformed URL. Collapsing that back into
 * "unreachable" here would undo it at the last step.
 *
 * ## Egress posture
 *
 * ⚠️ This is the only Nova Health signal that COSTS network, so it never runs on its own. There is no
 * interval and no boot hook: a caller asks, and a health screen that quietly contacted every
 * configured provider on open would not be the local-first promise. Loopback is exempt from the
 * airgap by `Offline`'s own rule (the app talking to itself is not egress), so a local model server
 * stays probeable with the WAN sealed.
 */

export type Verdict = "ok" | "unreachable" | "blocked" | "unknown"

export interface Reach {
  readonly verdict: Verdict
  /** Round-trip in ms when the endpoint answered. */
  readonly ms?: number
  /** What went wrong, in the transport's own words. Absent when `ok`. */
  readonly detail?: string
}

/** Milliseconds before an unanswered probe is called unreachable. */
export const TIMEOUT_MS = 4_000

const looksBlocked = (error: unknown): boolean => {
  // `EgressBlocked` rides in the cause; the shapes differ by how the failure was wrapped, so match
  // the marker's own name rather than a structural path that a re-wrap would break.
  const text = String(
    (error as { cause?: unknown })?.cause ?? (error as { message?: unknown })?.message ?? error ?? "",
  )
  return text.includes("EgressBlocked") || text.includes("offline")
}

/**
 * Probe one endpoint.
 *
 * `fetcher` is injected so this stays testable without a network and without the platform client —
 * the verdict logic is the whole of what can be got wrong, and it is pure given a response.
 */
export const probe = (input: {
  readonly url: string
  readonly fetcher: (url: string, signal: AbortSignal) => Promise<{ readonly ok: boolean; readonly status: number }>
  readonly now?: () => number
  readonly timeoutMs?: number
}): Effect.Effect<Reach> =>
  Effect.promise(async () => {
    const now = input.now ?? Date.now
    const started = now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TIMEOUT_MS)
    try {
      const response = await input.fetcher(input.url, controller.signal)
      const ms = now() - started
      // ANY answer means reachable. A 401 or a 404 is the endpoint declining to serve us, which is a
      // configuration or credential problem — not the network being down, and not something a
      // reachability probe should relabel. It says `ok` and lets the caller read the status.
      return response.ok || response.status > 0
        ? { verdict: "ok" as const, ms }
        : { verdict: "unknown" as const, detail: "no status from the transport" }
    } catch (error) {
      if (looksBlocked(error)) return { verdict: "blocked" as const, detail: "offline mode refused this egress" }
      const detail = String((error as { message?: unknown })?.message ?? error).slice(0, 200)
      return controller.signal.aborted
        ? { verdict: "unreachable" as const, detail: `no answer within ${input.timeoutMs ?? TIMEOUT_MS} ms` }
        : { verdict: "unreachable" as const, detail }
    } finally {
      clearTimeout(timer)
    }
  })

/**
 * Would a probe of this host be blocked before it left the machine?
 *
 * Answering from the POLICY rather than by trying costs nothing and is honest: with the airgap on,
 * a WAN provider is `blocked`, and reporting that without a failed request is both faster and more
 * accurate than inferring it from a timeout.
 */
export const blockedByPolicy = (policy: Offline.Policy, url: string): boolean => {
  if (!policy.enabled) return false
  const host = Offline.hostFromUrl(url)
  if (host === undefined) return false
  if (Offline.isLoopbackHost(host)) return false
  return !policy.allowedHosts.has(host)
}

/**
 * WHICH provider a health board speaks for.
 *
 * The question a person opens Nova Health with is *"can I talk to my model?"* — singular. An
 * instance may have a dozen providers configured, most of them never used, and a board that listed
 * every one would answer a question nobody asked while multiplying the only reading that costs
 * egress. So the board speaks for the provider behind the **default model**: the one a new session
 * opens with, and therefore the one whose outage the user would actually feel.
 *
 * ⚠️ **No default model means NO row, not a row about nothing.** A user who has not chosen a model
 * has no provider to be told about, and inventing one — "unknown", "not configured" — would put a
 * worry on the screen that the rest of the product does not share. `NovaHealth`'s rule is to say
 * nothing rather than manufacture a concern.
 *
 * ⚠️ **Two sources, and the CONFIGURED one wins.** A provider the user actually set up carries its
 * address at `providers[id].api.url` — that is the URL turns are sent to. `provider_presets` only
 * describes builtins and import defaults. Reading presets alone reported *"No address is configured
 * for this provider"* about a working, actively-used provider (measured 2026-08-12 against a live
 * instance whose default model was `spark-holo/holo3.1`), which is precisely the false description
 * this module exists to prevent — and it would have shipped had the row not been exercised.
 */
export interface Target {
  readonly name: string
  /** Absent when the provider is known by name but has no address to probe. */
  readonly baseURL?: string
}

export const targetOf = (input: {
  /** `config.model`, in `provider/model` form. */
  readonly model: string | undefined
  /** `config.providers` — what the user actually configured; its `api.url` is where turns go. */
  readonly providers?: Readonly<Record<string, { readonly api?: { readonly url?: string | undefined } }>>
  /** `ConfigProviderPreset.effective(...)` — builtins plus overrides. */
  readonly presets: Readonly<Record<string, { readonly baseURL?: string | undefined }>>
}): Target | undefined => {
  const model = input.model?.trim()
  if (!model) return undefined
  // Split on the FIRST slash only: a model id may itself contain slashes
  // (`nvidia/Qwen3.6-35B-A3B-NVFP4`), and splitting on the last would name a provider that does
  // not exist and then report it unreachable.
  const slash = model.indexOf("/")
  const name = slash === -1 ? model : model.slice(0, slash)
  if (!name) return undefined
  const configured = input.providers?.[name]?.api?.url
  const baseURL = configured !== undefined && configured !== "" ? configured : input.presets[name]?.baseURL
  return baseURL === undefined || baseURL === "" ? { name } : { name, baseURL }
}

