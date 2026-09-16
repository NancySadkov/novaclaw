import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import {
  TuningPanel,
  type ComposerFeature,
  type ComposerFeaturesControlState,
} from "@/components/composer/features-control"
import { LanguageContext } from "@/context/language"
import { dict as en } from "@/i18n/en"

const LANGUAGE = {
  t: (key: string, params?: Record<string, string | number | boolean>) => {
    const value = (en as Record<string, string>)[key] ?? key
    return params === undefined
      ? value
      : Object.entries(params).reduce((text, [name, sub]) => text.replaceAll("{{" + name + "}}", String(sub)), value)
  },
  locale: () => "en",
}

const FEATURES: readonly ComposerFeature[] = [
  "introspection",
  "quality",
  "affective",
  "thinkingBudget",
  "surgicalEdits",
  "askBeforeChanges",
  "safeMode",
  "contextBudget",
  "memory",
  "shortChat",
]

const current = Object.fromEntries(FEATURES.map((feature) => [feature, false])) as Record<ComposerFeature, boolean>

const state = (over: Partial<ComposerFeaturesControlState> = {}): ComposerFeaturesControlState => ({
  current,
  override: {},
  origin: {},
  mode: "interactive",
  agent: undefined,
  remote: {
    availability: "ready",
    bindable: false,
    accounts: [],
    binding: undefined,
    loadChats: async () => ({ ok: true, chats: [] }),
    connect: async () => "ok",
    disconnect: async () => undefined,
    openSettings: () => undefined,
  },
  style: undefined,
  set: () => undefined,
  inherit: () => undefined,
  setMode: () => undefined,
  onClose: () => undefined,
  ...over,
})

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const mount = (value: ComposerFeaturesControlState) => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <LanguageContext.Provider value={LANGUAGE as never}>
        <TuningPanel state={value} onDismiss={() => undefined} embedded />
      </LanguageContext.Provider>
    ),
    host,
  )
}

describe("TuningPanel feature provenance", () => {
  test("instance defaults do not repeat an On or Off source label", () => {
    mount(state())

    expect(document.querySelectorAll("[data-feature-source]").length).toBe(0)
    expect(document.body.textContent).not.toContain("Using Settings default: Off")
  })

  // 🗑️ A case stood here: a folder-supplied switch rendered its file, so a user reading
  // "Using Settings default" one line under a sentence naming the file that set it could see the
  // contradiction and fix it. With no folder layer there is no such label to render (owner,
  // 2026-09-16), and the case above is the one that survives: an instance default stays silent.
})
