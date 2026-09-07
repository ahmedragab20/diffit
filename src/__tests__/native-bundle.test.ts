// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
const targets = [
  ['tui-darwin-arm64', 'diffing-tui'],
  ['tui-darwin-x64', 'diffing-tui'],
  ['tui-linux-arm64-gnu', 'diffing-tui'],
  ['tui-linux-arm64-musl', 'diffing-tui'],
  ['tui-linux-x64-gnu', 'diffing-tui'],
  ['tui-linux-x64-musl', 'diffing-tui'],
  ['tui-win32-x64-msvc', 'diffing-tui.exe'],
] as const

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('native TUI bundle', () => {
  it('keeps the native binary version locked to the root package', () => {
    const cargoManifest = readFileSync(resolve(repoRoot, 'Cargo.toml'), 'utf8')
    const cargoVersion = cargoManifest.match(
      /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
    )?.[1]

    expect(cargoVersion).toBe(rootPackage.version)
  })

  it('ships native binaries only through the root package', () => {
    expect(rootPackage.files).toContain('dist')
    expect(rootPackage.optionalDependencies).toBeUndefined()
    expect(rootPackage.publishConfig?.executableFiles).toEqual(
      expect.arrayContaining(
        targets.map(([slug, name]) => `dist/native/${slug}/${name}`),
      ),
    )
  })

  it('stages a release binary in its target-specific bundle directory', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'diffing-tui-bundle-'))
    temporaryDirectories.push(temporaryDirectory)
    const binary = resolve(temporaryDirectory, 'input-binary')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    execFileSync('node', [
      'scripts/stage-tui-binary.mjs',
      '--target',
      'tui-darwin-arm64',
      '--binary',
      binary,
      '--output-root',
      temporaryDirectory,
    ], { cwd: repoRoot })

    const stagedBinary = resolve(temporaryDirectory, 'tui-darwin-arm64', 'diffing-tui')
    expect(readFileSync(stagedBinary, 'utf8')).toContain('exit 0')
    expect(statSync(stagedBinary).mode & 0o111).not.toBe(0)
  })

  it('verifies a complete seven-target release bundle', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'diffing-tui-release-'))
    temporaryDirectories.push(temporaryDirectory)

    for (const [slug, binaryName] of targets) {
      const directory = resolve(temporaryDirectory, slug)
      mkdirSync(directory, { recursive: true })
      writeFileSync(resolve(directory, binaryName), 'native-binary', { mode: 0o755 })
    }

    const output = execFileSync(
      'node',
      ['scripts/verify-tui-bundle.mjs', temporaryDirectory],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(output).toContain('verified 7 native TUI binaries')
  })

  it('packs native binaries with executable modes in the tarball', () => {
    expect(
      process.env.npm_execpath,
      'npm_execpath is missing; run the suite through pnpm (e.g. pnpm test)',
    ).toBeTruthy()

    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'diffing-pack-fixture-'))
    temporaryDirectories.push(temporaryDirectory)

    writeFileSync(
      resolve(temporaryDirectory, 'package.json'),
      JSON.stringify(
        {
          name: 'diffing-pack-fixture',
          version: '0.0.0',
          files: ['dist'],
          publishConfig: rootPackage.publishConfig,
        },
        null,
        2,
      ),
    )

    for (const [slug, binaryName] of targets) {
      const directory = resolve(temporaryDirectory, 'dist', 'native', slug)
      mkdirSync(directory, { recursive: true })
      writeFileSync(resolve(directory, binaryName), 'fixture', { mode: 0o755 })
    }

    execFileSync(
      process.execPath,
      [process.env.npm_execpath!, 'pack', '--pack-destination', temporaryDirectory],
      { cwd: temporaryDirectory, stdio: 'pipe' },
    )

    const tarball = gunzipSync(
      readFileSync(resolve(temporaryDirectory, 'diffing-pack-fixture-0.0.0.tgz')),
    )

    const memberModes = new Map<string, number>()
    let offset = 0
    while (offset + 512 <= tarball.length) {
      const name = tarball.subarray(offset, offset + 100).toString('utf8').split('\0')[0]
      if (name.length === 0) break
      const prefix = tarball.subarray(offset + 345, offset + 500).toString('utf8').split('\0')[0]
      const mode = Number.parseInt(
        tarball.subarray(offset + 100, offset + 108).toString('utf8').split('\0')[0].trim(),
        8,
      )
      const size = Number.parseInt(
        tarball.subarray(offset + 124, offset + 136).toString('utf8').split('\0')[0].trim(),
        8,
      )
      const typeflag = tarball[offset + 156]
      if (typeflag === 0 || typeflag === 0x30) {
        memberModes.set(prefix ? `${prefix}/${name}` : name, mode)
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }

    for (const [slug, binaryName] of targets) {
      const member = `package/dist/native/${slug}/${binaryName}`
      const mode = memberModes.get(member)
      expect(mode, `archive member ${member} is present in the packed tarball`).toBeDefined()
      expect(
        mode! & 0o111,
        `archive member ${member} keeps executable bits in the packed tarball`,
      ).not.toBe(0)
    }
  })
})
