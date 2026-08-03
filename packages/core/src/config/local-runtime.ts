export * as ConfigLocalRuntime from "./local-runtime"

// S0 — "you may not need the sidecar": find the model server the user ALREADY runs.
//
// A fresh install has NO providers and that is CORRECT (AGENTS.md → Config) — but the designed path
// through it currently asks a normal person what a base URL is. If Ollama or LM Studio is already
// running on this machine, the honest answer is that NovaClaw should find it and say so. That is
// *fire handed over warm* instead of homework, and it costs one loopback sweep instead of a
// multi-GB download.
//
// WHAT THIS MODULE IS: pure data + pure classification. It performs no I/O of its own — the caller
// injects a `probe` function. Two reasons, both load-bearing:
//   · the probe that actually opens the socket is the SERVER-side `POST /provider/:id/probe`
//     handler, and it must stay server-side: the UI and the runtime need never share a machine
//     (AGENTS.md → P2P instances), so a browser-side fetch to `localhost:11434` would probe the
//     WRONG BOX — the user's laptop instead of the instance that will serve the turn;
//   · a pure classifier is testable without a network, and a test suite that probes real ports is
//     a flaky suite and possibly an egress one.
//
// ⚠️ NOT a provider preset, and deliberately not in `provider-preset.ts`. A preset is a branded
// catalogue entry with a key URL and a vendor behind it; the roadmap rules one out explicitly
// (`todo/sidecar-inference.md` → *Explicitly NOT adopted*: "A branded 'Ollama' preset in the
// kernel"). What is below is a list of PORT NUMBERS plus the generic OpenAI-compatible shape check
// we already ship. No vendor enters the kernel, no key is requested, nothing is hosted.

/** A loopback endpoint worth asking whether anything model-shaped is listening on it. */
export interface Candidate {
  /** The provider id we would suggest if the user adopts it. Must satisfy `/^[a-z0-9][a-z0-9-_]*$/`. */
  readonly id: string
  /** Display name for the suggested provider entry. */
  readonly label: string
  /**
   * The runtime that CONVENTIONALLY listens on this port — a hint for the user, never a claim.
   * Ruling 2 (*a fault is never described falsely*) cuts here: we verify a `/v1/models` answer at a
   * port, which is not the same as verifying that Ollama is the program that answered. The UI says
   * "usually Ollama", and what it asserts is the endpoint.
   */
  readonly usually: string
  readonly port: number
  /** Full OpenAI-compatible base URL, `/v1` included — the probe appends `/models`. */
  readonly baseURL: string
}

/**
 * The probe list. Compiled-in DEFAULTS, not a vendor catalogue — see the header note.
 *
 * ⚠️ LOOPBACK ONLY. Do not add a LAN address here, and `sweep` refuses one anyway (see
 * `isLoopbackURL`). A port sweep of the user's network, from a product whose headline promise is
 * that data never egresses, is the wrong instinct even when the packets stay local — and LAN
 * discovery already has an owner (the shipped R-series remote-access work).
 *
 * The self-healing law (AGENTS.md) wants operational facts in a runtime-editable store. These are
 * not vendor endpoints that can move under a user — they are the published default ports of four
 * programs — and the runtime-editable path for anything else is the one already shipped: type it
 * into *Custom endpoint*. `sweep` still takes a `candidates` override so a store can feed it later
 * without reshaping the seam.
 */
