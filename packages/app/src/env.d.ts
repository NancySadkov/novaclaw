interface ImportMetaEnv {
  readonly VITE_NOVACLAW_SERVER_HOST: string
  readonly VITE_NOVACLAW_SERVER_PORT: string
  readonly VITE_NOVACLAW_CHANNEL?: "dev" | "beta" | "prod"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
