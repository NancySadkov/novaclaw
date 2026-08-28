export interface BackedUpMemoryErase {
  readonly erased: number
  /** We can observe that the browser download was initiated, not that a file reached disk. */
  readonly backupStarted: boolean
}

/**
 * Preserve the destructive ordering as a small, executable unit: the complete backup must be read
 * and offered to the browser before the erase request is allowed to begin. Any read or preparation
 * fault rejects immediately and leaves `erase` untouched.
 */
export async function runBackedUpMemoryErase(input: {
  readonly collect: () => Promise<string>
  readonly beginBackup: (bundle: string) => void
  readonly erase: () => Promise<number>
}): Promise<BackedUpMemoryErase> {
  const bundle = await input.collect()
  if (bundle) input.beginBackup(bundle)
  const erased = await input.erase()
  return { erased, backupStarted: bundle.length > 0 }
}
