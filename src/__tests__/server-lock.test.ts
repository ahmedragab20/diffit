// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockGetProjectStorageDir = vi.fn()
const mockGetRepoRoot = vi.fn()

vi.mock('../lib/git.js', () => ({
  getProjectStorageDir: (...args: any[]) => mockGetProjectStorageDir(...args),
  getRepoRoot: () => mockGetRepoRoot(),
}))

const mockProbeLockServerSync = vi.fn((..._args: any[]) => true)

vi.mock('../lib/lock-probe.js', () => ({
  probeLockServerSync: (...args: any[]) => mockProbeLockServerSync(...args),
}))

let storageDir: string

async function loadModule() {
  return import('../lib/server-lock.js')
}

function makeLock(overrides: Partial<import('../lib/server-lock.js').ServerLock> = {}) {
  return {
    port: 3433,
    host: '127.0.0.1',
    pid: process.pid,
    repoRoot: '/tmp/test-repo',
    startedAt: 1000,
    version: '0.0.0',
    ...overrides,
  }
}

describe('server-lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProbeLockServerSync.mockReturnValue(true)
    storageDir = mkdtempSync(join(tmpdir(), 'diffing-lock-'))
    mockGetProjectStorageDir.mockReturnValue(storageDir)
    mockGetRepoRoot.mockReturnValue('/tmp/test-repo')
  })

  afterEach(() => {
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('round-trips a lock through write/read', async () => {
    const { writeServerLock, readServerLock } = await loadModule()
    writeServerLock(makeLock({ port: 5050 }))
    const read = readServerLock()
    expect(read).toMatchObject({
      port: 5050,
      pid: process.pid,
      repoRoot: '/tmp/test-repo',
      sessionId: `web-${process.pid}-1000`,
    })
  })

  it('normalizes legacy launch-only fields when comparing diff scopes', async () => {
    const { sameDiffScope } = await loadModule()
    expect(sameDiffScope(
      JSON.stringify({ staged: false, skipSetup: true, viewOnly: false }),
      JSON.stringify({ staged: false }),
    )).toBe(true)
    expect(sameDiffScope(
      JSON.stringify({ staged: true, skipSetup: true }),
      JSON.stringify({ staged: false }),
    )).toBe(false)
  })

  it('returns null when no lock exists', async () => {
    const { readServerLock } = await loadModule()
    expect(readServerLock()).toBeNull()
  })

  it('treats a live process in the same repo as alive', async () => {
    const { isLockAlive } = await loadModule()
    expect(isLockAlive(makeLock({ pid: process.pid }))).toBe(true)
  })

  it('treats a dead pid as not alive even when probe would succeed', async () => {
    const { isLockAlive } = await loadModule()
    mockProbeLockServerSync.mockReturnValue(true)
    // 2^31-1 is effectively never a live pid.
    expect(isLockAlive(makeLock({ pid: 2147483646 }))).toBe(false)
  })

  it('treats a live pid without a diffing server as not alive', async () => {
    const { isLockAlive } = await loadModule()
    mockProbeLockServerSync.mockReturnValue(false)
    expect(isLockAlive(makeLock({ pid: process.pid }))).toBe(false)
  })

  it('treats a lock from a different repo as not alive', async () => {
    const { isLockAlive } = await loadModule()
    expect(isLockAlive(makeLock({ pid: process.pid, repoRoot: '/somewhere/else' }))).toBe(false)
  })

  it('removes the lock file', async () => {
    const { writeServerLock, removeServerLock, readServerLock } = await loadModule()
    writeServerLock(makeLock())
    expect(existsSync(join(storageDir, 'server.json'))).toBe(true)
    removeServerLock()
    expect(readServerLock()).toBeNull()
  })

  it('serializes startup leases and permits acquisition after release', async () => {
    const { acquireServerStartupLease } = await loadModule()
    const first = acquireServerStartupLease('/tmp/test-repo', 'owner-1', 1_000)
    expect(first).not.toBeNull()
    expect(acquireServerStartupLease('/tmp/test-repo', 'owner-2', 1_001)).toBeNull()

    first!.release()
    const second = acquireServerStartupLease('/tmp/test-repo', 'owner-2', 1_002)
    expect(second).not.toBeNull()
    second!.release()
  })

  it('does not steal an old lease from a still-live owner process', async () => {
    const { acquireServerStartupLease } = await loadModule()
    const first = acquireServerStartupLease('/tmp/test-repo', 'live-owner', 1_000)
    expect(first).not.toBeNull()
    expect(acquireServerStartupLease('/tmp/test-repo', 'other-owner', 61_000)).toBeNull()
    first!.release()
  })

  it('recovers a startup lease immediately after its owner process dies', async () => {
    const { acquireServerStartupLease } = await loadModule()
    const leaseDir = join(storageDir, 'server-startup.lock')
    mkdirSync(leaseDir)
    writeFileSync(join(leaseDir, 'lease.json'), JSON.stringify({
      ownerId: 'dead-owner', createdAt: 1_000, pid: 2147483646,
    }))
    writeFileSync(join(leaseDir, 'owner-dead-owner'), '')

    const replacement = acquireServerStartupLease('/tmp/test-repo', 'new-owner', 1_001)
    expect(replacement).not.toBeNull()
    expect(acquireServerStartupLease('/tmp/test-repo', 'third-owner', 1_002)).toBeNull()

    replacement!.release()
    expect(acquireServerStartupLease('/tmp/test-repo', 'third-owner', 1_003)).not.toBeNull()
  })

  it('repairs an orphaned startup lease without acquiring a replacement', async () => {
    const { recoverOrphanedServerStartupLease } = await loadModule()
    const leaseDir = join(storageDir, 'server-startup.lock')
    mkdirSync(leaseDir)
    writeFileSync(join(leaseDir, 'lease.json'), JSON.stringify({
      ownerId: 'dead-owner', createdAt: 1_000, pid: 2147483646,
    }))

    expect(recoverOrphanedServerStartupLease('/tmp/test-repo', 1_001)).toBe(true)
    expect(existsSync(leaseDir)).toBe(false)
    expect(recoverOrphanedServerStartupLease('/tmp/test-repo', 1_002)).toBe(false)
  })

  it('recovers an empty startup lease directory after it becomes stale', async () => {
    const { acquireServerStartupLease } = await loadModule()
    const leaseDir = join(storageDir, 'server-startup.lock')
    mkdirSync(leaseDir)
    utimesSync(leaseDir, 0, 0)

    const lease = acquireServerStartupLease('/tmp/test-repo', 'replacement', 31_001)
    expect(lease).not.toBeNull()
    lease!.release()
  })

  it('removes a server lock only for the exact pid and owner identity', async () => {
    const { writeServerLock, readServerLock, removeServerLockIfOwned } = await loadModule()
    writeServerLock(makeLock({ ownerId: 'session-a' }))

    expect(removeServerLockIfOwned('/tmp/test-repo', process.pid, 'session-b')).toBe(false)
    expect(readServerLock()).not.toBeNull()
    expect(removeServerLockIfOwned('/tmp/test-repo', process.pid, 'session-a')).toBe(true)
    expect(readServerLock()).toBeNull()
  })

  it('removes an owned lock even when the liveness probe fails (self-shutdown)', async () => {
    const { writeServerLock, readServerLock, removeServerLockIfOwned } = await loadModule()
    mockProbeLockServerSync.mockReturnValue(false)
    writeServerLock(makeLock({ ownerId: 'session-a' }))

    expect(removeServerLockIfOwned('/tmp/test-repo', process.pid, 'session-a')).toBe(true)
    expect(readServerLock()).toBeNull()
  })

  it('keeps concurrent sessions and elects a fallback when the active one exits', async () => {
    const {
      writeServerLock,
      readServerLock,
      listServerLocks,
      removeServerSession,
    } = await loadModule()
    const first = makeLock({ sessionId: 'first', startedAt: 1_000, mode: 'web' })
    const second = makeLock({ sessionId: 'second', startedAt: 2_000, mode: 'tui', port: 5051 })

    writeServerLock(first)
    writeServerLock(second)

    expect(listServerLocks().map((lock) => lock.sessionId)).toEqual(['second', 'first'])
    expect(readServerLock()?.sessionId).toBe('second')

    removeServerSession(second)
    expect(readServerLock()?.sessionId).toBe('first')
    expect(listServerLocks().map((lock) => lock.sessionId)).toEqual(['first'])
  })

  it('prunes dead session records without hiding a live session', async () => {
    const { writeServerLock, listServerLocks, sessionsPath } = await loadModule()
    writeServerLock(makeLock({ sessionId: 'live' }))
    const deadPath = join(sessionsPath(), 'dead.json')
    writeFileSync(deadPath, JSON.stringify(makeLock({
      sessionId: 'dead',
      pid: 2147483646,
      startedAt: 2_000,
    })))

    expect(listServerLocks().map((lock) => lock.sessionId)).toEqual(['live'])
    expect(existsSync(deadPath)).toBe(false)
  })

  it('preserves a live session record across a transient probe failure', async () => {
    const {
      writeServerLock,
      listServerLocks,
      listRegisteredServerLocks,
      readServerLock,
      resolveActiveServerLock,
      sessionsPath,
    } = await loadModule()
    const live = makeLock({ sessionId: 'temporarily-unresponsive' })
    writeServerLock(live)
    const recordPath = join(sessionsPath(), 'temporarily-unresponsive.json')

    mockProbeLockServerSync.mockReturnValue(false)
    expect(listServerLocks()).toEqual([])
    expect(listRegisteredServerLocks().map((lock) => lock.sessionId)).toEqual([
      'temporarily-unresponsive',
    ])
    expect(existsSync(recordPath)).toBe(true)
    expect(resolveActiveServerLock()).toBeNull()
    expect(readServerLock()?.sessionId).toBe('temporarily-unresponsive')
  })
})
