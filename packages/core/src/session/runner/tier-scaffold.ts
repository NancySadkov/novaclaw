export * as TierScaffold from "./tier-scaffold"

import type { ModelV2 } from "../../model"

// Models item (c) — wire the model's capability tier into the system prompt so the harness
// scaffolds a WEAK model harder than a strong one (the Juvenile Harness thesis, jh.md: small models
// fail from lack of horizon, not knowledge — so supply it in-band). Composed after the persona
// baseline, like the T9 expertise hint. Micro/Tiny get an explicit work-in-small-verified-steps
// stance; Small a lighter nudge; Medium and up get nothing (a capable model shouldn't be nagged).
// Pure + tested; the runner reads the resolved model's tier and drops this line into the system array.

const MICRO =
  "You are a small local model. Work in SMALL, VERIFIED steps: make ONE change at a time and check it (compile, run, or read the output) before the next. Keep an explicit plan of what remains, re-read it often, and prefer a simple direct solution over a clever one. If a step fails, fix that one thing before moving on."

const SMALL =
  "You are a compact local model. Take deliberate steps and verify each one (compile/run/read output) before continuing; keep your remaining plan explicit."

export const tierScaffold = (tier: ModelV2.Tier | undefined): string | undefined => {
  switch (tier) {
    case "micro":
    case "tiny":
      return MICRO
    case "small":
      return SMALL
    default:
      // medium, large, frontier, or unknown (undefined / "guess") — no scaffolding.
      return undefined
  }
}
