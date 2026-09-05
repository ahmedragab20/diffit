// @vitest-environment node
// Unit tests for src/lib/native-fs.ts (NativeRepositoryFs).
// The helper binary is never executed: node:child_process.spawn is mocked with
// fake EventEmitter children wired to PassThrough stdin/stdout/stderr streams.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { NativeRepositoryFs, NativeFsError, MAX_NATIVE_FILE_BYTES } from '../lib/native-fs.js'

const harness = vi.hoisted(() => ({
  spawnImpl: undefined as ((...args: unknown[]) => unknown) | undefined,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      if (!harness.spawnImpl) throw new Error('unexpected spawn in test: ' + String(args[0]))
      return harness.spawnImpl(...args)
    },
  }
})

const ROOT = '/repo/root'
const BINARY = '/fake/native-helper'
const READY_FRAME = {
  protocol: 1,
  type: 'ready',
  maxFileBytes: 52_428_800,
  maxFrameBytes: 73_400_320,
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  emitReady: () => void
  reply: (frame: unknown) => void
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  child.unref = vi.fn()
  child.emitReady = () => child.reply(READY_FRAME)
  child.reply = (frame: unknown) => {
    child.stdout.write(JSON.stringify(frame) + '\n')
  }
  return child
}

/** Collects newline-delimited JSON frames written by the client on child stdin. */
function captureStdinLines(child: FakeChild): Array<Record<string, unknown>> {
  let buf = ''
  const lines: Array<Record<string, unknown>> = []
  child.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim().length > 0) lines.push(JSON.parse(line))
    }
  })
  return lines
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => process.nextTick(() => process.nextTick(resolve)))
}

function okReply(id: unknown, result: Record<string, unknown>) {
  return { protocol: 1, id, ok: true, result }
}
function errReply(id: unknown, code: string, message = code) {
  return { protocol: 1, id, ok: false, error: { code, message } }
}

