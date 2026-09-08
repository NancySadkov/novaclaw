import type { Translator } from "@/context/language"

/**
 * The preset TABLE and the pure functions over it. Deliberately free of any component import, so the
 * decisions it encodes can be tested without a DOM and without dragging `solid-js/web` in — which is
 * not a style preference: `bun test` resolves `solid-js/web` to its SERVER build, so a test that
 * reaches a component at all dies on `Export named 'use' not found` before asserting anything.
 *
 * 🔴 **This is where AGENTS.md principle 12(c) is enforced for numeric settings** — *"human units,
 * minutes not `300000`; named intensities, not raw floats"*, plus principle 12's *"a setting may
 * never require a value the user has no way to know"*. A bare `<input type="number">` for a sampling
 * parameter fails both: it asks the reader to already know that 0.7 is the useful temperature. The
 * droplist teaches the typical values BY NAME; the raw box still allows any exact value.
 *
 * ⚠️ **The i18n keys stayed under `settings.models.config.*` and that is now slightly a lie** — they
 * are read by the Affective settings tab too. Left as they are deliberately: renaming them means
 * editing eighteen locale files to fix a namespace, and `en.ts` is the only one that carries most of
 * these strings anyway. What matters is that they are SHARED — editing
 * `settings.models.config.preset.*` or `settings.models.config.defaultPlaceholder` changes both
 * screens, not just the models one.
 *
 * ⚠️ **Lifted out of `dialog-model-config.tsx`, where all of this lived as a closure over that one
 * dialog's form store.** Moved verbatim, including the two measured bug comments below.
 * Do not "simplify" either away — each names a live defect that was fixed here, and
 * `preset-value.test.ts` fails if you do.
 */

/** The translator, taken as a PARAMETER rather than closed over, so `optLabel` stays pure. The import
 *  is type-only and therefore erased — importing the context for real would defeat the point above. */
type Translate = Translator

export const SAMPLING = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repetition_penalty",
  "presence_penalty",
  "frequency_penalty",
] as const
export type FieldKey =
  | (typeof SAMPLING)[number]
  | "context"
  | "maxTokens"
  | "images"
  | "thinkingBudget"
  | "retryAttempts"

// Presets per field. `{}` = "use the default" (blank). `word` is a shared i18n intensity term; `size`
// is a literal unit label (context/output are token counts, not intensities). The number is the value.
// ⚠️ `word` is a union, not `string`: it is interpolated into `settings.models.config.preset.<word>`
// and the app's translator is key-typed, so widening it would silently switch that check off.
type PresetWord =
  | "precise"
  | "focused"
  | "balanced"
  | "creative"
  | "wild"
  | "off"
  | "diverse"
  | "tight"
  | "wide"
  | "light"
  | "strong"
  | "gentle"
  | "moderate"
  | "disabled"
  | "once"
  | "quickRecovery"
  | "patientRecovery"
  | "persistentRecovery"
  | "briefThought"
  | "thoroughThought"
  | "exhaustiveThought"
