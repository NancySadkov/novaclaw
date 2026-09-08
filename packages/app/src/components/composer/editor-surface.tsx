import type { JSX } from "solid-js"

export type ComposerEditorSurfaceState = {
  mode: "normal" | "shell"
  ariaLabel: string
  placeholder: string
  /** data-component for the placeholder layer (v2 names it; legacy omits the attribute). */
  placeholderComponent?: string
  dirty: boolean
  /** Presentation is injected per shell; structure and behavior live here. */
  scrollClass: string
  scrollStyle?: JSX.CSSProperties
  editorClass: string
  editorStyle?: JSX.CSSProperties
  placeholderClass: string
  placeholderStyle?: JSX.CSSProperties
  setScrollRef: (el: HTMLDivElement) => void
  setEditorRef: (el: HTMLDivElement) => void
  onInput: JSX.EventHandlerUnion<HTMLDivElement, InputEvent>
  onPaste: JSX.EventHandlerUnion<HTMLDivElement, ClipboardEvent>
  onCompositionStart: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onCompositionEnd: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onBlur: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  onKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
}

/**
 * The contenteditable editor + its placeholder overlay — the composer's typing surface,
 * shared by the v2 and legacy shells (ui-arch P4). Only classes/styles differ per shell;
 * the editable-div semantics (a11y attrs, IME handlers, shell-mode autocorrect-off,
 * pill syntax colors) are pinned here once.
 */
export function ComposerEditorSurface(props: { state: ComposerEditorSurfaceState }) {
  return (
    <div class={props.state.scrollClass} ref={props.state.setScrollRef} style={props.state.scrollStyle}>
      <div
        data-component="prompt-input"
        ref={props.state.setEditorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={props.state.ariaLabel}
        contenteditable="true"
        autocapitalize={props.state.mode === "normal" ? "sentences" : "off"}
        autocorrect={props.state.mode === "normal" ? "on" : "off"}
        spellcheck={props.state.mode === "normal"}
        inputMode="text"
        // @ts-expect-error
        autocomplete="off"
        onInput={props.state.onInput}
        onPaste={props.state.onPaste}
        onCompositionStart={props.state.onCompositionStart}
        onCompositionEnd={props.state.onCompositionEnd}
        onBlur={props.state.onBlur}
        onKeyDown={props.state.onKeyDown}
        classList={{
          "select-text": true,
          [props.state.editorClass]: true,
          "[&_[data-type=file]]:text-syntax-property": true,
          "[&_[data-type=agent]]:text-syntax-type": true,
          "font-mono!": props.state.mode === "shell",
        }}
        style={props.state.editorStyle}
      />
      <div
        data-component={props.state.placeholderComponent}
        class={props.state.placeholderClass}
        classList={{ "font-mono!": props.state.mode === "shell", hidden: props.state.dirty }}
        style={props.state.placeholderStyle}
      >
        {props.state.placeholder}
      </div>
    </div>
  )
}
