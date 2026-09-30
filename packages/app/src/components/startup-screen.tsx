import { createContext, createSignal, Show, useContext, type ParentProps } from "solid-js"
import { useLanguage } from "../context/language"
import { StartupSplash } from "./startup-splash"

export type StartupStage = "desktop" | "preferences" | "server" | "connection"

const StartupContext = createContext<{
  begin(stage: StartupStage): void
  report(stage: StartupStage): void
  complete(): void
}>()

export function useStartupScreen() {
  const startup = useContext(StartupContext)
  if (!startup) throw new Error("StartupScreen is required")
  return startup
}

export function StartupScreen(props: ParentProps<{ initialStage?: StartupStage }>) {
  if (useContext(StartupContext)) return props.children
  const language = useLanguage()
  const [stage, setStage] = createSignal<StartupStage>(props.initialStage ?? "connection")
  const [complete, setComplete] = createSignal(false)
  const startup = {
    begin(next: StartupStage) {
      setStage(next)
      setComplete(false)
    },
    report(next: StartupStage) {
      if (!complete()) setStage(next)
    },
    complete() {
      setComplete(true)
    },
  }
  return (
    <StartupContext.Provider value={startup}>
      <div style={{ display: complete() ? "contents" : "none" }}>{props.children}</div>
      <Show when={!complete()}>
        <StartupSplash
          message={(phase) => {
            const progress = language.t(`startup.stage.${stage()}`)
            if (phase === "starting") return progress
            return `${progress} ${language.t(phase === "slow" ? "startup.slowNotice" : "startup.stalledNotice")}`
          }}
        />
      </Show>
    </StartupContext.Provider>
  )
}
