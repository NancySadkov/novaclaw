interface ImportMetaEnv {
  readonly NOVACLAW_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:novaclaw-server" {
  export namespace Server {
    export const listen: typeof import("../../../novaclaw/dist/types/src/node").Server.listen
    export type Listener = import("../../../novaclaw/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../novaclaw/dist/types/src/node").Config.get
    export type Info = import("../../../novaclaw/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../novaclaw/dist/types/src/node").bootstrap
}
