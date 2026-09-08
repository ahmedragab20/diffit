import { describe, expect, it } from 'vitest'
import type { EditMarker } from '../editMarkers'
import { mergeMarkers, MAX_MARKERS } from '../mergeMarkers'

function marker(overrides: Partial<EditMarker> = {}): EditMarker {
  return {
    severity: 'error',
    message: 'boom',
    source: 'lsp',
    start: { line: 1, character: 0 },
    end: { line: 1, character: 4 },
    ...overrides,
  }
}

describe('mergeMarkers', () => {
  it('returns the built-in markers when the server has none', () => {
    const result = mergeMarkers([marker()], [])
    expect(result).toHaveLength(1)
    expect(result).toEqual([marker()])
  })

  it('returns the server markers when there are no built-in ones', () => {
    const result = mergeMarkers([], [marker({ source: 'ts' })])
    expect(result).toHaveLength(1)
  })

  it('drops an exact duplicate', () => {
    const m = marker()
    const result = mergeMarkers([m], [m])
    expect(result).toHaveLength(1)
  })

  it('keeps two markers that differ only in message', () => {
    const result = mergeMarkers(
      [marker({ message: 'a' })],
      [marker({ message: 'b' })]
    )
    expect(result).toHaveLength(2)
  })

  it('keeps two markers that differ only in source', () => {
    const result = mergeMarkers(
      [marker({ source: 'diffing' })],
      [marker({ source: 'ts' })]
    )
    expect(result).toHaveLength(2)
  })

  it('orders errors before warnings before hints', () => {
    const result = mergeMarkers(
      [],
      [
        marker({ severity: 'hint', message: 'hint msg' }),
        marker({ severity: 'warning', message: 'warning msg' }),
        marker({ severity: 'error', message: 'error msg' }),
      ]
    )
    expect(result).toHaveLength(3)
    expect(result.map((m) => m.severity)).toEqual(['error', 'warning', 'hint'])
  })

  it('orders same-severity markers by position', () => {
    const result = mergeMarkers(
      [],
      [
        marker({ severity: 'error', message: 'line 5', start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }),
        marker({ severity: 'error', message: 'line 1', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }),
        marker({ severity: 'error', message: 'line 3', start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }),
      ]
    )
    expect(result).toHaveLength(3)
    expect(result.map((m) => m.start.line)).toEqual([1, 3, 5])
  })

  it('caps the list', () => {
    const serverMarkers: EditMarker[] = []
    for (let i = 0; i < MAX_MARKERS + 50; i++) {
      serverMarkers.push(
        marker({
          message: `msg ${i}`,
          start: { line: i, character: 0 },
          end: { line: i, character: 1 },
        })
      )
    }
    const result = mergeMarkers([], serverMarkers)
    expect(result).toHaveLength(MAX_MARKERS)
  })

  it('keeps errors when the list is capped', () => {
    const serverMarkers: EditMarker[] = []
    for (let i = 0; i < MAX_MARKERS; i++) {
      serverMarkers.push(
        marker({
          severity: 'warning',
          message: `msg ${i}`,
          start: { line: i, character: 0 },
          end: { line: i, character: 1 },
        })
      )
    }
    const result = mergeMarkers(
      [marker({ severity: 'error' })],
      serverMarkers
    )
    expect(result).toHaveLength(MAX_MARKERS)
    expect(result[0]?.severity).toBe('error')
  })

  it('does not mutate its inputs', () => {
    const builtIn = [marker()]
    const fromServer = [marker({ source: 'ts' })]
    const builtInLength = builtIn.length
    const fromServerLength = fromServer.length
    mergeMarkers(builtIn, fromServer)
    expect(builtIn).toHaveLength(builtInLength)
    expect(fromServer).toHaveLength(fromServerLength)
  })
})
