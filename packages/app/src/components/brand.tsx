import { Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import "./brand.css"

/**
 * The NovaClaw brand mark — the product logo image, optionally suffixed with the app
 * version. Used in the titlebar badge (so every screenshot advertises the app and shows
 * its version). The logo scales with `font-size` (its height is set in `em`), so callers
 * set a text-size class exactly as they did for the old text wordmark.
 */
export function NovaClawWordmark(props: { class?: string; showVersion?: boolean; version?: string }) {
  const platform = usePlatform()
  const version = () => props.version ?? platform.version
  return (
    <span data-component="novaclaw-wordmark" classList={{ [props.class ?? ""]: !!props.class }}>
      <img data-slot="novaclaw-wordmark-logo" src="/logo.png" alt="NovaClaw" draggable={false} />
      <Show when={props.showVersion && version()}>
        <span data-slot="novaclaw-wordmark-version">v{version()}</span>
      </Show>
    </span>
  )
}
