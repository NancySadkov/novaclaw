import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
// v2's Icon, not v1's. The first draft of this file imported `@novaclaw/ui/icon` and ruling 13's
// shrink-only fork ledger caught it at 88 -> 89 — the same ratchet, on the same widget family, that
// caught T3 a day earlier. New code does not get to add a v1 call site: the answer is v2's own set
// (`settings-gear` here; v2 has no `sliders`), never raising the pin.
import { Icon } from "@novaclaw/ui/v2/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { Show, type Component } from "solid-js"
import { DialogExpertise } from "@/components/settings-v2/dialog-expertise"
import { GoldGlyph } from "@/components/gold-glyph"
import { useLanguage } from "@/context/language"

// The deep-link half of the expertise gate (uix.md §6, terminal.md T4).
//
// `RequiresLevel` HIDES a surface below its level, and for a section inside a page that is exactly
// right — progressive disclosure, nothing to explain, nothing to refuse. A ROUTE is the other case:
// the user typed the address or followed a link somebody shared, so they have already asked the
// question out loud. Answering by bouncing them to the home screen (the previous `fallback={<Navigate
// href="/" />}`) tells them nothing — no statement that anything was gated, no way to reach it, and
// the one moment the product could have taught what expertise levels ARE, it says nothing at all.
// That is "teach, don't gatekeep" inverted, on the surface where a normal person is most likely to
// meet it.
//
// So a gated route explains itself and offers the unlock. Two rules this must keep:
//   · It reuses the SHIPPED unlock UX (`DialogExpertise`) rather than growing a second one — one
//     concept, not two (todo.md, the mode-gating decision).
//   · It never shows the gated thing. The gate is UIX, and the level is user-owned, one click and
//     reversible; the explainer's job is to make that click informed, not to argue for it.
export const ExpertiseGate: Component<{
  /** Plain-language name of what was asked for, e.g. "Terminal". */
  title: string
  /** What it does and why it sits behind a level — written for someone who has never used one. */
  description: string
  /** UI-kit gold glyph for the gated app (assets/skin/glyphs/<name>.png); falls back to a gear. */
  glyph?: string
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()

  return (
    <div class="flex h-full w-full flex-1 flex-col items-center justify-center gap-4 self-stretch px-8 text-center">
      <Show when={props.glyph} fallback={<Icon name="settings-gear" size="large" class="text-text-weak" />}>
        {(name) => <GoldGlyph name={name()} class="size-12 opacity-80" />}
      </Show>
      <h1 class="text-lg text-text-base">{props.title}</h1>
      <p class="max-w-prose text-sm text-text-weak">{props.description}</p>
      <p class="max-w-prose text-sm text-text-weak">{language.t("expertise.gate.hint")}</p>
      <div class="flex items-center gap-2">
        <ButtonV2 size="small" onClick={() => dialog.push(() => <DialogExpertise />)}>
          {language.t("expertise.gate.change")}
        </ButtonV2>
        <ButtonV2 size="small" variant="ghost-muted" onClick={() => navigate("/")}>
          {language.t("expertise.gate.home")}
        </ButtonV2>
      </div>
    </div>
  )
}
