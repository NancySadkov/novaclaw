/** Shared by both runners: one compaction role, never two prompt copies that can drift. */
export const COMPACTION_SYSTEM = `You write continuation summaries.

Use only supplied history. Recent turns may remain outside it. Merge <previous-summary>: keep true, relevant facts; remove stale ones.

Follow the requested structure. Do not answer the conversation or mention compaction. Use its language.`
