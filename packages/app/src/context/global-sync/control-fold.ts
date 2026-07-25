import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"

// ui-arch-hardening P2 — live session records. The V2 CONTROL events (session.next.*.switched)
// update the server row, but the client record channel is the V1 `session.created/updated`
// vocabulary — without this fold, every open view keeps a stale record until reload (composer
// chips, the info sheet, a second browser tab). This maps each control event onto the record
// patch the server projector applies to SessionTable, client-side. Pure + unit-tested.
//
// Convention (app AGENTS.md → UI conventions): a new per-session control MUST add its case here
// (or ship a documented staleness caveat) — never silently stale.

type Envelope = { type: string; properties?: unknown }

export type ControlPatch = { sessionID: string; patch: Record<string, unknown> }

export function controlPatch(event: Envelope): ControlPatch | undefined {
  const props = (event.properties ?? {}) as Record<string, unknown>
  const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
  if (!sessionID) return undefined
  switch (event.type) {
    case "session.next.agent.switched":
      return { sessionID, patch: { agent: props.agent } }
    case "session.next.model.switched": {
      const model = props.model as { id: string; providerID: string; variant?: string } | undefined
      return { sessionID, patch: { model } }
    }
    case "session.next.responder.switched":
      return { sessionID, patch: { responder: props.responder } }
    case "session.next.mode.switched":
      return { sessionID, patch: { permissionMode: props.permissionMode } }
    case "session.next.strict.switched":
      // `null` clears the override back to inherit — the record field goes absent, not null.
      return { sessionID, patch: { strict: props.strict ?? undefined } }
    case "session.next.feature.switched": {
      const feature = props.feature
      // Explicit comparisons, not an array `includes` — only these narrow `feature` to a key the
      // patch below can be indexed by.
      if (
        feature !== "introspection" &&
        feature !== "quality" &&
        feature !== "affective" &&
        feature !== "thinkingBudget" &&
        feature !== "surgicalEdits" &&
        feature !== "askBeforeChanges"
      )
        return undefined
      return { sessionID, patch: { [feature]: props.enabled ?? undefined } }
    }
    case "session.next.type.switched":
      return { sessionID, patch: { type: props.sessionType } }
    case "session.next.prompt-override.switched":
      return { sessionID, patch: { systemPromptOverride: props.override ?? undefined } }
    case "session.next.moved": {
      const location = props.location as { directory?: string } | undefined
      if (!location?.directory) return undefined
      // T3 record shape: the directory lives INSIDE `location` (info.ts folds row.directory into
      // the location struct) and the move's optional subdirectory is the record's `subpath`.
      // Patching a top-level `directory` (the pre-T3 flat field) was a silent no-op for every
      // reader — the composer folder chip and the Chats grouping kept the OLD folder until a
      // full reload (owner-hit 2026-07-22).
      return { sessionID, patch: { location, subpath: props.subdirectory ?? undefined } }
    }
    default:
      return undefined
  }
}

/** Apply a control patch onto a mutable session record draft (undefined values CLEAR fields). */
export function applyControlPatch(draft: Session, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (draft as Record<string, unknown>)[key]
    else (draft as Record<string, unknown>)[key] = value
  }
}
