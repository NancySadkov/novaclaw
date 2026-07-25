import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@novaclaw/ui/context"
import { persisted } from "@/utils/persist"

// Progressive disclosure with consent (uix.md §6): the friendliest surface by default; advanced
// capability is opt-in behind an explicit, reversible unlock. Gated things are HIDDEN, not disabled.
// A safe default of "normal" means any load race fails safe (hides the sharp tools).
export type ExpertiseLevel = "normal" | "advanced" | "developer"
export const EXPERTISE_ORDER: Record<ExpertiseLevel, number> = { normal: 0, advanced: 1, developer: 2 }

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    defaultPermissionMode: "plan" | "ask" | "surgical" | "bypass" | "yolo"
    // Feed expansion prefs for the NATIVE transcript: "auto" = the expertise-level default
    // (C4 — Normal collapsed, Advanced live, Developer open); explicit values always win.
    // Replaced the dead V1-path shellToolPartsExpanded/editToolPartsExpanded switches, which
    // the native transcript never read (owner-hit 2026-07-22).
    feedReasoningDisplay: "auto" | "expanded" | "collapsed"
    feedToolDisplay: "auto" | "expanded" | "collapsed"
    showCustomAgents: boolean
    mobileTitlebarPosition: "top" | "bottom"
    expertiseLevel: ExpertiseLevel
    newLayoutDesigns?: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
    // Color-scheme preset id (uix.md §7): "nova" (default gold/purple) | "summer" | "autumn".
    appTheme: string
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
// The new layout IS the product (launcher home, purple+gold, Chats hero — see uix.md): default ON
// everywhere. The flip-back toggle is a dev-channel escape hatch only (gated in BOTH settings
// dialogs), so prod can never strand itself in the legacy shell with no way back.
export const newLayoutDesignsDefault = true

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "steer",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: true,
    // Write access to the PROJECT FOLDER by default (owner 2026-07-25). Outside the folder is still
    // guarded regardless of mode, so this is "trusted here", not "trusted everywhere".
    defaultPermissionMode: "bypass",
    feedReasoningDisplay: "auto",
    feedToolDisplay: "auto",
    showCustomAgents: false,
    mobileTitlebarPosition: "top",
    expertiseLevel: "normal",
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    appTheme: "nova",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const [store, setStore, _, ready] = persisted("settings.v3", createStore<Settings>(defaultSettings))
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    const newLayoutDesigns = withFallback(() => store.general?.newLayoutDesigns, newLayoutDesignsDefault)
    // Chrome visibility is the layout's job (uix.md): session chrome (file tree, search, status,
    // custom agents) is always REACHABLE. The per-surface prefs only had writers in the pruned
    // Advanced settings section — honoring them in the new layout would strand the chrome
    // default-hidden with no remaining toggle. The stored show* keys are frozen legacy state.
    const visible = (_preference: () => boolean) => createMemo(() => true)

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setStore("general", "followup", "steer")
    })

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value === "queue" ? "steer" : value)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        // 1K: the DEFAULT permission mode a new session starts on — the "yolo
        // setting" surface (yolo itself is the server-side mode overlay).
        defaultPermissionMode: withFallback(
          () => store.general?.defaultPermissionMode,
          defaultSettings.general.defaultPermissionMode,
        ),
        setDefaultPermissionMode(value: Settings["general"]["defaultPermissionMode"]) {
          setStore("general", "defaultPermissionMode", value)
        },
        feedReasoningDisplay: withFallback(
          () => store.general?.feedReasoningDisplay,
          defaultSettings.general.feedReasoningDisplay,
        ),
        setFeedReasoningDisplay(value: Settings["general"]["feedReasoningDisplay"]) {
          setStore("general", "feedReasoningDisplay", value)
        },
        feedToolDisplay: withFallback(() => store.general?.feedToolDisplay, defaultSettings.general.feedToolDisplay),
        setFeedToolDisplay(value: Settings["general"]["feedToolDisplay"]) {
          setStore("general", "feedToolDisplay", value)
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
        mobileTitlebarPosition: withFallback(
          () => store.general?.mobileTitlebarPosition,
          defaultSettings.general.mobileTitlebarPosition,
        ),
        setMobileTitlebarPosition(value: "top" | "bottom") {
          setStore("general", "mobileTitlebarPosition", value)
        },
        // Expertise level (uix.md §6) — the progressive-disclosure gate. Client-owned so it applies
        // at first paint and works with zero servers connected; per-device is a feature (a phone stays
        // friendly while the desktop is Developer). Reset UI prefs returns it to "normal" for free.
        expertiseLevel: withFallback(() => store.general?.expertiseLevel, defaultSettings.general.expertiseLevel),
        setExpertiseLevel(value: ExpertiseLevel) {
          setStore("general", "expertiseLevel", value)
        },
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          setStore("general", "newLayoutDesigns", value)
        },
      },
      visibility: {
        fileTree: visible(showFileTree),
        search: visible(showSearch),
        status: visible(showStatus),
        customAgents: visible(showCustomAgents),
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        appTheme: withFallback(() => store.appearance?.appTheme, defaultSettings.appearance.appTheme),
        setAppTheme(value: string) {
          setStore("appearance", "appTheme", value)
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
})
