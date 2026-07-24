import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import spriteRaw from "./provider-icons/sprite.svg?raw"
import { iconNames, type IconName } from "./provider-icons/types"

// Inject the icon sprite ONCE into the document so each icon renders via a SAME-DOCUMENT
// `<use href="#id">`. The sprite is tiny (<4 KB), so importing it as a URL had Vite inline it as a
// `data:` URL — and SVG `<use href="data:…#id">` is treated as cross-origin, which Chromium BLOCKS,
// logging "Unsafe attempt to load URL … Domains, protocols and ports must match" on EVERY icon
// render (spamming the dev log on each chat-tab switch) while never drawing the glyph. A
// same-document symbol reference has no origin, no fetch and no CSP surface, and behaves identically
// in dev and packaged builds.
let injected = false
const ensureSprite = () => {
  if (injected || typeof document === "undefined") return
  injected = true
  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.style.display = "none"
  // Strip the XML prolog — it is invalid inside an HTML innerHTML context.
  host.innerHTML = spriteRaw.replace(/^\s*<\?xml[^>]*\?>\s*/, "")
  document.body.prepend(host)
}

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  ensureSprite()
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => (iconNames.includes(local.id as IconName) ? local.id : "synthetic"))
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`#${resolved()}`} />
    </svg>
  )
}
