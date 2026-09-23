import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
    __NOVACLAW__?: {
      deepLinks?: string[]
      recipePackages?: { name: string; bytes: Uint8Array }[]
    }
  }
}
