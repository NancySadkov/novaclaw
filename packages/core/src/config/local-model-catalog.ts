export * as ConfigLocalModelCatalog from "./local-model-catalog"

import { Schema } from "effect"

/**
 * Runtime repair surface for the managed local-model acquisition catalog.
 *
 * Defaults stay compiled beside the runtime that consumes them, but every network location and
 * integrity identity can be replaced through PATCH /config without rebuilding NovaClaw. Filenames and
 * launch flags intentionally remain compiled: changing those is a runtime implementation upgrade, not
 * repairing a mirror or republished artifact.
 */
export class Artifact extends Schema.Class<Artifact>("ConfigV2.LocalModelArtifact")({
  url: Schema.String.pipe(Schema.optional),
  sha256: Schema.String.pipe(Schema.optional),
}) {}

export class ModelArtifact extends Schema.Class<ModelArtifact>("ConfigV2.LocalModelModelArtifact")({
  url: Schema.String.pipe(Schema.optional),
  sha256: Schema.String.pipe(Schema.optional),
  sourceURL: Schema.String.pipe(Schema.optional),
  downloadBytes: Schema.Finite.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.LocalModelCatalog")({
  runtime: Artifact.pipe(Schema.optional),
  models: Schema.Record(Schema.String, ModelArtifact).pipe(Schema.optional),
}) {}
