import * as fs from 'node:fs'

/**
 * Write text to a file atomically: write to a temp file then rename.
 * Belongs to the platform/fs layer so both platform and domain code can use it
 * without creating a platform -> domains reverse dependency.
 */
export const writeTextFileAtomic = async (targetPath: string, text: string): Promise<void> => {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  await fs.promises.writeFile(tempPath, text, 'utf-8')
  await fs.promises.rename(tempPath, targetPath)
}
