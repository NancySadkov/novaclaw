export function PromptConnectionNotice(props: { readonly attempt: number; readonly text: string }) {
  return (
    <div
      data-slot="prompt-reconnecting"
      role="status"
      aria-live="polite"
      data-attempt={props.attempt}
      class="flex min-h-[96px] w-full items-center justify-center rounded-xl border border-v2-state-border-warning bg-v2-state-bg-warning px-4 text-center text-[13px] font-[500] text-v2-text-text-base shadow-[var(--v2-elevation-raised)]"
    >
      {props.text}
    </div>
  )
}
