import { type Component, For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { startAboutScene, type AboutScene } from "./about-scene"

type Credit = { name: string; version?: string; license: string }

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
  const [needsPlay, setNeedsPlay] = createSignal(false)
  let canvas!: HTMLCanvasElement
  let audio!: HTMLAudioElement
  let stage!: HTMLDivElement
  let scene: AboutScene | undefined
  let disposed = false

  const play = () => {
    void Promise.all([audio.play(), scene?.resumeAudio()]).then(
      () => { if (!disposed) setNeedsPlay(false) },
      () => { if (!disposed) setNeedsPlay(true) },
    )
  }

  onMount(() => {
    scene = startAboutScene(canvas, audio, stage)
    play()
    onCleanup(() => {
      disposed = true
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      scene?.stop()
    })
  })

  return (
    <div class="settings-v2-about" ref={stage}>
      <div class="settings-v2-about-stage">
        <canvas ref={canvas} class="settings-v2-about-canvas" aria-hidden="true" />
        <div class="settings-v2-about-vignette" aria-hidden="true" />
        <div class="settings-v2-about-heading">
          <span class="settings-v2-about-overline">THE UNSLEEPING EYE</span>
          <h2 class="settings-v2-about-title">NovaClaw</h2>
          <span class="settings-v2-about-version">v{version()}</span>
        </div>
        <div class="settings-v2-about-lower">
          <span class="settings-v2-about-author">{language.t("settings.about.author")}</span>
          <Show when={needsPlay()}>
            <button type="button" class="settings-v2-about-play" onClick={play}>Play soundtrack</button>
          </Show>
        </div>
      </div>
      <div class="settings-v2-about-credits-window">
        <div class="settings-v2-about-credits-track">
          <span class="settings-v2-about-credits-kicker">{language.t("settings.about.credits.title")}</span>
          <ul class="settings-v2-about-credits">
            <For each={CREDITS}>
              {(credit) => (
                <li class="settings-v2-about-credit">
                  <span>{credit.name}</span>
                  <span class="settings-v2-about-credit-meta">{credit.version ? `${credit.version} · ` : ""}{credit.license}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="settings-v2-about-note">{language.t("settings.about.more")}</p>
        </div>
      </div>
      <audio ref={audio} src="/assets/audio/nova.ogg" preload="auto" loop aria-hidden="true" />
    </div>
  )
}
