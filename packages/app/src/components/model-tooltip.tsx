import { Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"

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

export const ModelTooltip: Component<{ model: ModelInfo; latest?: boolean; free?: boolean }> = (props) => {
  const language = useLanguage()
  const { atLeast } = useExpertise()
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
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
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })

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
