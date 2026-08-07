import { Show, type Component } from "solid-js"
import { useLanguage, type TranslationKey } from "@/context/language"
import { useExpertise } from "@/context/expertise"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"

/**
 * Vendor guesses, in priority order — the first match wins, as it always has.
 *
 * ⚠️ **This is a guess over free text and it stays one.** There is no declared vendor field to read:
 * `ModelV2.family` is optional, populated only from models.dev, and names the model FAMILY rather
 * than its maker — so it is absent on exactly the hand-added local models this runs on. The guess is
 * kept because where it fires it is more informative than the fallback (a Claude served through
 * OpenRouter reads "Anthropic", not "OpenRouter"), and because for API-served models the two agree.
 *
 * 🔴 **Ruling 2 is why the matching below is fussy rather than clever.** A wrong vendor is a false
 * description of provenance, rendered indistinguishably from a declared one. `/o[1-4]/` matched the
 * **"o3" inside "holo3.1"**, so until 2026-08-07 the picker labelled H Company's Qwen3.6 build
 * "OpenAI" — on our own canonical test model, permanently, every time anyone hovered it.
 *
 * Two tiers, chosen by how collidable the needle is. **Neither tier is "just add `\b`"**: a blanket
 * word boundary would break `chatgpt-4o-latest`, where "gpt" is genuinely mid-word.
 *  · `brands` — distinctive enough that a substring cannot plausibly land inside an unrelated word,
 *    and substring matching is REQUIRED for the `chatgpt` case above.
 *  · `tokens` — short or an ordinary English word, so it must be a WHOLE token: `o1`–`o4` (the bug
 *    above), `meta` (else "metamath"), `palm` (else Writer's "palmyra"), `bard`, `xai`.
 *
 * Adding a needle? Ask which tier it belongs in first. The test file pins both the true positives and
 * the collisions, so a needle in the wrong tier fails by name rather than shipping onto a tooltip.
 */
const VENDORS = [
  { label: "model.provider.anthropic", brands: ["claude", "anthropic"], tokens: [] },
  { label: "model.provider.openai", brands: ["gpt", "codex", "openai"], tokens: ["o1", "o2", "o3", "o4"] },
  { label: "model.provider.google", brands: ["gemini", "google"], tokens: ["palm", "bard"] },
  { label: "model.provider.xai", brands: ["grok"], tokens: ["xai"] },
  { label: "model.provider.meta", brands: ["llama"], tokens: ["meta"] },
] as const satisfies ReadonlyArray<{
  label: TranslationKey
  brands: ReadonlyArray<string>
  tokens: ReadonlyArray<string>
}>

/**
 * The vendor label key a model's id and name imply, or `undefined` when they imply nothing and the
 * caller should fall back to the DECLARED provider. Pure, so the decision is testable without
 * rendering or an i18n context — which is the half that was wrong and the half worth pinning.
 */
export const vendorLabelKey = (id: string, name: string): TranslationKey | undefined => {
  const value = `${id} ${name}`.toLowerCase()
  // Split on everything that is not alphanumeric, so "holo3.1" yields "holo3" — and NOT "o3".
  const tokens = new Set(value.split(/[^a-z0-9]+/).filter(Boolean))
  for (const vendor of VENDORS) {
    if (vendor.brands.some((brand) => value.includes(brand))) return vendor.label
    if (vendor.tokens.some((token) => tokens.has(token))) return vendor.label
  }
  return undefined
}

type ModelInfo = {
  id: string
  name: string
  provider: {
    name: string
  }
  capabilities: {
    input: ReadonlyArray<string>
  }
  variants: ReadonlyArray<{ id: string }>
  limit: {
    context: number
  }
}

export const ModelTooltip: Component<{
  model: ModelInfo
  latest?: boolean
  free?: boolean
  /**
   * True when `model.limit.context` is the window a live probe saw the server HONOR, rather than
   * the value the catalog declares. The picker renders the number either way; ruling 2 (a fault is
   * never described falsely) is why the wording has to say which one it is — a declared 256k on an
   * endpoint that honors 32k would otherwise read as measured truth.
   */
  measured?: boolean
}> = (props) => {
  const language = useLanguage()
  const { atLeast } = useExpertise()
  const sourceName = (model: ModelInfo) => {
    const label = vendorLabelKey(model.id, model.name)
    return label ? language.t(label) : model.provider.name
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const title = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${props.model.name}${suffix}`
  }
  const inputs = () => {
    const input = props.model.capabilities.input
    const order: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]
    const entries = order.filter((key) => input.some((m) => m.startsWith(key))).map((key) => inputLabel(key))
    return entries.length ? entries.join(", ") : undefined
  }
  const reasoning = () =>
    props.model.variants.length > 0
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  const context = () =>
    language.t(props.measured ? "model.tooltip.context.measured" : "model.tooltip.context", {
      limit: props.model.limit.context.toLocaleString(),
    })

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      {/* Raw model id is a secondary line only at Advanced+ (uix.md §6.4); Normal sees the friendly name. */}
      <Show when={atLeast("advanced")}>
        <div class="text-12-regular text-text-invert-base opacity-70 font-mono">{props.model.id}</div>
      </Show>
      <Show when={inputs()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.allows", { inputs: value() })}
          </div>
        )}
      </Show>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <div class="text-12-regular text-text-invert-base">{context()}</div>
    </div>
  )
}
