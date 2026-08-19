import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import type { JSX } from "solid-js"

/**
 * The long explanation for a settings row, ON DEMAND rather than in the panel.
 *
 * 🔴 **Why this exists** (owner, 2026-08-20, holding the Health tab's own copy up as the example:
 * *"extremely verbose… make everything concise, and turn the descriptions into the on-tap modals or
 * mouse hover on popups"*). Measured the same day: 93,601 characters of UI copy across 2,170 keys,
 * of which **settings alone is 44,033 — 47%** across 903 keys, with 63 strings over 200 characters.
 *
 * ⚠️ **The cause was a RULE, not carelessness, which is why the fix has to be a mechanism.**
 * AGENTS.md principle 12(d) says *"say what is in force right now, before any control"*, and
 * principle 8 says the product teaches. Neither names a length budget or a delivery mechanism, and
 * `uix.md` §1.4 — the one place that does — says tooltips carry **one-line** descriptions. With no
 * component to reach for, every agent implementing 12(d) reached for the cheapest thing that
 * satisfies it: another paragraph in the DOM, at full length, for every user on every visit.
 *
 * So the row keeps a SHORT line that says what is in force, and the paragraph explaining WHY moves
 * behind this affordance. Both halves of 12(d) survive — the state is still stated before the
 * control — while the teaching stops competing with the control for the same space.
 *
 * ⚠️ Hover is not the only door: Kobalte opens this on focus and on touch, so it is reachable by
 * keyboard and on a phone. An explanation only a mouse can reach would fail the same anti-elitism
 * argument that motivated shortening it.
 */
export function SettingsExplainV2(props: { readonly label: string; readonly children: JSX.Element }) {
  return (
    <TooltipV2
      placement="top"
      gutter={6}
      // Bounded: this is a paragraph, not a page. A tooltip wider than a column of text stops being
      // readable, and a wall of prose in a popup is the same defect relocated rather than fixed.
      contentClass="max-w-[42ch] text-[12px] leading-relaxed"
      value={props.children}
    >
      <button
        type="button"
        data-slot="settings-explain"
        aria-label={props.label}
        class="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-v2-border-border-base text-[10px] leading-none text-v2-text-text-faint align-middle hover:border-v2-border-border-strong hover:text-v2-text-text-muted focus-visible:outline focus-visible:outline-1"
      >
        ?
      </button>
    </TooltipV2>
  )
}
