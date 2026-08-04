export * as MergePatch from "./merge-patch"

/**
 * Deep patch-merge with the updateConfig contract: objects merge recursively, arrays and
 * primitives replace. A LEAF module (no imports) — shared by the config write router and the
 * settings seed without creating an import cycle through config.ts.
 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (
    base === null ||
    patch === null ||
    typeof base !== "object" ||
    typeof patch !== "object" ||
    Array.isArray(base) ||
    Array.isArray(patch)
  ) {
    return patch
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? mergePatch(result[key], value) : value
  }
  return result
}
