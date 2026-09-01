import * as i18n from "@solid-primitives/i18n"

import { dict as desktopEn } from "./en"
import { dict as desktopZh } from "./zh"
import { dict as desktopZht } from "./zht"
import { dict as desktopKo } from "./ko"
import { dict as desktopDe } from "./de"
import { dict as desktopEs } from "./es"
import { dict as desktopFr } from "./fr"
import { dict as desktopDa } from "./da"
import { dict as desktopJa } from "./ja"
import { dict as desktopPl } from "./pl"
import { dict as desktopRu } from "./ru"
import { dict as desktopUk } from "./uk"
import { dict as desktopAr } from "./ar"
import { dict as desktopNo } from "./no"
import { dict as desktopBr } from "./br"
import { dict as desktopBs } from "./bs"

import { dict as appEn } from "../../../../app/src/i18n/en"
import { dict as appZh } from "../../../../app/src/i18n/zh"
import { dict as appZht } from "../../../../app/src/i18n/zht"
import { dict as appKo } from "../../../../app/src/i18n/ko"
import { dict as appDe } from "../../../../app/src/i18n/de"
import { dict as appEs } from "../../../../app/src/i18n/es"
import { dict as appFr } from "../../../../app/src/i18n/fr"
import { dict as appDa } from "../../../../app/src/i18n/da"
import { dict as appJa } from "../../../../app/src/i18n/ja"
import { dict as appPl } from "../../../../app/src/i18n/pl"
import { dict as appRu } from "../../../../app/src/i18n/ru"
import { dict as appUk } from "../../../../app/src/i18n/uk"
import { dict as appAr } from "../../../../app/src/i18n/ar"
import { dict as appNo } from "../../../../app/src/i18n/no"
import { dict as appBr } from "../../../../app/src/i18n/br"
import { dict as appBs } from "../../../../app/src/i18n/bs"
import { dict as appTh } from "../../../../app/src/i18n/th"
import { dict as appTr } from "../../../../app/src/i18n/tr"

import { LOCALES, detectLocale, type Locale } from "@novaclaw/schema/locale"

// The LOCALE TABLE and the language matcher are the app's — re-exported, never re-spelled.
// This module used to carry its own 16-entry union, its own LOCALES array and its own 16-branch
// `detectLocale`, all two entries short: `th` and `tr` are offered by the app's language picker and
// were rejected by `parseLocale` here, so those users got an English desktop shell.
export type { Locale }
export { LOCALES }

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

/**
 * The dictionary per locale. A `Record<Locale, …>` on purpose: this was an `if`-chain whose final
 * unlabelled `return` handed the KOREAN dictionary to anything it did not recognise — correct only
 * while the chain happened to be exhaustive. A missing arm is now a compile error.
 *
 * `th` and `tr` have app translations but no desktop-shell ones yet, so they take the app's
 * dictionary over the English desktop strings already in `base`. Partly translated beats a shell
 * that ignores the language the user chose.
 */
const OVERLAYS: Record<Exclude<Locale, "en">, () => Dictionary> = {
  zh: () => ({ ...base, ...i18n.flatten(appZh), ...i18n.flatten(desktopZh) }),
  zht: () => ({ ...base, ...i18n.flatten(appZht), ...i18n.flatten(desktopZht) }),
  ko: () => ({ ...base, ...i18n.flatten(appKo), ...i18n.flatten(desktopKo) }),
  de: () => ({ ...base, ...i18n.flatten(appDe), ...i18n.flatten(desktopDe) }),
  es: () => ({ ...base, ...i18n.flatten(appEs), ...i18n.flatten(desktopEs) }),
  fr: () => ({ ...base, ...i18n.flatten(appFr), ...i18n.flatten(desktopFr) }),
  da: () => ({ ...base, ...i18n.flatten(appDa), ...i18n.flatten(desktopDa) }),
  ja: () => ({ ...base, ...i18n.flatten(appJa), ...i18n.flatten(desktopJa) }),
  pl: () => ({ ...base, ...i18n.flatten(appPl), ...i18n.flatten(desktopPl) }),
  ru: () => ({ ...base, ...i18n.flatten(appRu), ...i18n.flatten(desktopRu) }),
  uk: () => ({ ...base, ...i18n.flatten(appUk), ...i18n.flatten(desktopUk) }),
  ar: () => ({ ...base, ...i18n.flatten(appAr), ...i18n.flatten(desktopAr) }),
  no: () => ({ ...base, ...i18n.flatten(appNo), ...i18n.flatten(desktopNo) }),
  br: () => ({ ...base, ...i18n.flatten(appBr), ...i18n.flatten(desktopBr) }),
  bs: () => ({ ...base, ...i18n.flatten(appBs), ...i18n.flatten(desktopBs) }),
  th: () => ({ ...base, ...i18n.flatten(appTh) }),
  tr: () => ({ ...base, ...i18n.flatten(appTr) }),
}

export function build(locale: Locale): Dictionary {
  return locale === "en" ? base : OVERLAYS[locale]()
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

state.dict = build(state.locale)

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("novaclaw.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
