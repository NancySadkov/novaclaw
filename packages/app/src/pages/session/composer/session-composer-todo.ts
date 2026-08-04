// Pure todo-dock state logic, kept free of router/context imports so it stays unit-testable
// in bun's server-build solid environment (importing `session-composer-state.ts` — which pulls in
// `@solidjs/router` + the app contexts — throws a client-only API error there).

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export const todoDockAtBoundary = (state: ReturnType<typeof todoState>) => state === "open"
