import { dict as en } from "@/i18n/en"

// How a home tile gets its words. Before this module the built-in tiles carried hardcoded English
// literals, so the most visible strings in the product were the only ones 19 locales could not
// touch — an English-only launcher wearing a language picker.
//
// The scheme has to serve THREE kinds of app, because the registry is extensible on purpose
// (built-in / plugin / AI-agent-contributed all `registerApp` the same way):
//
//   built-in        we ship `home.app.<id>.{name,subtitle}` in `en` and translate it over time.
//   contributed     we ship NO key. The app's own label is used verbatim.
//   contributed,    if someone later contributes `home.app.<id>.name` for a popular third-party
//   later adopted   app, it starts translating with no change to that app.
//
// The load-bearing property: **a raw key never reaches the user.** `appName`/`appSubtitle` only ask
// the translator for a key this build actually ships (membership in `en`, checked below), so the
// translator is never handed `home.app.foo.name` for an app we have never heard of — and the value
// it returns is re-checked for blankness before it is used. Everything else falls back, and the
// last fallback is derived from the id, which is always legible.

/** The two fields a tile can translate. `home.app.<id>.<field>` is the key. */
export type AppLabelField = "name" | "subtitle"

/**
 * The slice of `useLanguage().t` this module needs. The key union is erased on purpose: a
 * contributed app's id is only known at runtime, so `home.app.<id>.*` can never be a literal type.
 * The two call sites that bridge — `apps/builtins.tsx` and `apps/manifest-apps.ts` — do it with
 * `key as Parameters<typeof language.t>[0]`, and both are pinned in `i18n/key-typing.test.ts`'s
 * shrink-only ledger for exactly that reason.
 *
 * ⚠️ This used to cite `pages/home-screen/help-tour.tsx` as the example of that cast. It no longer
 * casts: its per-step key was narrowed to an eight-member union, so the tour is checked and is the
 * opposite of an example here.
 */
export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

/** The i18n key an app's `field` is translated under. */
export const appLabelKey = (id: string, field: AppLabelField) => `home.app.${id}.${field}`

// Membership in `en` — NOT in the active locale. `en` is the base of every merged dictionary
// (`context/language.tsx` spreads it under each locale), so a key present here always resolves to a
// string, while a key absent here would resolve to `undefined` behind a signature that claims
// `string`. Asking only for keys we ship is what makes the "no raw key" property hold.
const SHIPPED: ReadonlySet<string> = new Set(Object.keys(en))

/** True when THIS build ships a translation slot for that app + field. */
export const hasAppLabel = (id: string, field: AppLabelField): boolean => SHIPPED.has(appLabelKey(id, field))

// A label that is really an i18n key someone expected us to resolve: all-lowercase, no whitespace,
// three or more dot-separated segments. Deliberately narrow — "Node.js" (two segments) and
// "v2.1 tools" (whitespace) are titles, not keys, and must survive untouched. Segments may be empty
// (`*`, not `+`) so a key built from a blank id — "home.app..name" — is still recognised.
const KEY_SHAPED = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]*){2,}$/

/** "memory-graph" -> "Memory graph". The last-resort name: derived, never blank, never a key. */
export function nameFromId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim()
  if (words === "") return "App"
  return words[0]!.toUpperCase() + words.slice(1)
}

/** Anything blank or key-shaped is not a label a person can read — degrade to the id instead. */
export function legibleAppName(id: string, supplied: string | undefined): string {
  const value = (supplied ?? "").trim()
  return value !== "" && !KEY_SHAPED.test(value) ? value : nameFromId(id)
}

function shipped(t: Translate, id: string, field: AppLabelField): string | undefined {
  if (!hasAppLabel(id, field)) return undefined
  const value = t(appLabelKey(id, field))
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * The tile's name in the active language. Falls back to `supplied` (a contributed app's own label),
 * then to the id. Always returns something a person can read.
 */
export function appName(t: Translate, id: string, supplied?: string): string {
  return legibleAppName(id, shipped(t, id, "name") ?? supplied)
}

/**
 * The tile's one-liner in the active language, or `undefined` when there is nothing to say. Unlike
 * the name there is no id-derived fallback — a tile with no subtitle is a normal tile, and inventing
 * one from the id would put "Memory graph" under "Memory graph".
 */
export function appSubtitle(t: Translate, id: string, supplied?: string): string | undefined {
  const value = shipped(t, id, "subtitle") ?? supplied?.trim()
  return value !== undefined && value !== "" ? value : undefined
}

/**
 * The built-in tiles' English text, in ONE place.
 *
 * These are **fallbacks**, not the rendered strings: the rendered string comes from
 * `home.app.<id>.{name,subtitle}` in the active locale, and `en` carries the same text. They exist
 * so a build that lost its i18n keys still shows words rather than ids, and so the id set the
 * launcher offers is checkable as data. `app-label.test.ts` pins all of it: every entry has both
 * keys in `en` with byte-identical text, every `home.app.*` key in `en` belongs to an entry here,
 * and this id set equals the ids `builtins.tsx` actually registers.
 */
export const BUILTIN_APP_LABELS = {
  chats: { name: "Chats", subtitle: "Your conversations, and everything still running" },
  notes: { name: "Notes", subtitle: "Everyday notes, shared with your agents" },
  calendar: { name: "Calendar", subtitle: "Schedule agents to run on a repeating date" },
  recipes: { name: "Recipes", subtitle: "Ready-made prompts your agents can cook" },
  files: { name: "Files", subtitle: "Browse folders and ask AI to work on them" },
  search: { name: "Search", subtitle: "Find anything across chats and files" },
  terminal: { name: "Terminal", subtitle: "A shell, for when you want one" },
  registry: { name: "Registry", subtitle: "The instance database, editable — handle with care" },
  debug: { name: "Debug", subtitle: "Connection, error log, sessions — under the hood" },
  "memory-graph": { name: "Memory graph", subtitle: "Explore what NovaClaw remembers, as a graph" },
  trash: { name: "Trash", subtitle: "Restore anything deleted in the last 2 days" },
  social: { name: "Community", subtitle: "Discord, Reddit and the website — other people who run NovaClaw" },
  help: { name: "Help", subtitle: "A short tour of what NovaClaw can do" },
  settings: { name: "Settings", subtitle: "Providers, models, servers, recovery" },
} as const satisfies Record<string, { readonly name: string; readonly subtitle: string }>

export type BuiltinAppId = keyof typeof BUILTIN_APP_LABELS
