import { InfoPopoverV2 } from "@novaclaw/ui/v2/info-popover-v2"
import type { JSX } from "solid-js"

/**
 * The on-demand explanation for a settings row, behind a `?` circle.
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
 * So the row keeps a SHORT title, and the explanation moves behind this affordance. The row places
 * it right of the title (`SettingsRowV2`'s `info` prop) so it sits against the field it is about
 * rather than on a line of its own.
 *
 * ⚠️ **Hover and tap both work**, which the `TooltipV2` this replaced did not — see
 * `InfoPopoverV2` for the measurement and why the primitive had to change. Principle 12's gate is a
 * normal user configuring a capability without knowing anything not on screen, and on a phone that
 * was false for every explanation in the product.
 */
export function SettingsExplainV2(props: { readonly label: string; readonly children: JSX.Element }) {
  return <InfoPopoverV2 label={props.label}>{props.children}</InfoPopoverV2>
}
