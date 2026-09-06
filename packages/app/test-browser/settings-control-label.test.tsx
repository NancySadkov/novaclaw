import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { SettingsProvider } from "@/context/settings"
import { PlatformProvider } from "@/context/platform"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TextareaV2 } from "@novaclaw/ui/v2/textarea-v2"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
})

test("row titles name their controls, while explicit labels and switch captions win", () => {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <SettingsRowV2 title="Retention" description="How long files stay">
            <SelectV2 options={["7 days", "30 days"]} current="30 days" />
          </SettingsRowV2>
          <SettingsRowV2 title="Enabled" description="Enable the feature">
            <Switch />
          </SettingsRowV2>
          <SettingsRowV2 title="Endpoint" description="Where to connect">
            <TextInputV2 />
          </SettingsRowV2>
          <SettingsRowV2 title="Instructions" description="What to do">
            <TextareaV2 />
          </SettingsRowV2>
          <SettingsRowV2 title="Fallback" description="Ignored when explicitly named">
            <SelectV2 aria-label="Specific choice" options={["A"]} current="A" />
            <TextInputV2 aria-label="Specific text" />
            <TextareaV2 aria-label="Specific instructions" />
            <Switch aria-label="Specific switch" />
            <Switch>Own caption</Switch>
          </SettingsRowV2>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  const rows = [...host.querySelectorAll('[data-component="settings-v2-row"]')]
  for (const row of rows.slice(0, 4)) {
    const title = row.querySelector('[data-slot="settings-v2-row-title"]')!
    const control = row.querySelector('[data-component="select-v2"],input,textarea')!
    expect(title.id).not.toBe("")
    expect(control.getAttribute("aria-labelledby")?.split(" ")).toContain(title.id)
  }
  expect(host.querySelector('[data-component="select-v2"]')!.getAttribute("role")).toBe("button")
  for (const control of rows[4]!.querySelectorAll('[aria-label^="Specific"]')) {
    expect(control.getAttribute("aria-labelledby")?.split(" ") ?? []).not.toContain(
      rows[4]!.querySelector('[data-slot="settings-v2-row-title"]')!.id,
    )
  }
  const captioned = rows[4]!.querySelectorAll("input")[2]!
  const ids = captioned.getAttribute("aria-labelledby")!.split(" ")
  expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain("Own caption")
})
