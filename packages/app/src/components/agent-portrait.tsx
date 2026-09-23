import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { agentInitials, fetchAgentPortrait, isAgentPortraitURL } from "@/apps/agent-portrait"
import { type ServerConnection, useServer } from "@/context/server"

export function AgentPortrait(props: {
  id: string
  name: string
  avatar?: string | undefined
  connection?: ServerConnection.Any | undefined
  background?: string | undefined
  class?: string | undefined
}) {
  const server = useServer()
  const [failed, setFailed] = createSignal<string>()
  const [loaded, setLoaded] = createSignal<{ route: string; source: string }>()

  createEffect(() => {
    const route = props.avatar
    const current = props.connection ?? server.current
    setLoaded(undefined)
    if (!isAgentPortraitURL(route) || current === undefined) return

    let disposed = false
    let source: string | undefined
    void fetchAgentPortrait(current.http, route).then(
      (blob) => {
        if (disposed) return
        source = URL.createObjectURL(blob)
        setFailed(undefined)
        setLoaded({ route, source })
      },
      () => {
        if (!disposed) setFailed(route)
      },
    )
    onCleanup(() => {
      disposed = true
      if (source !== undefined) URL.revokeObjectURL(source)
    })
  })

  const visible = () => {
    const value = props.avatar
    if (!isAgentPortraitURL(value)) return undefined
    const image = loaded()
    return failed() !== value && image?.route === value ? image.source : undefined
  }
  const fallback = () => {
    if (isAgentPortraitURL(props.avatar)) return agentInitials(props.name)
    return props.avatar || agentInitials(props.name)
  }

  return (
    <span
      class={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-v2-background-bg-layer-02 ${props.class ?? ""}`}
      style={props.background ? { "background-color": props.background } : undefined}
      aria-hidden="true"
    >
      <Show when={visible()} fallback={fallback()} keyed>
        {(src) => (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            class="size-full object-cover"
            onError={() => {
              const image = loaded()
              if (image?.source === src) setFailed(image.route)
            }}
          />
        )}
      </Show>
    </span>
  )
}
