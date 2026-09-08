export const preloadFailureRecovery = (input: {
  readonly window: string
  readonly preloadPath: string
  readonly error: unknown
}) => ({
  message: "NovaClaw could not start",
  detail: [
    `Window: ${input.window}`,
    `Preload: ${input.preloadPath}`,
    `Error: ${input.error instanceof Error ? input.error.message : String(input.error)}`,
  ].join("\n"),
})
