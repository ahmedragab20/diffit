// @vitest-environment node
//
// Unit tests for `findFileAccessTuiBinary(callerUrl)` — the --fs-rpc-aware
// sibling of `findViewerTuiBinary`. Contract under test:
//   * the package root is derived from the caller URL for both dist
//     (`dist/cli.mjs`) and source (`src/lib/*.mjs`) layouts and is verified
//     by reading `<root>/package.json`, which must parse with
//     `name === 'diffing'`;
//   * `realpathSync(root)` and the realpaths of the candidates define
//     canonical containment — a candidate that resolves outside the
//     canonical root is ignored, and parent-of-package paths are never
//     candidates;
//   * only package-local candidates are considered (sibling dist binary,
//     `target/release`, `target/debug`, bundled native, `bin/`); a PATH
//     lookup via `which`/`where` must NEVER be attempted;
//   * each existing candidate is probed with `--help` (1500 ms timeout,
//     64 KiB maxBuffer, windowsHide) and only one whose output mentions
//     `--fs-rpc` qualifies; the first supporting local binary wins.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mockReadFileSync = vi.fn()
const mockRealpathSync = vi.fn()
const mockExistsSync = vi.fn()
const mockExecFileSync = vi.fn()
const mockExecFileAsync = vi.fn()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
    existsSync: mockExistsSync,
  }
})
// `promisify(execFile)` is evaluated at module load, so replace `promisify`
// wholesale with one that hands back our mock async execFile.
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>()
  return { ...actual, promisify: () => mockExecFileAsync }
})
// Spy so an accidental `which`/`where` (PATH lookup) is loudly visible.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: mockExecFileSync }
})

// Fixture layout (never present on disk — every fs call is mocked):
//   <repo>/fixture/package.json          <- package root manifest
//   <repo>/fixture/dist/cli.mjs          <- dist-layout caller
//   <repo>/fixture/src/lib/cli.mjs       <- source-layout caller
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixture')
const ROOT = FIXTURE
const ROOT_MANIFEST = resolve(ROOT, 'package.json')
const DIST = resolve(ROOT, 'dist')
const SRC_LIB = resolve(ROOT, 'src', 'lib')
const CALLER_DIST_URL = pathToFileURL(resolve(DIST, 'cli.mjs')).href
const CALLER_SRC_URL = pathToFileURL(resolve(SRC_LIB, 'cli.mjs')).href

const EXT = process.platform === 'win32' ? '.exe' : ''

// Candidate paths relative to the derived package root / caller dir.
const SIBLING = resolve(DIST, `diffing-tui${EXT}`)
const RELEASE = resolve(ROOT, 'target', 'release', `diffing-tui${EXT}`)
const DEBUG = resolve(ROOT, 'target', 'debug', `diffing-tui${EXT}`)
const BIN = resolve(ROOT, 'bin', `diffing-tui${EXT}`)
// Parent-of-package path: must never be a candidate, even when it exists.
const RELEASE_UP = resolve(ROOT, '..', 'target', 'release', `diffing-tui${EXT}`)
// Outside-of-root resolution target for the symlink exclusion test.
const OUTSIDE = resolve(ROOT, '..', 'outside', `diffing-tui${EXT}`)

// Bundled native candidate. The runtime suffix must come from the (mocked)
// report header deterministically — the real process.report is never read.
function stubRuntimeReport(glibcVersionRuntime?: string) {
  Object.defineProperty(process, 'report', {
    value: { getReport: () => ({ header: { glibcVersionRuntime } }) },
    configurable: true,
  })
}

function bundledPath(target: string, ext = EXT): string {
  return resolve(DIST, 'native', target, `diffing-tui${ext}`)
}

const SUPPORTING_STDOUT = 'usage: diffing-tui [--view-only] [--fs-rpc] ...'
const UNSUPPORTED_STDOUT = 'usage: diffing-tui [--view-only] ...'

const PROBE_OPTIONS = expect.objectContaining({
  timeout: 1_500,
  maxBuffer: 64 * 1024,
  windowsHide: true,
})

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

