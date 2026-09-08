import type { Component } from "solid-js"
import { useLanguage } from "@/context/language"

export type ControlScopeKind = "instance" | "device" | "chat" | "draft" | "colleague" | "window"

/** A compact, shared answer to “where will this choice still apply?” */
export const ControlScope: Component<{ kind: ControlScopeKind; class?: string }> = (props) => {
  const language = useLanguage()
  return (
    <span
      data-component="control-scope"
      data-scope={props.kind}
      class={`inline-flex w-fit items-center rounded-full bg-v2-background-bg-layer-03 px-2 py-0.5 text-[11px] leading-4 text-v2-text-text-faint ${props.class ?? ""}`}
    >
      {language.t(`control.scope.${props.kind}`)}
    </span>
  )
}
