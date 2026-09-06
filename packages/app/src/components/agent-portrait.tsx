import { createSignal, Show } from "solid-js"
import { isAgentPortraitURL } from "@/apps/agent-portrait"
import { useServer } from "@/context/server"
import { instanceUrl } from "@/utils/instance-fetch"

export function AgentPortrait(props: {
  id: string
  name: string
  avatar?: string | undefined
  background?: string | undefined
  class?: string | undefined
}) {
  const server = useServer()
  const [failed, setFailed] = createSignal<string>()
  const visible = () => {
    const value = props.avatar
    if (!isAgentPortraitURL(value)) return undefined
    const current = server.current
    const url = current === undefined ? value : instanceUrl(current.http, value).toString()
    return failed() !== url ? url : undefined
  }
  const fallback = () => {
    if (isAgentPortraitURL(props.avatar)) return props.name.charAt(0) || "?"
    return props.avatar || props.name.charAt(0) || "?"
  }

  return (
    <span
      class={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-v2-background-bg-layer-02 ${props.class ?? ""}`}
      style={props.background ? { "background-color": props.background } : undefined}
      aria-hidden="true"
    >
      <Show when={visible()} fallback={fallback()}>
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
