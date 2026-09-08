export * as VisionCopy from "./vision-copy"

import type { ToolDefinition } from "@novaclaw/llm"
import { ReadTool } from "../../tool/read"

/**
 * Strip vision-only copy from the tool list a TEXT-ONLY model is about to receive.
 *
 * 🔴 **Owner, 2026-08-20: *"please ensure the text only models are spared of vision model related
 * stuff."*** Two surfaces talk about images, and only one was gated. `perceptionSection` returns
 * `undefined` unless the catalog declares an `image` input modality, so a text-only model never sees
 * it. The `read` TOOL DESCRIPTION was ungated, so every model on every turn was told *"An image
 * (png/jpeg/gif/webp) arrives as a picture you can see"*.
 *
 * ⚠️ **The wasted tokens are the smaller half — it is a FALSE PROMISE.** A text-only model believes
 * the description, calls `read` on a PNG, and `to-llm-message`'s capability gate then replaces the
 * bytes with "this model cannot read images". That is the product describing its own behaviour
 * falsely (ruling 2), one function away from the gate that exists to prevent exactly it.
 *
 * ⚠️ **The tri-state is preserved, and it decides the DEFAULT.** `undefined`/empty capabilities mean
 * *nobody told us* — not *no vision* — so the vision wording stays. Stripping on unknown would make
 * every unmeasured local endpoint lose the clause that was measured to be the difference between
 * Holo-3.1 opening an image and refusing to (2026-08-19). We only remove the promise from a model
 * that has POSITIVELY declared a modality list without `image` in it.
 *
 * ⚠️ Same predicate as `perceptionSection`, deliberately: two surfaces disagreeing about whether a
 * model can see is how this defect existed in the first place.
 */
export const forCapabilities = (
  definitions: ReadonlyArray<ToolDefinition>,
  declared: ReadonlyArray<string> | undefined,
): ReadonlyArray<ToolDefinition> => {
  // Unknown → unchanged. See the tri-state note above.
  if (declared === undefined || declared.length === 0) return definitions
  if (declared.some((entry) => entry.toLowerCase().trim().startsWith("image"))) return definitions
  if (!definitions.some((tool) => tool.name === ReadTool.name && tool.description === ReadTool.DESCRIPTION))
    return definitions
  return definitions.map((tool) =>
    // Identity-preserving for every other tool: a new object only where the copy actually changes,
    // so a text-only turn stays byte-identical to before this existed apart from the one string.
    tool.name === ReadTool.name && tool.description === ReadTool.DESCRIPTION
      ? ({ ...tool, description: ReadTool.DESCRIPTION_TEXT_ONLY } as ToolDefinition)
      : tool,
  )
}
