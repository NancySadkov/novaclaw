/**
 * Records `ajv`'s answer for every case in `json-schema-conformance-corpus.ts` into
 * `json-schema-conformance-expected.json`, under the exact options `tool-router.ts` used. Run ONCE,
 * on a tree where `ajv` is still installed:
 *
 *     cd packages/core && bun test/json-schema-conformance-record.ts
 *
 * Kept so the recording can be re-done if the corpus grows (`bun add -d ajv` ad hoc, then remove
 * it again). It is not a test and `bun test` ignores it.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CASES } from "./json-schema-conformance-corpus"

// A string specifier, on purpose: `ajv` is no longer a dependency of this package.
const { default: Ajv } = (await import("ajv" as string)) as {
  default: new (options: object) => {
    validate: (schema: unknown, value: unknown) => boolean
    errors?: ReadonlyArray<{ instancePath: string; keyword: string }> | null
  }
}
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false, validateFormats: false })

export interface Recorded {
  readonly ok: boolean
  /** Sorted, de-duplicated `instancePath:keyword`, the shape `tool-router.ts` joins into `detail`. */
  readonly errors: ReadonlyArray<string>
  readonly threw?: string
}

const recorded: Recorded[] = CASES.map((c) => {
  try {
    const ok = ajv.validate(c.schema, c.value)
    const errors = [...new Set((ajv.errors ?? []).map((e) => `${e.instancePath || "/"}:${e.keyword}`))].sort()
    return { ok, errors }
  } catch (error) {
    return { ok: false, errors: [], threw: error instanceof Error ? error.message : String(error) }
  }
})
writeFileSync(join(import.meta.dir, "json-schema-conformance-expected.json"), JSON.stringify(recorded, null, 1))
console.log(
  `recorded ${recorded.length} verdicts from ajv; ${recorded.filter((r) => r.ok).length} ok, ${recorded.filter((r) => r.threw).length} threw`,
)