export type RawPreset = { num?: number; word?: PresetWord; size?: string }
export const PRESETS: Record<FieldKey, RawPreset[]> = {
  temperature: [
    {},
    { word: "precise", num: 0 },
    { word: "focused", num: 0.3 },
    { word: "balanced", num: 0.7 },
    { word: "creative", num: 1 },
    { word: "wild", num: 1.3 },
  ],
  top_p: [
    {},
    { word: "off", num: 1 },
    { word: "focused", num: 0.9 },
    { word: "balanced", num: 0.95 },
    { word: "diverse", num: 0.8 },
  ],
  top_k: [
    {},
    { word: "off", num: 0 },
    { word: "tight", num: 20 },
    { word: "balanced", num: 40 },
    { word: "wide", num: 100 },
  ],
  min_p: [
    {},
    { word: "off", num: 0 },
    { word: "light", num: 0.05 },
    { word: "balanced", num: 0.1 },
    { word: "strong", num: 0.2 },
  ],
  repetition_penalty: [
    {},
    { word: "off", num: 1 },
    { word: "gentle", num: 1.02 },
    { word: "light", num: 1.05 },
    { word: "moderate", num: 1.1 },
    { word: "strong", num: 1.2 },
  ],
  presence_penalty: [
    {},
    { word: "off", num: 0 },
    { word: "light", num: 0.3 },
    { word: "moderate", num: 0.6 },
    { word: "strong", num: 1 },
  ],
  frequency_penalty: [
    {},
    { word: "off", num: 0 },
    { word: "light", num: 0.3 },
    { word: "moderate", num: 0.6 },
    { word: "strong", num: 1 },
  ],
  context: [
    {},
    { size: "4K", num: 4096 },
    { size: "8K", num: 8192 },
    { size: "16K", num: 16384 },
    { size: "32K", num: 32768 },
    { size: "64K", num: 65536 },
    { size: "128K", num: 131072 },
    { size: "256K", num: 262144 },
  ],
  // A count of pictures, so the presets are small and literal. 3 is holo3.1's vLLM cap and the
  // reason this row exists; 1 is what the harness assumes when this is blank.
  images: [
    {},
    { size: "1", num: 1 },
    { size: "2", num: 2 },
    { size: "3", num: 3 },
    { size: "4", num: 4 },
    { size: "8", num: 8 },
    { size: "16", num: 16 },
    { size: "32", num: 32 },
  ],
  maxTokens: [
    {},
    { size: "512", num: 512 },
    { size: "1K", num: 1024 },
    { size: "2K", num: 2048 },
    { size: "4K", num: 4096 },
    { size: "8K", num: 8192 },
    { size: "16K", num: 16384 },
    { size: "32K", num: 32768 },
  ],
  // -1 is the DISABLED value (owner 2026-07-26): one entry in the same list rather than a separate switch,
  // because "no budget" is a budget setting. The runtime already collapses any non-positive configured
  // value to 0 (`defaultThinkingBudget` clamps with Math.max(0, …)) and the runner gates on `> 0`, so the
  // sentinel needs no schema, migration or protocol change. Blank still means "derive the default".
  // ⚠️ NAMED, for the same reason `retryAttempts` below is named — and this list is where that rule
  // was first written down and then not applied. Owner, 2026-09-03: *"ensure the model's Tune has
  // thinking LEVEL selectable, since some models allow picking how long they will think before
  // acting."* `2K` asks the reader to know what two thousand reasoning tokens buys them; "Brief" says
  // it. The raw box beside the droplist still takes any exact number and reflects back as "Custom",
  // so nothing that could be expressed before is lost — principle 12(b), free text is the fallback
  // for what the list missed, not a replacement for it.
  thinkingBudget: [
    {},
    { word: "disabled", num: -1 },
    { word: "briefThought", num: 2048 },
    { word: "balanced", num: 6144 },
    { word: "thoroughThought", num: 16384 },
    { word: "exhaustiveThought", num: 32768 },
  ],
  // ⚠️ NAMED, not bare counts — principle 12(c), and it arrived from the other line of work while
  // this table was being lifted out of `dialog-model-config.tsx`. "3 attempts" asks the reader to
  // know what three buys them; "quickRecovery" says it.
  retryAttempts: [
    { word: "once", num: 1 },
    { word: "quickRecovery", num: 3 },
    { word: "patientRecovery", num: 5 },
    { word: "persistentRecovery", num: 10 },
  ],
}

export type Opt = { id: string; num: number | undefined; label: string }

/** Raw text to a number, or `undefined` for blank/unparseable. Shared so the dialog and the tab
 *  agree on what "cleared" looks like coming OUT of the box. */
export const numFromText = (s: string): number | undefined => {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

export const optLabel = (p: RawPreset, t: Translate): string => {
  if (p.num === undefined) return t("settings.models.config.preset.default")
  // A sentinel is not a quantity: "Disabled (-1)" would invite the reader to reason about -1 tokens.
  if (p.word)
    return p.num < 0
      ? t(`settings.models.config.preset.${p.word}`)
      : `${t(`settings.models.config.preset.${p.word}`)} (${p.num})`
  if (p.size) return p.size
  return String(p.num)
}

// The option id is an internal key, and it must not start with "-": a NEGATIVE value (the -1 "Disabled"
// budget) produced the id "-1", and the listbox then refused to open at all — measured, with the
// temperature select opening from the identical events while this one stayed shut. Prefixing keeps every
// id a safe identifier regardless of sign.
export const optId = (p: RawPreset) => (p.num === undefined ? "default" : `v${p.num}`)

/**
 * What the raw box's text means for a caller that stores into instance CONFIG, where "cleared" is a
 * different verb from "set" (`POST /api/config/remove` vs `PATCH /config`).
 *
 * 🔴 **`"0"` is a SET, not a clear**, and that is the whole point of this seam. The Affective tab used to coerce with
 * `parsed > 0 ? parsed : 0`, which made a deliberate 0 unexpressible and a cleared box
 * indistinguishable from it; the runner then read it back through `|| undefined` to undo the damage.
 * Both cases now have their own answer, and `precise` (temperature 0) became reachable.
 *
 * ⚠️ A caller whose storage is a plain form store (the model dialog) does NOT need this — for it,
 * `""` in the store already means absent and there is no second verb to choose.
 */
export type PresetWrite = { readonly kind: "clear" } | { readonly kind: "set"; readonly value: number }

export const presetWrite = (raw: string): PresetWrite => {
  const parsed = numFromText(raw)
  return parsed === undefined ? { kind: "clear" } : { kind: "set", value: parsed }
}
