import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { ParentProps } from "solid-js"
import { PlatformProvider } from "@/context/platform"
import { LanguageProvider } from "@/context/language"
import { StartupScreen, useStartupScreen } from "@/components/startup-screen"

function Providers(props: ParentProps) {
  return (
    <PlatformProvider
      value={{
        platform: "web",
        openLink() {},
        back() {},
        forward() {},
        restart: async () => {},
        notify: async () => {},
      }}
    >
      <LanguageProvider locale="en">{props.children}</LanguageProvider>
    </PlatformProvider>
  )
}

test("one Eye stays mounted through desktop preparation and the connection gate", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let startup!: ReturnType<typeof useStartupScreen>
  const Gate = () => {
    startup = useStartupScreen()
    return <div>Application</div>
  }
  const dispose = render(
    () => (
      <Providers>
        <StartupScreen initialStage="desktop">
          <StartupScreen>
            <Gate />
          </StartupScreen>
        </StartupScreen>
      </Providers>
    ),
    host,
  )
  try {
    const eye = host.querySelector(".nova-dawn")
    expect(eye).not.toBeNull()
    expect(host.querySelectorAll(".nova-dawn").length).toBe(1)
    expect(eye?.querySelector("[role=status]")?.textContent).toBe("Preparing the desktop.")
    startup.report("preferences")
    expect(host.querySelector(".nova-dawn")).toBe(eye)
    expect(eye?.querySelector("[role=status]")?.textContent).toBe("Restoring your preferences.")
    startup.begin("server")
    expect(host.querySelector(".nova-dawn")).toBe(eye)
    expect(eye?.querySelector("[role=status]")?.textContent).toBe("Starting the local server.")
    startup.begin("connection")
    expect(host.querySelector(".nova-dawn")).toBe(eye)
    expect(eye?.querySelector("[role=status]")?.textContent).toBe("Checking the connection to your instance.")
    startup.complete()
    expect(host.querySelector(".nova-dawn")).toBeNull()
    expect(host.firstElementChild?.getAttribute("style")).toContain("contents")
  } finally {
    dispose()
    host.remove()
  }
})

test("a later blocking connection check can start a fresh screen and release it on failure", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let startup!: ReturnType<typeof useStartupScreen>
  const Gate = () => {
    startup = useStartupScreen()
    return <div>Connection help</div>
  }
  const dispose = render(
    () => (
      <Providers>
        <StartupScreen>
          <Gate />
        </StartupScreen>
      </Providers>
    ),
    host,
  )
  try {
    const first = host.querySelector(".nova-dawn")
    startup.complete()
    startup.report("preferences")
    expect(host.querySelector(".nova-dawn")).toBeNull()
    startup.begin("connection")
    expect(host.querySelector(".nova-dawn")).not.toBe(first)
    expect(host.querySelectorAll(".nova-dawn").length).toBe(1)
    startup.complete()
    expect(host.querySelector(".nova-dawn")).toBeNull()
    expect(host.textContent).toBe("Connection help")
  } finally {
    dispose()
    host.remove()
  }
})
