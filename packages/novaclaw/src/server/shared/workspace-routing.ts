import { SessionID } from "@/session/schema"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/experimental/workspace", action: "local" },
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

export function isLocalWorkspaceRoute(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

export function getWorkspaceRouteSessionID(url: URL) {
  if (url.pathname === "/session/status") return null

  const id =
    url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1] ??
    // 🔴 **The NATIVE routes, which were missing here entirely until 2026-08-07.** This function
    // decides whether a request is session-scoped; if it says no, `planRequest` finds no workspace and
    // serves the request LOCALLY. So for a session owned by a REMOTE workspace, every `/api/session/**`
    // call — prompt included — ran on the wrong machine instead of being proxied to the workspace that
    // owns it. Silent: the local handler answers 200, so nothing looks wrong.
    //
    // ⚠️ The V1 `/session/:id` arm above matches routes the V1 nuke DELETED, so before this line the
    // only live pattern was the `experimental` one. Session-ownership routing was effectively dead for
    // the whole V2 API and nothing said so — the pinned `httpapi-workspace` test was the only thing
    // that would have noticed, and it was pinned.
    //
    // ⚠️ Requires the `ses` prefix rather than `[^/]+`: `/api/session/active` and
    // `/api/session/execution` are LITERAL routes, and a greedy segment match would read "active" as a
    // session id and try to resolve a workspace for it. `SessionID` is `isStartsWith("ses")`.
    url.pathname.match(/^\/api\/session\/(ses[^/]*)(?:\/|$)/)?.[1] ??
    url.pathname.match(/^\/experimental\/session\/([^/]+)\/background$/)?.[1]
  if (!id) return null

  return SessionID.make(id)
}

/**
 * Query parameters that must never leave this instance. `workspace` is routing state the target must
 * not re-read; `auth_token` is THIS instance's password.
 *
 * 🔴 The whole search string is copied through, so anything not deleted here reaches a machine that
 * is not ours — and a credential in a URL lands in the far end's access log, its Referer headers and
 * its history, where no later care can take it back. `auth_token` is a credential only on the
 * raw-router surface (see `httpapi/middleware/authorization.ts`), which is never proxied.
 */
const STRIPPED_PROXY_QUERY = ["workspace", "auth_token"]

export function workspaceProxyURL(target: string | URL, requestURL: URL) {
  const proxyURL = new URL(target)
  proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${requestURL.pathname}`
  proxyURL.search = requestURL.search
  proxyURL.hash = requestURL.hash
  for (const key of STRIPPED_PROXY_QUERY) proxyURL.searchParams.delete(key)
  return proxyURL
}