describe('NativeRepositoryFs', () => {
  // Pre-created before each test so stdin capture and frame emission work
  // regardless of when the client actually spawns. The first spawn returns
  // it; any further spawn is a respawn failure under test.
  let child: FakeChild
  let spawnCalls: Array<{ args: unknown[] }>

  beforeEach(() => {
    child = makeFakeChild()
    spawnCalls = []
    let spawnCount = 0
    harness.spawnImpl = (...args: unknown[]) => {
      spawnCalls.push({ args })
      spawnCount += 1
      if (spawnCount > 1) throw new Error('unexpected extra spawn')
      return child
    }
  })

  afterEach(() => {
    harness.spawnImpl = undefined
    // Tear down the fake child so failed assertions never leave open
    // streams or pending timers behind.
    try {
      child.emit('close')
    } catch {
      /* already closed */
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        stream.destroy()
      } catch {
        /* already destroyed */
      }
    }
    vi.useRealTimers()
  })

  describe('exports and constants', () => {
    it('exposes MAX_NATIVE_FILE_BYTES = 50MiB', () => {
      expect(MAX_NATIVE_FILE_BYTES).toBe(52_428_800)
    })

    it('NativeFsError carries code, status and outcomeUnknown', () => {
      const err = new NativeFsError('unavailable', true)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('unavailable')
      expect(err.outcomeUnknown).toBe(true)
      expect(typeof err.status).toBe('number')
    })
  })

  describe('read', () => {
    it('decodes binary content intact and returns matching sha256', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f, 0x0a, 0x00, 0x42])
      const sha = createHash('sha256').update(bytes).digest('hex')
      const lines = captureStdinLines(child)
      const pending = client.read('assets/blob.bin').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const op = lines[0] as { id: number; op: { kind: string; path: string } }
      expect(op.op.kind).toBe('read')
      expect(op.op.path).toBe('assets/blob.bin')
      child.reply(okReply(op.id, { contentBase64: bytes.toString('base64'), sha256: sha, size: bytes.length }))
      const result = (await pending) as { bytes: Buffer; sha256: string }
      expect(result.bytes).toBeInstanceOf(Buffer)
      expect(result.bytes.equals(bytes)).toBe(true)
      expect(result.sha256).toBe(sha)
      client.close()
    })

    it('reuses one child for two sequential requests', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const first = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id1 = (lines[0] as { id: number }).id
      child.reply(okReply(id1, { contentBase64: Buffer.from('one').toString('base64'), sha256: createHash('sha256').update('one').digest('hex'), size: 3 }))
      await first
      const second = client.read('b.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      expect(lines.length).toBe(2)
      const id2 = (lines[1] as { id: number }).id
      child.reply(okReply(id2, { contentBase64: Buffer.from('two').toString('base64'), sha256: createHash('sha256').update('two').digest('hex'), size: 3 }))
      await second
      expect(spawnCalls.length).toBe(1)
      client.close()
    })

    it('replies split across multiple chunks are reassembled', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id = (lines[0] as { id: number }).id
      const bytes = Buffer.from('chunked payload')
      const frame = JSON.stringify(okReply(id, { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })) + '\n'
      const mid = Math.floor(frame.length / 2)
      child.stdout.write(frame.slice(0, mid))
      child.stdout.write(frame.slice(mid))
      const result = (await pending) as { bytes: Buffer }
      expect(result.bytes.toString('utf8')).toBe('chunked payload')
      client.close()
    })

    it('two replies coalesced into one chunk are both delivered', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const first = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id1 = (lines[0] as { id: number }).id
      const second = client.read('b.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      const id2 = (lines[1] as { id: number }).id
      const b1 = Buffer.from('alpha')
      const b2 = Buffer.from('beta')
      const combined =
        JSON.stringify(okReply(id1, { contentBase64: b1.toString('base64'), sha256: createHash('sha256').update(b1).digest('hex'), size: b1.length })) +
        '\n' +
        JSON.stringify(okReply(id2, { contentBase64: b2.toString('base64'), sha256: createHash('sha256').update(b2).digest('hex'), size: b2.length })) +
        '\n'
      child.stdout.write(combined)
      const r1 = (await first) as { bytes: Buffer }
      const r2 = (await second) as { bytes: Buffer }
      expect(r1.bytes.toString('utf8')).toBe('alpha')
      expect(r2.bytes.toString('utf8')).toBe('beta')
      client.close()
    })

    it('passes literal %2f paths through unchanged', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('weird%2fname.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      expect((lines[0] as { op: { path: string } }).op.path).toBe('weird%2fname.txt')
      const id = (lines[0] as { id: number }).id
      const bytes = Buffer.from('x')
      child.reply(okReply(id, { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), size: 1 }))
      await pending
      client.close()
    })

    it('passes literal backslash paths through unchanged on Unix', async () => {
      if (process.platform === 'win32') return
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a\\b.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      expect((lines[0] as { op: { path: string } }).op.path).toBe('a\\b.txt')
      const id = (lines[0] as { id: number }).id
      const bytes = Buffer.from('y')
      child.reply(okReply(id, { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), size: 1 }))
      await pending
      client.close()
    })

    it('rejects traversal and empty paths before spawning', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      for (const bad of ['', '..', '../escape', 'a/../../escape', './x/../../escape']) {
        await expect(client.read(bad)).rejects.toBeInstanceOf(NativeFsError)
      }
      expect(spawnCalls.length).toBe(0)
      client.close()
    })
  })

  describe('write', () => {
    it('encodes content as base64 and forwards options', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const bytes = Buffer.from('file contents\nwith lines')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const pending = client.write('dir/file.txt', bytes, { createParents: true, expectedSha256: sha }).then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const frame = lines[0] as {
        id: number
        op: { kind: string; path: string; contentBase64?: string; createParents?: boolean; expectedSha256?: string }
      }
      expect(frame.op.kind).toBe('write')
      expect(frame.op.path).toBe('dir/file.txt')
      expect(frame.op.contentBase64).toBe(bytes.toString('base64'))
      expect(frame.op.createParents).toBe(true)
      expect(frame.op.expectedSha256).toBe(sha)
      child.reply(okReply(frame.id, { sha256: sha, size: bytes.length }))
      const result = (await pending) as { sha256: string; size: number }
      expect(result.sha256).toBe(sha)
      expect(result.size).toBe(bytes.length)
      client.close()
    })

    it('without options the op carries no createParents/expectedSha256', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const bytes = Buffer.from('plain')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const pending = client.write('file.txt', bytes).then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const op = (lines[0] as { op: Record<string, unknown> }).op
      expect(op.createParents).toBe(false)
      expect(op.expectedSha256).toBeUndefined()
      const id = (lines[0] as { id: number }).id
      child.reply(okReply(id, { sha256: sha, size: bytes.length }))
      await pending
      client.close()
    })

    it('snapshots the caller buffer before awaiting startup', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const bytes = Buffer.from('original bytes')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const pending = client.write('file.txt', bytes).then(
        (r) => r,
        (e) => e,
      )
      // Mutate the caller's buffer before the helper is even ready: the
      // request must reflect the original snapshot, not the mutated bytes.
      bytes.fill('MUTATEDMUTATED')
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const frame = lines[0] as { id: number; op: { contentBase64?: string } }
      expect(frame.op.contentBase64).toBe(Buffer.from('original bytes').toString('base64'))
      const id = frame.id
      child.reply(okReply(id, { sha256: sha, size: 14 }))
      await pending
      client.close()
    })

    it('rejects traversal and empty paths before spawning', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      for (const bad of ['', '../escape', 'sub/../../escape']) {
        await expect(client.write(bad, Buffer.from('x'))).rejects.toBeInstanceOf(NativeFsError)
      }
      expect(spawnCalls.length).toBe(0)
      client.close()
    })
  })

  describe('unavailable (binary: null)', () => {
    it('reports unavailable and fails operations with 503 without spawning', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: null })
      expect(await client.available()).toBe(false)
      const readErr = await client.read('a.txt').then(
        () => null,
        (e) => e,
      )
      expect(readErr).toBeInstanceOf(NativeFsError)
      expect((readErr as NativeFsError).status).toBe(503)
      const writeErr = await client.write('a.txt', Buffer.from('x')).then(
        () => null,
        (e) => e,
      )
      expect(writeErr).toBeInstanceOf(NativeFsError)
      expect((writeErr as NativeFsError).status).toBe(503)
      expect(spawnCalls.length).toBe(0)
      client.close()
    })
  })

  describe('error handling', () => {
    it('rejects with a protocol error when the read sha256 does not match content', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id = (lines[0] as { id: number }).id
      const bytes = Buffer.from('tampered')
      child.reply(okReply(id, { contentBase64: bytes.toString('base64'), sha256: '0'.repeat(64), size: bytes.length }))
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.code).toBe('protocol')
      expect(err.status).toBe(502)
      client.close()
    })

    it('rejects with a protocol error when the write result size is wrong', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const bytes = Buffer.from('five5')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const pending = client.write('file.txt', bytes).then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id = (lines[0] as { id: number }).id
      child.reply(okReply(id, { sha256: sha, size: bytes.length + 1 }))
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.code).toBe('protocol')
      expect(err.status).toBe(502)
      // The helper may or may not have persisted the write before the bad
      // result was detected, so the outcome is unknown.
      expect(err.outcomeUnknown).toBe(true)
      client.close()
    })

    it('rejects with a protocol error when contentBase64 is not valid base64', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id = (lines[0] as { id: number }).id
      child.reply(okReply(id, { contentBase64: 'not!!valid@@base64###', sha256: '0'.repeat(64), size: 10 }))
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.code).toBe('protocol')
      expect(err.status).toBe(502)
      client.close()
    })

    it('maps a native denial to status 403 and later requests still work on the same child', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const first = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      const id1 = (lines[0] as { id: number }).id
      child.reply(errReply(id1, 'denied', 'permission denied'))
      const err = (await first) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.status).toBe(403)

      // A valid follow-up request on the same child still succeeds.
      const second = client.read('b.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      const id2 = (lines[1] as { id: number }).id
      const bytes = Buffer.from('recovered')
      child.reply(okReply(id2, { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }))
      const result = (await second) as { bytes: Buffer }
      expect(result.bytes.equals(bytes)).toBe(true)
      expect(spawnCalls.length).toBe(1)
      client.close()
    })

    it('fails with a protocol error on an unknown reply id and does not respawn', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      child.reply(okReply(999999, { contentBase64: Buffer.from('x').toString('base64'), sha256: '0'.repeat(64), size: 1 }))
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.code).toBe('protocol')
      expect(err.status).toBe(502)

      // No automatic respawn: a retry fails again with a protocol error
      // against the same child.
      const retry = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      expect(spawnCalls.length).toBe(1)
      client.close()
      const retryErr = (await retry) as NativeFsError
      expect(retryErr).toBeInstanceOf(NativeFsError)
      expect(retryErr.code).toBe('protocol')
    })
  })

  describe('close and lifecycle', () => {
    it('rejects a pending read when closed', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      client.close()
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
    })

    it('rejects a pending write with outcomeUnknown=true when closed', async () => {
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY })
      const lines = captureStdinLines(child)
      const pending = client.write('file.txt', Buffer.from('pending')).then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      client.close()
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      expect(err.outcomeUnknown).toBe(true)
    })

    it('times out a request with no reply (fake timers, rejection handled before advancing)', async () => {
      // Fake only the timers the client uses so process.nextTick flushing
      // still works while the timeout clock is under our control.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const client = new NativeRepositoryFs(ROOT, { binary: BINARY, timeoutMs: 1_000 })
      const lines = captureStdinLines(child)
      // Attach the rejection handler synchronously before advancing timers.
      const pending = client.read('a.txt').then(
        (r) => r,
        (e) => e,
      )
      await flushAsync()
      child.emitReady()
      await flushAsync()
      expect(lines.length).toBe(1)
      await vi.advanceTimersByTimeAsync(2_000)
      const err = (await pending) as NativeFsError
      expect(err).toBeInstanceOf(NativeFsError)
      client.close()
    })
  })
})
