// Finds the AWR project a conversation's working directory belongs to.
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The nearest directory at or above `start` that holds an AWR project: one with a
 * `.awr/project.toml` (the manifest) or a `.awr/runtime-binding.json` (a pinned runtime).
 * A bare `.awr` directory is not enough, since it can be left behind by a failed init.
 * Returns `undefined` when the directory is not inside an AWR project.
 *
 * @param {string} start an absolute or relative directory
 */
export async function findProjectRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if ((await exists(join(dir, '.awr', 'project.toml'))) || (await exists(join(dir, '.awr', 'runtime-binding.json')))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