describe('findFileAccessTuiBinary', () => {
  // Candidates configured to "exist" for the current test. realpathSync
  // maps each of them to itself; the root maps to itself; everything else
  // throws ENOENT.
  let existing: Set<string>
  let manifestJson: string

  const originalPlatform = process.platform
  const originalReport = process.report

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    existing = new Set()
    manifestJson = JSON.stringify({ name: 'diffing', version: '0.0.0', private: true })

    mockReadFileSync.mockImplementation((p: string) => {
      if (p === ROOT_MANIFEST) return manifestJson
      throw enoent()
    })
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === ROOT) return ROOT
      if (existing.has(p)) return p
      throw enoent()
    })
    mockExistsSync.mockImplementation((p: string) => p === ROOT_MANIFEST || existing.has(p))

    // PATH lookup must never happen; if it somehow does, surface it loudly
    // with a "malicious consumer path" that must never be returned.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('PATH lookup attempted — findFileAccessTuiBinary must be local-only')
    })
    // Probes resolve with an unsupported help screen unless overridden.
    mockExecFileAsync.mockResolvedValue({ stdout: UNSUPPORTED_STDOUT, stderr: '' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    Object.defineProperty(process, 'report', {
      value: originalReport,
      configurable: true,
    })
  })

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  it('derives the package root from a dist-layout caller and returns a supporting target/debug candidate', async () => {
    existing.add(DEBUG)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === DEBUG ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(DEBUG)
    // The root manifest (and only the root manifest) must have been read.
    expect(mockReadFileSync.mock.calls.some(call => call[0] === ROOT_MANIFEST)).toBe(true)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('derives the same package root from a source-layout caller (src/lib)', async () => {
    existing.add(DEBUG)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === DEBUG ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_SRC_URL)).resolves.toBe(DEBUG)
    expect(mockReadFileSync.mock.calls.some(call => call[0] === ROOT_MANIFEST)).toBe(true)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns null with no local candidates and never consults PATH — even when which/where would yield a malicious consumer path', async () => {
    const malicious = resolve(ROOT, '..', 'consumer-pwn', `diffing-tui${EXT}`)
    mockExecFileSync.mockReturnValue(malicious)

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('skips an existing-but-unsupported local binary and returns a supporting debug candidate', async () => {
    existing.add(SIBLING)
    existing.add(DEBUG)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === DEBUG ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(DEBUG)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('skips an existing-but-unsupported local binary and returns a supporting bundled candidate', async () => {
    stubRuntimeReport('2.36') // linux-style glibc header → gnu suffix
    setPlatform('linux')
    const target = `tui-${['linux', process.arch, 'gnu'].join('-')}`
    const bundled = bundledPath(target)
    existing.add(SIBLING)
    existing.add(bundled)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === bundled ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(bundled)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('names the bundled candidate with a gnu runtime suffix on Linux when the report header has glibcVersionRuntime', async () => {
    stubRuntimeReport('2.36')
    setPlatform('linux')
    const bundled = bundledPath(`tui-${['linux', process.arch, 'gnu'].join('-')}`)
    existing.add(bundled)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === bundled ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(bundled)
  })

  it('names the bundled candidate with a musl runtime suffix on Linux when the report header has no glibcVersionRuntime', async () => {
    stubRuntimeReport(undefined)
    setPlatform('linux')
    const bundled = bundledPath(`tui-${['linux', process.arch, 'musl'].join('-')}`)
    existing.add(bundled)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === bundled ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(bundled)
  })

  it('names the bundled candidate with an msvc runtime suffix on Windows', async () => {
    setPlatform('win32')
    const winExt = '.exe'
    const bundled = bundledPath(`tui-${['win32', process.arch, 'msvc'].join('-')}`, winExt)
    existing.add(bundled)
    mockExecFileAsync.mockImplementation(async (candidate: string) =>
      candidate === bundled ? { stdout: SUPPORTING_STDOUT, stderr: '' } : { stdout: UNSUPPORTED_STDOUT, stderr: '' },
    )

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(bundled)
  })

  it('returns null when every local probe reports an unsupported binary', async () => {
    for (const p of [SIBLING, RELEASE, DEBUG, BIN]) existing.add(p)
    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns null when every local probe errors', async () => {
    for (const p of [SIBLING, RELEASE, DEBUG, BIN]) existing.add(p)
    mockExecFileAsync.mockRejectedValue(new Error('spawn failed'))
    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('selects the first supporting local candidate', async () => {
    for (const p of [SIBLING, RELEASE, DEBUG, BIN]) existing.add(p)
    mockExecFileAsync.mockImplementation(async () => ({ stdout: SUPPORTING_STDOUT, stderr: '' }))

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBe(SIBLING)
    expect(mockExecFileAsync).toHaveBeenCalledWith(SIBLING, ['--help'], expect.anything())
  })

  it('pins the probe: `--help` argument and 1500ms timeout / 64KiB maxBuffer / windowsHide options', async () => {
    for (const p of [SIBLING, RELEASE, DEBUG, BIN]) existing.add(p)
    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()

    expect(mockExecFileAsync).toHaveBeenCalled()
    for (const call of mockExecFileAsync.mock.calls) {
      expect(call[1]).toEqual(['--help'])
      expect(call[2]).toEqual(PROBE_OPTIONS)
    }
  })

  it('excludes a parent-of-package candidate (no probe even when it exists)', async () => {
    // RELEASE_UP resolves to itself, so it "exists" — but it sits outside
    // the canonical package root and must be ignored entirely.
    existing.add(RELEASE_UP)
    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileAsync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('excludes a candidate whose symlink resolves outside the package root (no probe)', async () => {
    existing.add(DEBUG)
    // The candidate "exists" but its canonical path is outside the root.
    mockRealpathSync.mockImplementation((p: string) => {
      if (p === ROOT) return ROOT
      if (p === DEBUG) return OUTSIDE
      if (existing.has(p)) return p
      throw enoent()
    })

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      DEBUG,
      expect.anything(),
      expect.anything(),
    )
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns null and probes nothing when the root manifest is missing', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw enoent()
    })
    for (const p of [SIBLING, DEBUG, BIN]) existing.add(p)

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileAsync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns null and probes nothing when the root manifest has the wrong package name', async () => {
    manifestJson = JSON.stringify({ name: 'not-diffing', version: '9.9.9' })
    for (const p of [SIBLING, DEBUG, BIN]) existing.add(p)

    const { findFileAccessTuiBinary } = await import('../lib/find-tui-binary.js')
    await expect(findFileAccessTuiBinary(CALLER_DIST_URL)).resolves.toBeNull()
    expect(mockExecFileAsync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})
