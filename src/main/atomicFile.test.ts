import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileAtomic } from './atomicFile'

async function fileExists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

describe('writeFileAtomic', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'timbre-atomic-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('writes the full contents and leaves no temp file behind', async () => {
    const path = join(root, 'meta.json')
    await writeFileAtomic(path, '{"a":1}')
    expect(await fs.readFile(path, 'utf-8')).toBe('{"a":1}')
    expect(await fileExists(`${path}.tmp-${process.pid}`)).toBe(false)
  })

  it('creates missing parent directories', async () => {
    const path = join(root, 'nested', 'deep', 'transcript.txt')
    await writeFileAtomic(path, 'hello')
    expect(await fs.readFile(path, 'utf-8')).toBe('hello')
  })

  it('overwrites an existing file in place', async () => {
    const path = join(root, 'meta.json')
    await writeFileAtomic(path, 'first')
    await writeFileAtomic(path, 'second')
    expect(await fs.readFile(path, 'utf-8')).toBe('second')
  })

  it('cleans up the temp file and never leaves a partial file when rename fails', async () => {
    // Force the rename to fail by making the destination a NON-EMPTY directory:
    // renaming a file onto it fails on every platform (ENOTEMPTY/EEXIST), after
    // the temp file has already been written — exactly the crash window we guard.
    const path = join(root, 'occupied')
    await fs.mkdir(path)
    await fs.writeFile(join(path, 'child'), 'x')

    await expect(writeFileAtomic(path, 'data')).rejects.toBeTruthy()
    // The staged temp must be gone (no orphaned .tmp-* litter).
    expect(await fileExists(`${path}.tmp-${process.pid}`)).toBe(false)
    // And the destination directory is untouched — no partial write.
    const stat = await fs.stat(path)
    expect(stat.isDirectory()).toBe(true)
  })
})
