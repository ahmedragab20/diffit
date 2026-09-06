// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { FileDiffMetadata } from '@pierre/diffs'
import { useViewportActiveFileTracking } from '../useViewportActiveFile'

const files: FileDiffMetadata[] = [
  { name: 'a.ts' } as FileDiffMetadata,
  { name: 'b.ts' } as FileDiffMetadata,
  { name: 'c.ts' } as FileDiffMetadata,
]

/** Override jsdom's zero-rect with a synthetic top/bottom so visibility is measurable. */
function mockRect(id: string, top: number, bottom: number) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element ${id}`)
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom, height: bottom - top }),
  })
}

/** Flush a requestAnimationFrame inside act so hook-driven state updates land. */
async function flushRaf() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function Harness({
  suppressRef,
  onChange,
}: {
  suppressRef: { current: number }
  onChange?: (path: string) => void
}) {
  const [active, setActive] = useState<string | null>(null)
  useViewportActiveFileTracking(files, active, (path) => {
    onChange?.(path)
    setActive(path)
  }, suppressRef)
  return <span data-testid="active">{active ?? 'none'}</span>
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useViewportActiveFileTracking', () => {
  it('activates the card with the largest visible height in the viewport', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const suppressRef = { current: 0 }
    render(<Harness suppressRef={suppressRef} />)

    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('b.ts')
  })

  it('re-activates on scroll when a different card becomes the largest', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const suppressRef = { current: 0 }
    render(<Harness suppressRef={suppressRef} />)
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('b.ts')

    act(() => {
      mockRect('file-a.ts', 0, 900)
      window.dispatchEvent(new Event('scroll'))
    })
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('a.ts')
  })

  it('does not fire redundant activation for the already-active file', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const onChange = vi.fn()
    const suppressRef = { current: 0 }
    render(<Harness suppressRef={suppressRef} onChange={onChange} />)
    await flushRaf()
    expect(onChange).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    await flushRaf()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('activates the card under the mouse immediately and keeps it (hover wins over viewport)', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const suppressRef = { current: 0 }
    const onChange = vi.fn()
    render(<Harness suppressRef={suppressRef} onChange={onChange} />)
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('b.ts')

    // Hover the smallest card — mouse intent wins over viewport size, and the
    // hover selection survives the re-render/effect re-run that it triggers.
    const child = document.createElement('span')
    document.getElementById('file-c.ts')!.appendChild(child)
    act(() => {
      child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('c.ts')
    expect(screen.getByTestId('active').textContent).toBe('c.ts')

    // The viewport detector only takes over after the mouse shield expires.
    act(() => {
      suppressRef.current = 0
      window.dispatchEvent(new Event('scroll'))
    })
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('c.ts')
  })

  it('does not change active file or steal textarea focus while typing', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const suppressRef = { current: 0 }
    render(<Harness suppressRef={suppressRef} />)
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('b.ts')

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    const child = document.createElement('span')
    document.getElementById('file-c.ts')!.appendChild(child)
    act(() => {
      mockRect('file-a.ts', 0, 900)
      window.dispatchEvent(new Event('scroll'))
      child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await flushRaf()

    expect(screen.getByTestId('active').textContent).toBe('b.ts')
    expect(document.activeElement).toBe(textarea)
  })

  it('ignores scroll-derived detection during the explicit-selection suppression window', async () => {
    document.body.innerHTML = '<div id="file-a.ts"></div><div id="file-b.ts"></div><div id="file-c.ts"></div>'
    mockRect('file-a.ts', 0, 100)
    mockRect('file-b.ts', 50, 550)
    mockRect('file-c.ts', 2000, 2100)

    const suppressRef = { current: Date.now() }
    render(<Harness suppressRef={suppressRef} />)
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('none')

    // Hover still works during the window (mouse is explicit intent).
    const child = document.createElement('span')
    document.getElementById('file-a.ts')!.appendChild(child)
    act(() => {
      child.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(screen.getByTestId('active').textContent).toBe('a.ts')

    // Window expires → viewport detection resumes (let the mouse shield and
    // the explicit-selection window both lapse first).
    await new Promise((resolve) => setTimeout(resolve, 300))
    act(() => {
      suppressRef.current = 0
      window.dispatchEvent(new Event('scroll'))
    })
    await flushRaf()
    expect(screen.getByTestId('active').textContent).toBe('b.ts')
  })
})
