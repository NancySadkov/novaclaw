import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { agentInitials, loadAgentPortrait, isAgentPortraitURL, portraitRetryDelayMs } from "@/apps/agent-portrait"
import { type ServerConnection, useServer } from "@/context/server"

export function AgentPortrait(props: {
  id: string
  name: string
  avatar?: string | undefined
  connection?: ServerConnection.Any | undefined
  background?: string | undefined
  class?: string | undefined
  /** Test seam for the recovery cadence. Production uses the shared default below. */
  retryDelayMs?: (attempt: number) => number
}) {
  const server = useServer()
  const [failed, setFailed] = createSignal<string>()
  const [loaded, setLoaded] = createSignal<{ route: string; source: string }>()
  const request = createMemo(
    () => {
      const route = props.avatar
      const connection = props.connection ?? server.current
      if (!isAgentPortraitURL(route) || !connection) return undefined
      const { url, username, password } = connection.http
      return { route, http: { url, username, password } }
    },
    undefined,
    {
      equals: (previous, next) =>
        previous?.route === next?.route &&
        previous?.http.url === next?.http.url &&
        previous?.http.username === next?.http.username &&
        previous?.http.password === next?.http.password,
    },
  )

  createEffect(() => {
    const current = request()
    setLoaded(undefined)
    if (!current) return
    const { route } = current

    // 🔴 A FAILED PORTRAIT IS A TRANSIENT READ, NOT A VERDICT. The roster (and this route with it)
    // is read while the instance may still be answering its first requests; a refused or held fetch
    // used to leave the colleague's initials in place for the life of the window, because the route
    // string does not change when the same avatar later loads. Retry at a bounded rate until it does.
    const delayFor = props.retryDelayMs ?? portraitRetryDelayMs
    let disposed = false
    let source: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const load = () => {
      void loadAgentPortrait(current.http, route).then(
        (blob) => {
          if (disposed) return
          source = URL.createObjectURL(blob)
          setFailed(undefined)
          setLoaded({ route, source })
        },
        () => {
          if (disposed) return
          setFailed(route)
          timer = setTimeout(load, delayFor(attempt))
          attempt++
        },
      )
    }
    load()
    onCleanup(() => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
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
