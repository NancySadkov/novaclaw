export * as ProbeWindow from "./probe-window"

// B15/T3 — the last server-reported context window per provider/model, harvested by the provider
// probe endpoint (vLLM `max_model_len` in GET {baseURL}/models). This is the endpoint's HONORED
// window, authoritative over catalog/config limits: a copied config routinely claims a window the
// serving process was not launched with, and the 1M context pack then packs to the wrong size.
// Runtime-only by design: never persisted, empty after every process restart, refreshed by the
// next probe (Models-tab Test, New-Model discovery, or the composer picker's lazy probe).
const cache = new Map<string, number>()

const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`

export const remember = (providerID: string, modelID: string, window: number) => {
  cache.set(key(providerID, modelID), window)
}

export const get = (providerID: string, modelID: string): number | undefined => cache.get(key(providerID, modelID))

/** Test seam. */
export const clear = () => cache.clear()
