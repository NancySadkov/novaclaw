import type { SessionV2Info as Session, SessionChangeDiff, SessionStatus, ProviderV2Info, ModelV2Info } from "@novaclaw/sdk/v2"
import { createSimpleContext } from "@novaclaw/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, ProviderV2Info>
  /** Non-deprecated models grouped by providerID. */
  models: Map<string, ModelV2Info[]>
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SessionChangeDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
    }
  },
})
