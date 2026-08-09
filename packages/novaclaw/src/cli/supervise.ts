// The dependency-free policy is shared with Electron main through a public package boundary. This
// thin re-export keeps the CLI surface stable while both supervisors execute the same implementation.
export * from "@novaclaw/script/supervise"
