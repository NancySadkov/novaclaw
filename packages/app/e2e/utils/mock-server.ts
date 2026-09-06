import type { Page, Route } from "@playwright/test"

const emptyList = new Set(["/skill", "/command", "/app"])

/**
 * The `{ location, data }` envelope every `/api` route answers in. The VCS family joined them on
 * 2026-09-03, and a mock that kept returning the bare body would have let the app's unwrap regress
 * without a single spec going red.
 */
const located = (directory: string, data: unknown) => ({
  location: { directory, root: directory, origin: "local" },
  data,
})
const emptyObject = new Set(["/global/config", "/config", "/mcp", "/session/status"])

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  vcsDiff?: unknown[]
  messageDelay?: number
  onMessages?: (input: { sessionID: string; before?: string; phase: "start" | "end" }) => void
  events?: () => unknown[]
  eventRetry?: number
  todos?: (sessionID: string) => unknown[]
}

function sessionForWire(session: Record<string, unknown>, directory: string) {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...session,
    location: session.location ?? { directory: (session.directory as string | undefined) ?? directory },
  }
}

function providerCatalogForWire(input: unknown) {
  if (!input || typeof input !== "object") return { providers: [], models: [], connected: [], default: {} }
  const legacy = input as {
    all?: Array<Record<string, unknown>>
    connected?: string[]
    default?: Record<string, string>
  }
  if (!Array.isArray(legacy.all)) return input
  const models = legacy.all.flatMap((provider) => {
    const entries = Object.entries((provider.models as Record<string, Record<string, unknown>> | undefined) ?? {})
    return entries.map(([id, model]) => ({
      id,
      providerID: provider.id,
      name: model.name ?? id,
      api: { id, type: "native", settings: {} },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: Object.keys((model.variants as Record<string, unknown> | undefined) ?? {}).map((variant) => ({
        id: variant,
        headers: {},
        body: {},
      })),
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: (model.limit as { context?: number } | undefined)?.context ?? 200_000, output: 8_192 },
    }))
  })
  return {
    providers: legacy.all.map(({ models: _, ...provider }) => ({
      ...provider,
      api: { type: "native", settings: {} },
      request: { headers: {}, body: {} },
    })),
    models,
    connected: legacy.connected ?? [],
    default: legacy.default ?? {},
  }
}

export async function mockNovaClawServer(page: Page, config: MockServerConfig) {
  const cursors = new Map<string, string>()
  let nextCursor = 0
  const sessions = config.sessions.map((session) => sessionForWire(session, config.directory))
  const staticRoutes: Record<string, unknown> = {
    "/provider": providerCatalogForWire(config.provider),
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/NovaClaw",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/session": sessions,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"
    const appPort = new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).port
    if (url.port !== targetPort && url.port !== appPort) return route.fallback()

    const path = url.pathname
    if (path === "/global/event" || path === "/event") {
      if (!config.events && config.eventRetry === undefined) return route.fallback()
      return sse(route, config.events?.(), config.eventRetry)
    }
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/api/vcs") return json(route, located(config.directory, { branch: "main", default_branch: "main" }))
    if (path === "/api/vcs/status") return json(route, located(config.directory, []))
    if (path === "/api/vcs/diff") return json(route, located(config.directory, config.vcsDiff ?? []))
    if (path === "/api/session") return json(route, { data: sessions, cursor: {} })
    if (path === "/api/session/active") return json(route, { data: {} })
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const v2SessionMatch = path.match(/^\/api\/session\/([^/]+)$/)
    if (v2SessionMatch) {
      const session = sessions.find((s) => s.id === v2SessionMatch[1])
      return json(route, { data: session ?? null })
    }

    const v2TodoMatch = path.match(/^\/api\/session\/([^/]+)\/todo$/)
    if (v2TodoMatch) return json(route, { data: config.todos?.(v2TodoMatch[1]!) ?? [] })
    if (/^\/api\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, { data: [] })

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/)
    if (todoMatch) return json(route, config.todos?.(todoMatch[1]!) ?? [])
    if (/^\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, [])

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const token = url.searchParams.get("before") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "start" })
      if (config.messageDelay) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "end" })
      if (!pageData.cursor) return json(route, pageData.items)
      const cursor = `cursor_${++nextCursor}`
      cursors.set(cursor, pageData.cursor)
      return json(route, pageData.items, { "x-next-cursor": cursor })
    }

    const v2MessagesMatch = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (v2MessagesMatch) {
      const before = url.searchParams.get("cursor") ?? undefined
      config.onMessages?.({ sessionID: v2MessagesMatch[1], before, phase: "start" })
      if (config.messageDelay) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages(v2MessagesMatch[1], limit, before)
      config.onMessages?.({ sessionID: v2MessagesMatch[1], before, phase: "end" })
      return json(route, {
        data: pageData.items,
        cursor: pageData.cursor ? { next: pageData.cursor } : {},
      })
    }

    if (url.port === targetPort && targetPort !== appPort) return json(route, {})
    return route.fallback()
  })
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}
