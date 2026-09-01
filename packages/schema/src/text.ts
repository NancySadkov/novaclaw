/**
 * Small text helpers that more than one package needs, in the leaf so they can be shared at all.
 *
 * ⚠️ `packages/llm` does not depend on `@novaclaw/core` (core depends on llm), so a helper both of
 * them use has exactly one legal home, and this is it. Check the manifests before proposing a
 * different one.
 */

/**
 * Quote a literal so it can be embedded in a `RegExp` source.
 *
 * There were three byte-identical copies of this — `core/src/messenger/pipeline.ts` (as
 * `escapeRegex`), `core/src/observability/log-file.ts` and
 * `llm/src/protocols/utils/tool-recovery.ts` — each one line, each in a place where getting the
 * character class wrong turns a literal match into a wildcard.
 */
export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
