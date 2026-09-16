export * as TaxonomyScaffold from "./taxonomy-scaffold"

import type { ModelV2 } from "../../model"

// Models item (c) — wire the model's capability CLASS into the system prompt so the harness scaffolds
// a weak model harder than a strong one (the Juvenile Harness thesis, jh.md: small models fail from
// lack of horizon, not knowledge — so supply it in-band). Composed after the persona baseline, like
// the T9 expertise hint.
//
// 🔴 **`fast` is the only class that gets scaffolded, and that is the whole conversion.** The former
// six-band ladder (`micro`..`frontier`, derived from a Terminal-Bench percentage) treated "small" as
// a band below the mainstream; under the three-word taxonomy the model a person rates `fast` IS the
// one they have told us is only good for labeling and searching, so it gets the explicit
// work-in-small-verified-steps stance. A model rated `usual` is the mainstream coding/administration
// model and a `smart` one is deliberately over-provisioned: nagging either trains the model to
// distrust a plan that is fine.

const FAST =
  "You are a small local model. Work in SMALL, VERIFIED steps: make ONE change at a time and check it (compile, run, or read the output) before the next. Keep an explicit plan of what remains, re-read it often, and prefer a simple direct solution over a clever one. If a step fails, fix that one thing before moving on."

export const scaffold = (taxonomy: ModelV2.Taxonomy | undefined): string | undefined =>
  taxonomy === "fast" ? FAST : undefined
