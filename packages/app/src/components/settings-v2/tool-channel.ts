// Settings → Models → configure: WHICH tool channel this model is on, and who decided.
//
// The channel decides whether the agent is offered tools natively, described in the prompt, or not
// at all. When it is wrong the agent silently cannot act, and the chat reads as a model refusing —
// so the one thing this surface owes the user is *who chose this*, in plain words, next to the way
// to change it.
//
// ⚠️ The client does NOT recompute the fingerprint. Staleness is the server's business (it compares
// the stored fingerprint against the live one when a model resolves); a second implementation here
// would be free to disagree, and a Settings screen that disagrees with the runner about what is in
// force is worse than one that says less.

export type ToolChannel = "native" | "prompted"

export type ChannelSource =
  /** An operator wrote it into this model's config. It beats everything else. */
  | "configured"
  /** The capability probe measured it. */
  | "measured"
  /** Nobody has said anything, so the protocol's own channel applies. */
  | "default"

export interface ChannelStatus {
  readonly channel: ToolChannel
  readonly source: ChannelSource
  /** The probe's one-sentence reason, when the answer came from a measurement. */
  readonly rationale?: string
  /** Epoch millis of the measurement, so the surface can say how old it is rather than imply fresh. */
  readonly measuredAt?: number
  /**
   * What the probe measured, when it is NOT what is in force.
   *
   * ⚠️ Reported rather than hidden. An operator override that contradicts the measurement is the
   * most confusing state this surface can be in — "I tested it and it still does the other thing" —
   * and the only cure is to show both and name which one won.
   */
  readonly overriddenMeasurement?: { readonly channel: ToolChannel; readonly rationale?: string }
  /**
   * A measured verdict that is real but not actionable: `chat-only` (no usable tool channel at all)
   * or `unknown` (we could not find out). Neither selects a channel, so the model runs on the
   * protocol default — and saying so beats showing "native" as though it had been chosen.
   */
  readonly inconclusive?: "chat-only" | "unknown"
  /**
   * The measurement was taken from a DIFFERENT endpoint than this model points at now.
   *
   * 🔴 "Never tested" and "tested, but the endpoint moved" are different facts and only the second
   * is something a person can act on. The runner already ignores the stale row (it compares
   * fingerprints when a model resolves), so the model is silently back on the protocol default —
   * and without this the screen would keep showing the old verdict as though it still applied.
   *
   * ⚠️ It does NOT re-measure. Probing costs three generations, and a screen that spends tokens
   * because you opened it is the thing `?probe=provider` exists to avoid. Saying so and offering the
   * button is the whole fix.
   */
  readonly movedFrom?: string
}

interface StoredMeasurement {
  readonly choice?: unknown
  readonly rationale?: unknown
  readonly measuredAt?: unknown
  /** Where it was measured. Compared as a FIELD — never by parsing the fingerprint. */
  readonly endpoint?: unknown
}

/** The config shape this reads, structurally, so the SDK's own types still satisfy it. */
export interface ConfigLike {
  readonly provider_capability?: Readonly<Record<string, StoredMeasurement>>
  readonly providers?: Readonly<
    Record<string, { readonly models?: Readonly<Record<string, { readonly request?: { readonly body?: unknown } }>> }>
  >
}

const channelOf = (value: unknown): ToolChannel | undefined =>
  value === "native" || value === "prompted" ? value : undefined

/** What an operator wrote for this model, if anything valid. */
export const configuredChannel = (config: ConfigLike | undefined, providerID: string, modelID: string) => {
  const body = config?.providers?.[providerID]?.models?.[modelID]?.request?.body
  if (typeof body !== "object" || body === null) return undefined
  // ⚠️ Mirrors the kernel's `configuredToolChannel`: an unknown value is IGNORED, not shown. A typo
  // must not be displayed as a decision the user made — they would go looking for the effect of a
  // setting that is not in force.
  return channelOf((body as Record<string, unknown>)["toolChannel"])
}

/**
 * Trailing slashes are not a different endpoint — the kernel's own fingerprint normalises them, and a
 * screen that disagreed would report a move nobody made.
 */
const sameEndpoint = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

export const status = (
  config: ConfigLike | undefined,
  providerID: string,
  modelID: string,
  /** Where this model points NOW. Omit when the caller cannot know; no claim is then made. */
  currentEndpoint?: string,
): ChannelStatus => {
  const configured = configuredChannel(config, providerID, modelID)
  const stored = config?.provider_capability?.[`${providerID}/${modelID}`]
  const measured = channelOf(stored?.choice)
  const rationale = typeof stored?.rationale === "string" && stored.rationale.length > 0 ? stored.rationale : undefined
  const measuredAt = typeof stored?.measuredAt === "number" ? stored.measuredAt : undefined
  const inconclusive = stored?.choice === "chat-only" || stored?.choice === "unknown" ? stored.choice : undefined
  const measuredEndpoint = typeof stored?.endpoint === "string" && stored.endpoint.length > 0 ? stored.endpoint : undefined
  // ⚠️ Only claims a move when BOTH are known. A row written before the endpoint was recorded, or a
  // caller that cannot supply the current one, must not be reported as moved — that would send
  // someone re-testing a model nothing is wrong with.
  const moved =
    measuredEndpoint !== undefined && currentEndpoint !== undefined && !sameEndpoint(measuredEndpoint, currentEndpoint)
      ? measuredEndpoint
      : undefined

  if (configured !== undefined)
    return {
      channel: configured,
      source: "configured",
      ...(measured !== undefined && measured !== configured && moved === undefined
        ? { overriddenMeasurement: { channel: measured, ...(rationale === undefined ? {} : { rationale }) } }
        : {}),
      ...(moved === undefined ? {} : { movedFrom: moved }),
      ...(inconclusive === undefined || moved !== undefined ? {} : { inconclusive }),
    }

  // A moved measurement is one the RUNNER already discards, so the model is on the protocol default.
  // Reporting it as `measured` would be the screen claiming a verdict is in force when it is not.
  if (measured !== undefined && moved === undefined)
    return {
      channel: measured,
      source: "measured",
      ...(rationale === undefined ? {} : { rationale }),
      ...(measuredAt === undefined ? {} : { measuredAt }),
    }

  return {
    channel: "native",
    source: "default",
    ...(moved === undefined ? {} : { movedFrom: moved }),
    ...(inconclusive === undefined || moved !== undefined ? {} : { inconclusive }),
    ...(rationale === undefined || moved !== undefined ? {} : { rationale }),
    ...(measuredAt === undefined ? {} : { measuredAt }),
  }
}
