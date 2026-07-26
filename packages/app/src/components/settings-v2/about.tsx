import { type Component, For } from "solid-js"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import "./settings-v2.css"

// The About tab — a small piece of pride and the license attribution the third-party MIT/Apache
// components require. The product name is set in a fancy branded wordmark (gold gradient serif); the
// credits list is factual data (name · version · license), so it lives here rather than in i18n.
// `platform.version` is the same source the settings nav footer uses; it and the fallback are now the
// SAME number (both trace to the root package.json), so the two can no longer disagree.

type Credit = { name: string; version?: string; license: string }

// The foundational open-source stack NovaClaw is built on. Versions come from the workspace catalog /
// package manifests (package.json / bun.lock); update them when the dependencies are bumped. This is a
// curated highlight, not the exhaustive tree — the trailing note points at NOTICE for the full list.
const CREDITS: Credit[] = [
  { name: "Bun", version: "1.3.14", license: "MIT" },
  { name: "Electron", version: "42.3.3", license: "MIT" },
  { name: "SolidJS", version: "1.9.10", license: "MIT" },
  { name: "Effect", version: "4.0.0-beta.83", license: "MIT" },
  { name: "Drizzle ORM", version: "1.0.0-rc.2", license: "Apache-2.0" },
  { name: "Hono", version: "4.10.7", license: "MIT" },
  { name: "TanStack Query", version: "5.91.4", license: "MIT" },
  { name: "Kobalte", version: "0.13.11", license: "MIT" },
  { name: "Tailwind CSS", version: "4.1.11", license: "MIT" },
  { name: "Vite", version: "7.1.4", license: "MIT" },
  { name: "Shiki", version: "4.2.0", license: "MIT" },
  { name: "Marked", version: "17.0.1", license: "MIT" },
  { name: "Luxon", version: "3.6.1", license: "Apache-2.0" },
  { name: "solid-dnd", version: "0.7.5", license: "MIT" },
  { name: "ghostty-web", license: "MIT" },
]

export const SettingsAboutV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const version = () => platform.version ?? InstallationVersion

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.about")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-about-brand">
          {/* Brand wordmark — a proper noun, never translated. */}
          <div class="settings-v2-about-title">NovaClaw</div>
          <div class="settings-v2-about-version">v{version()}</div>
          <div class="settings-v2-about-author">{language.t("settings.about.author")}</div>
        </div>

        <div class="settings-v2-about-divider" />

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.about.credits.title")}</h3>
          <p class="settings-v2-field-description">{language.t("settings.about.credits.description")}</p>
          <ul class="settings-v2-about-credits">
            <For each={CREDITS}>
              {(credit) => (
                <li class="settings-v2-about-credit">
                  <span class="settings-v2-about-credit-name">{credit.name}</span>
                  <span class="settings-v2-about-credit-meta">
                    {credit.version ? `${credit.version} · ` : ""}
                    {credit.license}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <p class="settings-v2-about-note">{language.t("settings.about.basedOn")}</p>
          <p class="settings-v2-about-note settings-v2-about-note--muted">{language.t("settings.about.more")}</p>
        </div>
      </div>
    </>
  )
}