export const CANDIDATES: readonly Candidate[] = [
  { id: "ollama", label: "Ollama", usually: "Ollama", port: 11434, baseURL: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio", usually: "LM Studio", port: 1234, baseURL: "http://localhost:1234/v1" },
  { id: "vllm", label: "vLLM", usually: "vLLM", port: 8000, baseURL: "http://localhost:8000/v1" },
  {
    id: "llamacpp",
    label: "llama.cpp",
    usually: "llama.cpp (llama-server)",
    port: 8080,
    baseURL: "http://localhost:8080/v1",
  },
]

/** The `/provider/:id/probe` result shape, restated structurally so this module imports nothing. */
export interface ProbeLike {
  readonly status: "ok" | "unreachable" | "auth" | "model-missing" | "no-url" | "error"
  readonly models?: readonly string[] | undefined
  readonly limits?: Readonly<Record<string, { readonly context?: number; readonly output?: number }>> | undefined
  readonly detail?: string | undefined
  readonly latencyMs?: number | undefined
}

/**
 * What we can honestly say about one candidate. Six arms rather than found/not-found, because the
 * two-arm version is the ruling-2 violation: it has to file "something answered but it is not a
 * model server" and "nothing is listening" under one word, and it has nowhere at all to put "we
 * could not check".
 */
export type Outcome =
  /** A `/v1/models` answer carrying at least one model id. The only arm that claims a runtime. */
  | {
      readonly kind: "found"
      readonly candidate: Candidate
      readonly models: readonly string[]
      readonly limits?: Readonly<Record<string, { readonly context?: number; readonly output?: number }>>
      readonly latencyMs?: number
    }
  /** Something is listening and demands credentials (401/403). Adoptable, but the user needs a key. */
  | { readonly kind: "needs-key"; readonly candidate: Candidate; readonly detail?: string }
  /**
   * Something answered, but not with a model list — a 200 of HTML, a JSON API that is not a model
   * server, or a model server with nothing loaded. We cannot tell those apart from the outside and
   * must not pretend to: this is NEVER offered as a found runtime.
   */
  | { readonly kind: "unidentified"; readonly candidate: Candidate; readonly detail?: string }
  /** Nothing is listening (connection refused / timed out / an HTTP error). */
  | { readonly kind: "absent"; readonly candidate: Candidate; readonly detail?: string }
  /** The probe itself could not be performed. NOT "nothing found" — we learned nothing. */
  | { readonly kind: "unknown"; readonly candidate: Candidate; readonly detail?: string }
  /** Refused before any socket was opened: the URL is not loopback. */
  | { readonly kind: "not-loopback"; readonly candidate: Candidate; readonly detail: string }

/** Arms a user can act on right now — `found` first, since it needs no typing at all. */
export const ADOPTABLE: readonly Outcome["kind"][] = ["found", "needs-key"]

/** Arms that represent a real verdict about the port (as opposed to "we could not look"). */
const CONCLUSIVE: readonly Outcome["kind"][] = ["found", "needs-key", "unidentified", "absent"]

/**
 * Loopback, by the SAME definition the offline policy uses (`offline.ts` → `isLoopbackHost`):
 * `localhost`, `127.0.0.0/8`, `::1`.
 *
 * ⚠️ Duplicated rather than imported ON PURPOSE, and the duplication is pinned by a test.
 * `offline.ts` pulls in `fs`, `path`, `effect` and the SQLite binding; this module is imported by
 * the browser bundle, where none of those resolve. `config-local-runtime.test.ts` imports BOTH and
 * fails if the two predicates ever disagree, so the drift this would otherwise invite is mechanical
 * rather than hoped-for.
 */
export function isLoopbackURL(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * One probe answer → one honest verdict.
 *
 * ⚠️ The `ok && no models` case is the whole reason this function exists. The shipped probe handler
 * classifies ANY 200 as `ok`: it calls `response.json()`, swallows the parse failure, and falls
 * through to `models: []`. So a random web server on `:8000` — this box has one — comes back as
 * `{status:"ok", models:[]}`, and a sweep that trusted `status` alone would announce it as a found
 * model runtime. We check the SHAPE (a model list with at least one id), never the port being open.
 */
export function classify(candidate: Candidate, probe: ProbeLike): Outcome {
  if (!isLoopbackURL(candidate.baseURL))
    return { kind: "not-loopback", candidate, detail: `${candidate.baseURL} is not a loopback address` }
  if (probe.status === "auth") return { kind: "needs-key", candidate, detail: probe.detail }
  if (probe.status === "ok" || probe.status === "model-missing") {
    const models = (probe.models ?? []).filter((id) => typeof id === "string" && id.length > 0)
    if (models.length > 0)
      return {
        kind: "found",
        candidate,
        models,
        ...(probe.limits === undefined ? {} : { limits: probe.limits }),
        ...(probe.latencyMs === undefined ? {} : { latencyMs: probe.latencyMs }),
      }
    return {
      kind: "unidentified",
      candidate,
      detail: probe.detail ?? "answered, but listed no models — not necessarily a model server",
    }
  }
  // unreachable | error | no-url — nothing model-shaped is there.
  return { kind: "absent", candidate, detail: probe.detail }
}

/** A probe call that threw: the instance could not be reached, so we learned NOTHING about the port. */
export function classifyFailure(candidate: Candidate, error: unknown): Outcome {
  const detail = error instanceof Error ? error.message : String(error)
  return { kind: "unknown", candidate, detail: detail.slice(0, 200) }
}

export interface SweepResult {
  /** Every candidate's verdict, in candidate order. */
  readonly outcomes: readonly Outcome[]
  /** `found` then `needs-key` — the ones a user can act on. */
  readonly adoptable: readonly Outcome[]
  /** How many candidates produced a real verdict about their port. */
  readonly answered: number
  /**
   * `false` = the sweep could not run (every probe call failed). Ruling 2: this is NOT "none found",
   * and the UI must say so differently — "couldn't check" and "nothing here" are different facts.
   */
  readonly ran: boolean
}

export interface SweepInput {
  /**
   * Runs ONE probe. In the app this is the shipped `POST /provider/:id/probe` with a payload
   * `baseURL` — so the socket opens on the instance's machine, not the browser's. Rejecting means
   * "we could not ask", which is different from a probe that answers `unreachable`.
   */
  readonly probe: (candidate: Candidate) => Promise<ProbeLike>
  /** Defaults to `CANDIDATES`. */
  readonly candidates?: readonly Candidate[]
}

/**
 * Ask every candidate at once and classify the answers.
 *
 * ⚠️ WHEN this runs is a design decision, not an implementation detail: at the moment the user opens
 * *Add models*, never at boot. Four TCP connects on every launch is a startup cost paid by every
 * machine that has none of them, and startup speed is first-class here. The Add-models moment costs
 * nothing at launch and still covers first run, because a model-less install already routes straight
 * into that dialog (`dialog-select-model.tsx`, owner 2026-07-27).
 *
 * ⚠️ OFFLINE: a loopback sweep is legal while airgapped and is NOT suppressed. `offline.ts`'s
 * `checkUrl` allows loopback unconditionally — "the app talking to itself is not egress; the airgap
 * threat model is the WAN" — and an airgapped user is precisely the one whose ONLY possible model is
 * a local one. The guard is honoured by construction instead: every candidate is asserted loopback
 * here, before a socket is opened, so this can never become the LAN scan the guard would have to
 * catch.
 */
export async function sweep(input: SweepInput): Promise<SweepResult> {
  const candidates = input.candidates ?? CANDIDATES
  const outcomes = await Promise.all(
    candidates.map(async (candidate): Promise<Outcome> => {
      if (!isLoopbackURL(candidate.baseURL))
        return { kind: "not-loopback", candidate, detail: `${candidate.baseURL} is not a loopback address` }
      try {
        return classify(candidate, await input.probe(candidate))
      } catch (error) {
        return classifyFailure(candidate, error)
      }
    }),
  )
  const rank = (outcome: Outcome) => (outcome.kind === "found" ? 0 : 1)
  const adoptable = outcomes.filter((outcome) => ADOPTABLE.includes(outcome.kind)).sort((a, b) => rank(a) - rank(b))
  const answered = outcomes.filter((outcome) => CONCLUSIVE.includes(outcome.kind)).length
  return { outcomes, adoptable, answered, ran: answered > 0 }
}

/** Compare two endpoint URLs the way a user means it: trailing slashes and case are not identity. */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (url: string) => url.trim().toLowerCase().replace(/\/+$/, "")
  return norm(a) === norm(b)
}

/**
 * Drop candidates the instance has already got. Reopening *Add models* after adopting Ollama should
 * not keep offering Ollama — an offer the user has already accepted reads as the product not
 * knowing what it did.
 */
export function excludeConfigured(outcomes: readonly Outcome[], configuredURLs: readonly string[]): readonly Outcome[] {
  return outcomes.filter((outcome) => !configuredURLs.some((url) => sameEndpoint(url, outcome.candidate.baseURL)))
}

/**
 * A provider id that is free. The suggested id is a convenience, not a claim on the namespace: if
 * `ollama` is taken by a provider pointing somewhere else, silently overwriting its endpoint would
 * break a working setup to install a new one.
 */
export function uniqueProviderID(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
