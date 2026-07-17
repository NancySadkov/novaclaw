import type { ModelV2Info } from "@novaclaw/sdk/v2"

// Derivations over the native catalog model shape (ModelV2Info): cost is an
// array of (possibly context-tiered) entries, variants an array of request
// presets, modalities plain string arrays.

/** The base (untiered) cost entry, if the model carries any cost data. */
export function modelCost(model: Pick<ModelV2Info, "cost">) {
  return model.cost.find((c) => !c.tier) ?? model.cost[0]
}

/** Variant ids (reasoning-effort presets and the like). */
export function modelVariantIDs(model: Pick<ModelV2Info, "variants">) {
  return model.variants.map((v) => v.id)
}

/** A model "reasons" iff it publishes reasoning-effort variants. */
export function modelReasoning(model: Pick<ModelV2Info, "variants">) {
  return model.variants.length > 0
}

export function modelHasInput(model: Pick<ModelV2Info, "capabilities">, kind: string) {
  return model.capabilities.input.some((m) => m.startsWith(kind))
}
