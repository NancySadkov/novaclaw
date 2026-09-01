import { type ComponentProps, splitProps, Show } from "solid-js"

import { firstGrapheme } from "../../util/grapheme"

export interface AvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  background?: string
  foreground?: string
  size?: "small" | "normal" | "large"
  kind?: "user" | "org"
}

export function Avatar(props: AvatarProps) {
  const [split, rest] = splitProps(props, [
    "fallback",
    "src",
    "background",
    "foreground",
    "size",
    "kind",
    "class",
    "classList",
    "style",
  ])
  const src = split.src
  return (
    <div
      {...rest}
      data-component="avatar-v2"
      data-size={split.size || "large"}
      data-kind={split.kind || "user"}
      data-has-image={src ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={{
        ...(typeof split.style === "object" ? split.style : {}),
        ...(!src && split.background ? { "--avatar-bg": split.background } : {}),
        ...(!src && split.foreground ? { "--avatar-fg": split.foreground } : {}),
      }}
    >
      <Show when={src} fallback={firstGrapheme(split.fallback)}>
        {(src) => <img src={src()} draggable={false} data-slot="avatar-image" />}
      </Show>
    </div>
  )
}
