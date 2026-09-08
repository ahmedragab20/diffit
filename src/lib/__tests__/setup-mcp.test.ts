// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mergeDiffingMcpConfig,
  readMcpConfig,
  writeMcpConfig,
  backupMcpConfig,
  buildDiffingMcpEntry,
  formatMcpSnippet,
} from '../setup-mcp.js'

describe('setup-mcp merge', () => {
  it('merges only diffing server and preserves other servers', () => {
    const existing = {
      mcpServers: {
        other: { command: 'other-cmd', args: ['x'] },
        diffing: { command: 'old', args: ['mcp'] },
      },
      extra: true,
    }
    const entry = buildDiffingMcpEntry('/abs/repo')
    const merged = mergeDiffingMcpConfig(existing, entry)
    expect((merged as Record<string, unknown>).extra).toBe(true)
    expect(merged.mcpServers?.other).toEqual({ command: 'other-cmd', args: ['x'] })
    expect(merged.mcpServers?.diffing).toEqual({
      command: 'diffing',
      args: ['mcp', '--repo', '/abs/repo'],
    })
  })

  it('is idempotent when writing the same entry twice', () => {
    const entry = buildDiffingMcpEntry()
    const once = mergeDiffingMcpConfig({}, entry)
    const twice = mergeDiffingMcpConfig(once, entry)
    expect(twice).toEqual(once)
  })

  it('formats paste-ready MCP JSON', () => {
    const snippet = formatMcpSnippet(buildDiffingMcpEntry())
    expect(snippet).toContain('"diffing"')
    expect(JSON.parse(snippet).mcpServers.diffing.command).toBe('diffing')
  })
})

describe('setup-mcp backup and write', () => {
  let dir: string
  let backups: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diffing-mcp-'))
    backups = join(dir, 'backups')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('backs up an existing config before overwrite', () => {
    const configPath = join(dir, 'mcp.json')
    writeFileSync(configPath, '{"mcpServers":{"keep":{"command":"x"}}}\n', 'utf-8')
    const backupPath = backupMcpConfig(configPath, backups)
    expect(backupPath).toBeTruthy()
    expect(existsSync(backupPath!)).toBe(true)
    expect(readFileSync(backupPath!, 'utf-8')).toContain('keep')

    const result = writeMcpConfig(
      { id: 'test', label: 'Test', path: configPath, scope: 'global' },
      buildDiffingMcpEntry(),
      { backupsRoot: backups },
    )
    expect(result.written).toBe(true)
    const updated = readMcpConfig(configPath)
    expect(updated.mcpServers?.keep).toEqual({ command: 'x' })
    expect(updated.mcpServers?.diffing?.command).toBe('diffing')
  })
})
