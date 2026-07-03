import { Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import "./brand.css"

/**
 * The NovaClaw wordmark — a stylized gold-gradient rendering of the product name,
 * optionally suffixed with the app version. Used in the titlebar badge (so every
 * screenshot advertises the app and shows its version) and on the new-chat canvas
 * (replacing the logo mark inherited from upstream).
 *
 * Size is driven by `font-size` on the element, so callers set a text-size class.
 */
export function NovaClawWordmark(props: { class?: string; showVersion?: boolean; version?: string }) {
  const platform = usePlatform()
  const version = () => props.version ?? platform.version
  return (
    <span data-component="novaclaw-wordmark" classList={{ [props.class ?? ""]: !!props.class }}>
      <span data-slot="novaclaw-wordmark-name">NovaClaw</span>
      <Show when={props.showVersion && version()}>
        <span data-slot="novaclaw-wordmark-version">v{version()}</span>
      </Show>
    </span>
  )
}
