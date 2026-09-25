interface ImportMetaEnv {
  readonly NOVACLAW_CHANNEL: string
  /**
   * True in a CLIENT-only build: no compiled server, no agent toolchain. `index.ts` uses it to default
   * the launch mode to `client`, so a bare double-click connects to a server instead of trying to
   * spawn one this package does not carry.
   */
  readonly NOVACLAW_DESKTOP_CLIENT?: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
