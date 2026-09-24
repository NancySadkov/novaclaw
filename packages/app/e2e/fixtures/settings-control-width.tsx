import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { PresetFieldV2 } from "@/components/settings-v2/parts/preset-field"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { languageStub } from "../../test-browser/language-stub"

export function mount() {
  const host = document.createElement("div")
  host.dataset.fixture = "settings-control-width"
  host.style.width = "240px"
  document.body.append(host)

  const dispose = render(
    () => (
      <LanguageContext.Provider value={languageStub as never}>
        <div id="preset" class="flex flex-wrap items-center justify-between gap-2">
          <span class="min-w-0">Calm-baseline temperature</span>
          <PresetFieldV2 field="temperature" value={() => "0.7"} onValue={() => {}} ariaLabel="Temperature" />
        </div>
        <div id="profile-input" style={{ width: "160px" }}>
          <TextInputV2 aria-label="Profile name" value="Officer" />
        </div>
        <div id="profile-select" style={{ width: "160px" }}>
          <SelectV2 aria-label="Profile choice" options={["One", "Two"]} current="One" />
        </div>
      </LanguageContext.Provider>
    ),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
