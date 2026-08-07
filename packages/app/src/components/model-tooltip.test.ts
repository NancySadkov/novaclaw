import { describe, expect, test } from "bun:test"
import { vendorLabelKey } from "./model-tooltip"

// The tooltip guesses a vendor from a model's free-text id and name. A wrong guess is a false
// description of provenance (ruling 2) rendered indistinguishably from a declared one — and it renders
// on hover, not on an error path, so nothing surfaces it but a person reading the tooltip.
//
// It shipped wrong: `/o[1-4]/` matched the "o3" INSIDE "holo3.1", so the picker labelled our canonical
// test model — H Company's build on Qwen3.6-35B-A3B, served from a local Spark — "OpenAI". Verified in
// the running app on 2026-08-07 before the fix:
//
//   OpenAI Holo-3.1-35B-A3B-NVFP4 | Allows: text, image | No reasoning | Context limit 131,072, …
//
// These claims are behavioural rather than source assertions, because the defect is in what the
// matcher ANSWERS, not in whether a particular regex is present. Any rewrite that keeps the answers is
// free to land.

const OPENAI = "model.provider.openai"

describe("vendorLabelKey — the reported defect", () => {
  test("holo3.1 is not OpenAI, by id, by name, and as the picker actually calls it", () => {
    // The id alone, the display name alone, and the real pair. The pair is what the picker passes; the
    // singles are here so a future change cannot fix one input and leave the other matching.
    expect(vendorLabelKey("holo3.1", "holo3.1")).not.toBe(OPENAI)
    expect(vendorLabelKey("Holo-3.1-35B-A3B-NVFP4", "Holo-3.1-35B-A3B-NVFP4")).not.toBe(OPENAI)
    expect(vendorLabelKey("holo3.1", "Holo-3.1-35B-A3B-NVFP4")).not.toBe(OPENAI)
  })

  test("and it claims no vendor at all, so the tooltip falls back to the declared provider", () => {
    // Stronger than "not OpenAI": Holo is not in any of our vendor lists, so the honest answer is
    // `undefined` — the caller then renders `model.provider.name`, which is a value someone declared.
    expect(vendorLabelKey("holo3.1", "Holo-3.1-35B-A3B-NVFP4")).toBeUndefined()
  })
})

describe("vendorLabelKey — the true positives the guess exists for", () => {
  test("o1 through o4 still resolve when they are the model, not a substring of one", () => {
    for (const id of ["o1", "o1-preview", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
      expect(vendorLabelKey(id, id)).toBe(OPENAI)
    }
  })

  test("gpt matches MID-WORD on purpose — chatgpt-4o-latest is a real OpenAI model id", () => {
    // This is why the fix is not "put \b on everything": a blanket word boundary breaks exactly this.
    expect(vendorLabelKey("chatgpt-4o-latest", "ChatGPT-4o")).toBe(OPENAI)
    expect(vendorLabelKey("gpt-4o", "GPT-4o")).toBe(OPENAI)
    expect(vendorLabelKey("gpt-oss-120b", "gpt-oss-120B")).toBe(OPENAI)
  })

  test("the other vendors still resolve", () => {
    expect(vendorLabelKey("claude-opus-4-1", "Claude Opus 4.1")).toBe("model.provider.anthropic")
    expect(vendorLabelKey("gemini-2.5-pro", "Gemini 2.5 Pro")).toBe("model.provider.google")
    expect(vendorLabelKey("grok-4", "Grok 4")).toBe("model.provider.xai")
    expect(vendorLabelKey("meta-llama/Llama-3.3-70B", "Llama 3.3 70B")).toBe("model.provider.meta")
    expect(vendorLabelKey("palm-2", "PaLM 2")).toBe("model.provider.google")
  })

  test("a claude served through another provider still reads Anthropic — the reason to keep the guess", () => {
    // If this ever stops holding, the guess has stopped earning its place and should be deleted in
    // favour of `model.provider.name` outright.
    expect(vendorLabelKey("anthropic/claude-sonnet-5", "Claude Sonnet 5")).toBe("model.provider.anthropic")
  })
})

describe("vendorLabelKey — the collision class, not just the one bug", () => {
  test("a short needle inside a longer word claims nothing", () => {
    // Each of these is the SAME defect as holo3.1 wearing a different name. `meta` was named in the
    // report; the rest are its siblings, and every one of them would match a naive substring chain.
    expect(vendorLabelKey("metamath-7b", "MetaMath 7B")).toBeUndefined() // "meta" inside metamath
    expect(vendorLabelKey("palmyra-x5", "Palmyra X5")).toBeUndefined() // "palm" inside palmyra — Writer, not Google
    expect(vendorLabelKey("bardic-7b", "Bardic 7B")).toBeUndefined() // "bard" inside bardic
    expect(vendorLabelKey("solo1-preview", "Solo1 Preview")).toBeUndefined() // "o1" inside solo1
    expect(vendorLabelKey("proto4-mini", "Proto4 Mini")).toBeUndefined() // "o4" inside proto4
  })

  test("our own configured models resolve honestly", () => {
    // Read off the picker on 2026-08-07. None is made by a vendor we can name from its id, so every one
    // must decline rather than guess — a wrong label here is what the user actually sees.
    for (const id of [
      "Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL",
      "Qwen3-Coder-30B-A3B-Instruct",
      "GLM-4.5-Air-GGUF:UD-Q4_K_XL",
      "DeepSeek V4 Flash q2",
      "devstral:latest",
    ]) {
      expect(vendorLabelKey(id, id)).toBeUndefined()
    }
  })

  test("gemma is Google's, and we do NOT claim it — a miss is not a false positive", () => {
    // Recorded deliberately. Gemma IS a Google model and the guess declines it, so the tooltip shows the
    // declared provider instead. That is the safe direction to be wrong in, and adding "gemma" to the
    // brands list would be correct — but it is a behaviour change, not part of this fix.
    expect(vendorLabelKey("gemma-4-31B-it", "gemma-4-31B-it")).toBeUndefined()
  })
})
