import { createMemo, createSignal, Show } from "solid-js"
import { agentPortraitPlaceholder } from "@/apps/agent-portrait"

export function AgentPortrait(props: {
  id: string
  name: string
  avatar?: string | undefined
  background?: string | undefined
  class?: string | undefined
}) {
  const [failed, setFailed] = createSignal<string>()
  const source = createMemo(() => agentPortraitPlaceholder(props.id, props.avatar))
  /**
   * The colleague's OWN `avatar` wins; the shipped portrait is the placeholder for one that has none.
   *
   * ⚠️ It was the other way round until 2026-09-03: the pool portrait was looked up first and
   * `avatar` rendered only in its fallback — and since every officer Nova hires is named from that
   * pool, the entity-owned avatar was unreachable for the whole roster. A colleague whose config
   * said 🦊 wore the shipped face on every surface, and the instance never learned the client was
   * overriding it. The seed no longer writes glyphs for the officers whose portraits ship, so a
   * fresh instance still shows the faces; an existing row that kept its seeded glyph shows the
   * glyph, which is what its config says.
   */
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
