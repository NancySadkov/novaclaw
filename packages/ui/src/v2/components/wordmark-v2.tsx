import { type ComponentProps } from "solid-js"

// NovaClaw wordmark (text, app font). Replaces the inherited opencode pixel-art wordmark. Rendered as
// SVG <text> filling `currentColor` so it scales to its container like the old mark; `textLength` fits
// it to the box regardless of the system font, `dominant-baseline="central"` + the tall viewBox center
// it with headroom so the letters are never clipped. A uniform soft opacity replaces the old
// gradient-mask fade (which only reads on blocky glyphs). (Upstream is named only in the MIT NOTICE/licenses.)
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 180"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="360"
        y="90"
        text-anchor="middle"
        dominant-baseline="central"
        textLength="540"
        lengthAdjust="spacing"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="104"
        font-weight="800"
        fill="currentColor"
        opacity="0.7"
      >NovaClaw</text>
    </svg>
  )
}
