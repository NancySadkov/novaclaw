import { createMemo, createSignal, Show } from "solid-js"
import { agentPortraitSource } from "@/apps/agent-portrait"

export function AgentPortrait(props: {
  id: string
  name: string
  avatar?: string | undefined
  background?: string | undefined
  class?: string | undefined
}) {
  const [failed, setFailed] = createSignal<string>()
  const source = createMemo(() => agentPortraitSource(props.id))
  const visible = createMemo(() => {
    const value = source()
    return value !== undefined && failed() !== value ? value : undefined
  })

  return (
    <span
      class={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-v2-background-bg-layer-02 ${props.class ?? ""}`}
      style={props.background ? { "background-color": props.background } : undefined}
      aria-hidden="true"
    >
      <Show when={visible()} fallback={props.avatar ?? props.name.charAt(0)}>
        {(src) => (
          <img
            src={src()}
            alt=""
            loading="lazy"
            decoding="async"
            class="size-full object-cover"
            onError={() => setFailed(src())}
          />
        )}
      </Show>
    </span>
  )
}
