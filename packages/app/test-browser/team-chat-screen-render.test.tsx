import { afterEach, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { AppPage } from "@/components/app-page"
import { TeamChatScreen } from "@/components/team-chat-screen"
import { SDKProvider } from "@/context/sdk"
import { GlobalContext } from "@/context/global"
import { ServerContext } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { LanguageContext } from "@/context/language"
import { PlatformProvider } from "@/context/platform"

// ⚠️ Deliberately ROUTER-FREE. This directory runs as one process and `prompt-persistence.test.ts`
// registers a process-wide `mock.module("@solidjs/router", …)` whose `useParams` returns `{}`, so a
// mount that went through the real page would only pass while it happened to run before that file.
// The screen takes its officer and its exit as PROPS, so it can be exercised without the router; the
// returnTo routing itself is pinned in `titlebar-officer-settings.test.ts` and the app:unit guard.

const AGENT = {
  id: "theron",
  name: "Theron",
  title: "Bookkeeper",
  memory: "own" as const,
  mode: "primary" as const,
  hidden: false,
  config: {},
}

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

test("Team Chat mounts as a full-window screen and Back hands off to its source", async () => {
  const host = document.createElement("div")
  document.body.append(host)

  const connection = {
    type: "http" as const,
    key: "local",
    url: "http://localhost:4096",
    http: { url: "http://localhost:4096" },
  }
  const calls: Array<Record<string, unknown>> = []
  const client = {
    v2: {
      agent: {
        teamChat: async (input: Record<string, unknown>) => {
          calls.push(input)
          return {
            data: {
              data: {
                data: [
                  {
                    id: "msg_team",
                    sender: "theron",
                    recipient: "nova",
                    turn: "ask" as const,
                    text: "Verify the release hash.",
                    created: 1_790_268_000_000,
                  },
                ],
                cursor: {},
              },
            },
          }
        },
      },
    },
  }
  const sdk = {
    ensureDirSdkContext: (directory: string) => ({ directory, client, event: { listen: () => () => {} } }),
  }
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ agents: { list: () => [AGENT] }, sdk }),
  }
  const languageStub = {
    t: (key: string) => key,
    plural: (group: string) => group,
    intl: () => "en",
    locale: () => "en",
    setLocale: () => {},
  }
  let backCount = 0

  dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <QueryClientProvider client={new QueryClient()}>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection, key: "local" } as never}>
                <ServerSDKProvider>
                  <SDKProvider directory="/tmp/p">
                    <AppPage class="flex flex-col overflow-hidden">
                      <TeamChatScreen agentID="theron" roster={[AGENT]} onBack={() => backCount++} />
                    </AppPage>
                  </SDKProvider>
                </ServerSDKProvider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </QueryClientProvider>
      </PlatformProvider>
    ),
    host,
  )
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('[data-component="app-page"] [data-component="team-chat-screen"]')).not.toBeNull()
  expect(document.body.textContent).toContain("Theron")
  expect(document.body.textContent).toContain("Verify the release hash.")
  expect(calls[0]).toMatchObject({ agentID: "theron", limit: "50" })

  ;(document.querySelector('[data-action="team-chat-back"]') as HTMLButtonElement).click()
  expect(backCount).toBe(1)
})
