export const promptSourceKey = (
  server: string | undefined,
  directory: string | undefined,
  sessionID: string | undefined,
  created: number | undefined,
  updated: number | undefined,
) => ["session-prompt-source", server, directory, sessionID, created, updated] as const
