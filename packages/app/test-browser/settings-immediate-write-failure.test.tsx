import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { toasterV2 } from "@novaclaw/ui/v2/toast-v2"
import { LanguageContext } from "@/context/language"
import { ServerSyncContext } from "@/context/server-sync"
import { useSettingsConfigWrite } from "@/components/settings-v2/parts/config-write"
import { ToastRegion } from "@/utils/toast"
import { languageStub } from "./language-stub"

const CASES = [
  ["shell", { shell: "bash" }],
  ["offline", { offline: true }],
  ["virtual-fs", { virtualFs: true }],
  ["telemetry", { telemetry: { enabled: false } }],
  ["resume", { recovery: { resume_interrupted: false } }],
] as const

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  toasterV2.clear()
})

function ImmediateWrites(props: { patches: ReadonlyArray<readonly [string, Record<string, unknown>]> }) {
  const write = useSettingsConfigWrite()
  return (
    <>
      {props.patches.map(([name, patch]) => (
        <button data-action={name} onClick={() => void write(patch)}>
          {name}
        </button>
      ))}
      <ToastRegion />
    </>
  )
}

describe("the shared immediate settings write door", () => {
  test.each(CASES)("the refused %s control stays on confirmed config and says why", async (name, patch) => {
    const [store] = createStore({ config: {}, path: {} })
    let writes = 0
    const sync = () => ({
      data: store,
      updateConfig: async () => {
        writes += 1
        throw new Error("instance is restarting")
      },
    })

    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(
      () => (
        <LanguageContext.Provider value={languageStub as never}>
          <ServerSyncContext.Provider value={sync as never}>
            <ImmediateWrites patches={[[name, patch]]} />
          </ServerSyncContext.Provider>
        </LanguageContext.Provider>
      ),
      host,
    )

    document.querySelector(`[data-action="${name}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toBe(1)
    expect(store.config).toEqual({})
    const descriptions = [...document.querySelectorAll('[data-slot="toast-v2-description"]')]
    expect(descriptions).toHaveLength(1)
    expect(descriptions.every((node) => node.textContent === "instance is restarting")).toBe(true)
  })
})
