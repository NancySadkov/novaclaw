// Re-export only: core owns this path because the PERMISSION layer needs the same value (the unattended
// confinement stance exempts this store). Two copies would drift silently.
export { TRUNCATION_DIR, TRUNCATION_RESOURCE } from "@novaclaw/core/tool/truncation-dir"
