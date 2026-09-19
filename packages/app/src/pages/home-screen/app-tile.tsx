import { Component, Index, Show, type ComponentProps } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import type { HomeApp } from "@/apps/registry"

type TileProps = { app: HomeApp; shouldSuppressOpen?: () => boolean; onDelete?: (app: HomeApp) => void }

// Artwork stays local. The launcher owns framing, lighting, and focus for glyphs and contributed apps.
export const AppTile: Component<TileProps> = (props) => (
  <button
    type="button"
    class="home-app"
    data-hero={props.app.hero ? "true" : undefined}
    data-source={props.app.source}
    style={{ "--app-accent": props.app.accent }}
    onClick={() => {
      if (!props.shouldSuppressOpen?.()) props.app.open()
    }}
    onContextMenu={(event) => {
      if (!props.onDelete) return
      event.preventDefault()
      props.onDelete(props.app)
    }}
    aria-label={props.app.title}
    title={props.app.subtitle}
  >
    <Show
      when={props.app.hero}
      fallback={
        <>
          <span class="home-app-icon" data-framed={!!props.app.tileNeedsFrame || !props.app.tile}>
            <Show
              when={props.app.tile}
              fallback={<Icon name={props.app.icon as ComponentProps<typeof Icon>["name"]} class="size-8" />}
            >
              {(src) => <img src={src()} alt="" draggable={false} />}
            </Show>
          </span>
          <span class="home-app-label">{props.app.title}</span>
        </>
      }
    >
      <span class="home-nova-art">
        <img src="/assets/skin/logo-nobg.png" alt="" draggable={false} />
      </span>
      <span class="home-nova-stats">
        <Index each={props.app.stats?.() ?? []}>
          {(stat) => (
            <span data-tone={stat().tone}>
              <strong>{stat().value}</strong>
              <small>{stat().label}</small>
            </span>
          )}
        </Index>
      </span>
    </Show>
    <Show when={(props.app.badge?.() ?? 0) > 0}>
      <span data-slot="app-tile-badge">{(props.app.badge?.() ?? 0) > 9 ? "9+" : props.app.badge?.()}</span>
    </Show>
  </button>
)
