export * as Quality from "./quality"

import { Schema } from "effect"

/**
 * THE QUALITY COMMAND SHAPES, in the package both sides of the contract can reach.
 *
 * 🔴 The five slots were a TypeScript interface in `core/src/session/runner/quality.ts` and a
 * hand-written `Schema.Struct` in `core/src/tool/quality-provision.ts` — the same five names
 * declared twice, with nothing holding them equal. They live here once now: `runner/quality.ts`
 * derives its type from this, the tool's overrides reuse it, and `packages/protocol` can declare a
 * route that carries them (ruling 11: one contract, and it is that package).
 */

/**
 * The five quality slots, in the order the runner spends them.
 *
 * ⚠️ `syntax` and `check` are PER WRITTEN FILE and may carry a `{file}` placeholder; `typecheck`,
 * `test` and `lint` are whole-project and never see one. That distinction is not cosmetic — filing a
 * whole-project verifier in a per-file slot makes it report, on every single write, a fault that
 * does not exist. See `FILE_RENDERED_SLOTS` in `core/src/session/runner/quality-provision.ts`.
 */
export const Commands = Schema.Struct({
  syntax: Schema.String.pipe(Schema.optional),
  check: Schema.String.pipe(Schema.optional),
  typecheck: Schema.String.pipe(Schema.optional),
  test: Schema.String.pipe(Schema.optional),
  lint: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "QualityCommands" })
export type Commands = Schema.Schema.Type<typeof Commands>

/**
 * What a manifest scan proposes, and WHY — the evidence is not decoration. A detection that fills
 * five boxes without saying which manifest produced which command asks the user to trust it; the
 * trail lets them check it. Same reason the tool hands the model its evidence.
 */
export const Detection = Schema.Struct({
  commands: Commands,
  evidence: Schema.Array(Schema.String),
}).annotate({ identifier: "QualityDetection" })
export type Detection = Schema.Schema.Type<typeof Detection>
