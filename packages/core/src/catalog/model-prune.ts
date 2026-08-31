export * as ModelPrune from "./model-prune"

import { MergePatch } from "../merge-patch"
import type { ConfigProvider } from "../config/provider"

/**
 * Removing ONE model from a provider's stored config layers.
 *
 * **Why this exists as its own leaf.** Until 2026-08-06 a stale model could not be removed from the
 * catalog at all: `PATCH /config` merges (its `mergePatch` treats `null` as a *value*, not a
 * deletion, and providers additionally fold through `collapseLayers`), the only server-side delete
 * took a whole provider, and the Models tab's trash button wrote a **client-side** preference. So a
 * destructive-looking confirm dialog performed a per-browser hide while stating an instance-wide
 * fact — todo.md ruling 2 on the very surface the self-healing law leans on, since an agent asked to
 * clean up a catalogue of dead endpoints could not do it without removing bystanders.
 *
 * The decision is pure and therefore lives here, apart from the store: what to strip, from which
 * layers, and — the part that is easy to get silently wrong — whether anything was actually stripped.
 */

/**
 * Strip `modelID` from every layer of one provider.
 *
 * Returns `undefined` when the model appears in **no** layer. That distinction is the whole point of
 * the return type: a caller that cannot tell "removed" from "was never there" has to report success
 * either way, which is the failed-mutation-reports-success shape ruling 2 forbids. The HTTP layer
 * turns `undefined` into a 404 rather than a cheerful 204.
 *
 * ⚠️ **A provider whose last model is stripped is KEPT, deliberately.** It still carries the endpoint
 * URL, auth and request defaults — the expensive, hand-authored part — and a user pruning one stale
 * entry has not asked to forget how to reach the host. Removing the provider is a separate, explicit
 * act (`provider.remove`). Do not "tidy" this into a cascade: the surprise is not recoverable from
 * the UI, and re-authoring an endpoint is exactly the work the prune was trying to avoid.
 *
 * ⚠️ Layers are rewritten rather than filtered away even when a layer becomes model-less, because a
 * layer carries more than its `models` map and the fold that merges them is positional. Dropping an
 * emptied layer would silently change how the remaining layers combine.
 *
 * ⚠️ **The stripping itself is `MergePatch.removeAt`, and sharing it is the point** (item 4.3,
 * 2026-08-07). The general config-removal verb prunes every layered store the same way, so a
 * private copy of this loop here would be a second implementation of one rule — the drift
 * `ConfigStoreWrite.refreshDomain` already warns about, at a place where a divergence means one
 * delete route strips a layer the other leaves behind. What stays local is everything ABOVE the
 * strip: which layers, the found/not-found distinction, and the provider-is-kept decision.
 */
export const stripModel = (
  layers: ReadonlyArray<ConfigProvider.Info>,
  modelID: string,
): ConfigProvider.Info[] | undefined => {
  let found = false
  const next = layers.map((layer) => {
    const pruned = MergePatch.removeAt(layer, ["models", modelID])
    if (pruned === undefined) return layer
    found = true
    return pruned.value as ConfigProvider.Info
  })
  return found ? next : undefined
}

/**
 * Does `ref` (a stored `providerID/modelID` default) name exactly this model?
 *
 * ⚠️ **Split on the FIRST slash only.** Model ids routinely contain slashes — `openai/gpt-oss-120b`,
 * `hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL` — so a naive `split("/")` destructure both mangles
 * the id and, worse, can make two different models compare equal. Validate the stored reference as
 * one provider prefix plus the remaining model id; a bare model id is not a provider-qualified ref.
 */
export const refNamesModel = (ref: string | undefined, providerID: string, modelID: string): boolean => {
  if (ref === undefined) return false
  const slash = ref.indexOf("/")
  if (slash <= 0) return false
  return ref.slice(0, slash) === providerID && ref.slice(slash + 1) === modelID
}
