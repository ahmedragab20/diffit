// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useSubmitPanelSize,
  SUBMIT_PANEL_SIZE_KEY,
  SUBMIT_PANEL_WIDTH_KEY,
  SUBMIT_PANEL_MIN,
  SUBMIT_PANEL_MAX,
  SUBMIT_PANEL_MIN_WIDTH,
  SUBMIT_PANEL_MAX_WIDTH,
  SUBMIT_PANEL_PRESETS,
  RESIZE_DISMISS_GUARD_MS,
} from '../../hooks/useSubmitPanelSize'

const mockGet = vi.fn()
const mockSet = vi.fn()

vi.mock('../../utils/uiState', () => ({
  getUiStateItem: (...args: any[]) => mockGet(...args),
  setUiStateItem: (...args: any[]) => mockSet(...args),
}))

let rafCb: (() => void) | null = null
let sharedDiv: HTMLDivElement

beforeAll(() => {
  // Create element outside fake timers scope
  sharedDiv = document.createElement('div')
})

beforeEach(() => {
  mockGet.mockReset()
  mockSet.mockReset()
  rafCb = null
  vi.useFakeTimers()
  globalThis.requestAnimationFrame = vi.fn((cb: () => void) => {
    rafCb = cb
    return 1
  }) as any
  globalThis.cancelAnimationFrame = vi.fn() as any
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as any).requestAnimationFrame
  delete (globalThis as any).cancelAnimationFrame
})

describe('useSubmitPanelSize', () => {
  it('returns default 480 when no stored value', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.height).toBe(480)
  })

  it('loads stored value', () => {
    mockGet.mockReturnValue('600')
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.height).toBe(600)
  })

  it('clamps stored value above max', () => {
    mockGet.mockReturnValue('9999')
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.height).toBe(SUBMIT_PANEL_MAX)
  })

  it('clamps stored value below min', () => {
    mockGet.mockReturnValue('10')
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.height).toBe(SUBMIT_PANEL_MIN)
  })

  it('returns default for NaN stored value', () => {
    mockGet.mockReturnValue('abc')
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.height).toBe(480)
  })

  it('applyPreset updates height and persists', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    act(() => { result.current.applyPreset(SUBMIT_PANEL_PRESETS[2]!) }) // L = 560×560
    expect(result.current.height).toBe(560)
    expect(result.current.width).toBe(560)
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_SIZE_KEY, '560')
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_WIDTH_KEY, '560')
  })

  it('activePreset returns correct index', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    // Default (520,480) matches no preset
    expect(result.current.activePreset).toBe(-1)
    act(() => result.current.applyPreset(SUBMIT_PANEL_PRESETS[0]!)) // S
    expect(result.current.activePreset).toBe(0)
    act(() => result.current.applyPreset(SUBMIT_PANEL_PRESETS[1]!)) // M
    expect(result.current.activePreset).toBe(1)
    act(() => result.current.applyPreset(SUBMIT_PANEL_PRESETS[3]!)) // XL
    expect(result.current.activePreset).toBe(3)
    // Width-only match should not highlight
    act(() => result.current.applyPreset({ label:'X', width: 520, height: 500 } as any))
    expect(result.current.activePreset).toBe(-1)
  })

  it('popoverStyle contains CSS var', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const style = result.current.popoverStyle as Record<string, string>
    expect(style['--submit-panel-height']).toBe('480px')
    act(() => { result.current.applyPreset(SUBMIT_PANEL_PRESETS[0]!) })
    const style2 = result.current.popoverStyle as Record<string, string>
    expect(style2['--submit-panel-height']).toBe('340px')
    expect(style2['--submit-panel-width']).toBe('420px')
  })

  it('applyPreset clamps out-of-bounds components to within min/max', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    act(() => { result.current.applyPreset({ label:'Huge', width: 9999, height: 9999 } as any) })
    expect(result.current.width).toBe(SUBMIT_PANEL_MAX_WIDTH)
    expect(result.current.height).toBe(SUBMIT_PANEL_MAX)
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_WIDTH_KEY, '720')
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_SIZE_KEY, '760')
  })

  function makePointerDown(partial: { clientX?: number; clientY?: number; pointerId?: number }) {
    const handle = document.createElement('div')
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    return {
      button: 0,
      pointerId: partial.pointerId ?? 1,
      clientX: partial.clientX ?? 0,
      clientY: partial.clientY ?? 0,
      currentTarget: handle,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }
  }

  it('startResize registers and cleans up drag listeners', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const styleStore: Record<string, string> = {}
    const div = {
      style: {
        setProperty: (prop: string, val: string) => {
          styleStore[prop] = val
        },
        getPropertyValue: (prop: string) => styleStore[prop] ?? '',
      },
    } as unknown as HTMLDivElement
    // Attach ref
    ;(result.current.panelRef as any).current = div

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    act(() => {
      result.current.startResize(makePointerDown({ clientY: 400 }) as any)
    })

    expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))

    // Simulate pointermove (drag DOWN → increase height)
    const moveHandler = addSpy.mock.calls.find((c) => c[0] === 'pointermove')![1] as any
    act(() => {
      moveHandler(new PointerEvent('pointermove', { clientY: 500, pointerId: 1 }))
    })

    // rAF should have been scheduled
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled()
    // Flush rAF
    act(() => rafCb?.())
    // Height should increase: clientY(500) - startY(400) = 100, default 480 + 100 = 580
    expect(div.style.getPropertyValue('--submit-panel-height')).toBe('580px')

    // Simulate pointerup
    const upHandler = addSpy.mock.calls.find((c) => c[0] === 'pointerup')![1] as any
    act(() => {
      upHandler(new PointerEvent('pointerup', { pointerId: 1 }))
    })

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('returns default width 520 when no stored value', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.width).toBe(520)
  })

  it('clamps stored width above max', () => {
    mockGet.mockImplementation((key: string) => (key === SUBMIT_PANEL_WIDTH_KEY ? '9999' : null))
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.width).toBe(SUBMIT_PANEL_MAX_WIDTH)
  })

  it('clamps stored width below min', () => {
    mockGet.mockImplementation((key: string) => (key === SUBMIT_PANEL_WIDTH_KEY ? '10' : null))
    const { result } = renderHook(() => useSubmitPanelSize())
    expect(result.current.width).toBe(SUBMIT_PANEL_MIN_WIDTH)
  })

  it('popoverStyle contains --submit-panel-width CSS var', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const style = result.current.popoverStyle as Record<string, string>
    expect(style['--submit-panel-width']).toBe('520px')
    expect(style['--submit-panel-height']).toBe('480px')
  })

  it('startLeftResize registers and cleans up drag listeners', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const leftStyleStore: Record<string, string> = {}
    const div = {
      style: {
        setProperty: (prop: string, val: string) => {
          leftStyleStore[prop] = val
        },
        getPropertyValue: (prop: string) => leftStyleStore[prop] ?? '',
      },
    } as unknown as HTMLDivElement
    // Attach ref
    ;(result.current.panelRef as any).current = div

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    act(() => {
      result.current.startLeftResize(makePointerDown({ clientX: 400 }) as any)
    })

    expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    // Simulate pointermove (drag LEFT → increase width)
    const moveHandler = addSpy.mock.calls.find((c) => c[0] === 'pointermove')![1] as any
    act(() => {
      moveHandler(new PointerEvent('pointermove', { clientX: 300, pointerId: 1 }))
    })

    // rAF should have been scheduled
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled()
    // Flush rAF
    act(() => rafCb?.())
    // Width should increase: startX(400) - clientX(300) = 100, default 520 + 100 = 620
    expect(div.style.getPropertyValue('--submit-panel-width')).toBe('620px')

    // Simulate pointerup
    const upHandler = addSpy.mock.calls.find((c) => c[0] === 'pointerup')![1] as any
    act(() => {
      upHandler(new PointerEvent('pointerup', { pointerId: 1 }))
    })

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_WIDTH_KEY, '620')

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('startCornerResize updates width and height together', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const styleStore: Record<string, string> = {}
    const div = {
      style: {
        setProperty: (prop: string, val: string) => {
          styleStore[prop] = val
        },
        getPropertyValue: (prop: string) => styleStore[prop] ?? '',
      },
    } as unknown as HTMLDivElement
    ;(result.current.panelRef as any).current = div

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    act(() => {
      result.current.startCornerResize(makePointerDown({ clientX: 400, clientY: 400 }) as any)
    })

    expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(document.body.style.cursor).toBe('nesw-resize')
    expect(document.body.style.userSelect).toBe('none')

    // SW corner: drag left 80px + down 50px → width +80, height +50
    const moveHandler = addSpy.mock.calls.find((c) => c[0] === 'pointermove')![1] as any
    act(() => {
      moveHandler(new PointerEvent('pointermove', { clientX: 320, clientY: 450, pointerId: 1 }))
    })

    expect(globalThis.requestAnimationFrame).toHaveBeenCalled()
    act(() => rafCb?.())
    // default 520×480 → 600×530
    expect(div.style.getPropertyValue('--submit-panel-width')).toBe('600px')
    expect(div.style.getPropertyValue('--submit-panel-height')).toBe('530px')

    const upHandler = addSpy.mock.calls.find((c) => c[0] === 'pointerup')![1] as any
    act(() => {
      upHandler(new PointerEvent('pointerup', { pointerId: 1 }))
    })

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_WIDTH_KEY, '600')
    expect(mockSet).toHaveBeenCalledWith(SUBMIT_PANEL_SIZE_KEY, '530')
    expect(result.current.width).toBe(600)
    expect(result.current.height).toBe(530)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('startCornerResize clamps both axes at min/max', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const styleStore: Record<string, string> = {}
    const div = {
      style: {
        setProperty: (prop: string, val: string) => {
          styleStore[prop] = val
        },
        getPropertyValue: (prop: string) => styleStore[prop] ?? '',
      },
    } as unknown as HTMLDivElement
    ;(result.current.panelRef as any).current = div

    const addSpy = vi.spyOn(document, 'addEventListener')

    act(() => {
      result.current.startCornerResize(makePointerDown({ clientX: 500, clientY: 300 }) as any)
    })

    const moveHandler = addSpy.mock.calls.find((c) => c[0] === 'pointermove')![1] as any
    // Drag far right (shrink width past min) and far up (shrink height past min)
    act(() => {
      moveHandler(new PointerEvent('pointermove', { clientX: 5000, clientY: -5000, pointerId: 1 }))
    })
    act(() => rafCb?.())
    expect(div.style.getPropertyValue('--submit-panel-width')).toBe(`${SUBMIT_PANEL_MIN_WIDTH}px`)
    expect(div.style.getPropertyValue('--submit-panel-height')).toBe(`${SUBMIT_PANEL_MIN}px`)

    // Drag far left + far down past max
    act(() => {
      moveHandler(new PointerEvent('pointermove', { clientX: -5000, clientY: 5000, pointerId: 1 }))
    })
    act(() => rafCb?.())
    expect(div.style.getPropertyValue('--submit-panel-width')).toBe(`${SUBMIT_PANEL_MAX_WIDTH}px`)
    expect(div.style.getPropertyValue('--submit-panel-height')).toBe(`${SUBMIT_PANEL_MAX}px`)

    addSpy.mockRestore()
  })

  it('handleOpenChange cancels dismiss during and right after resize', () => {
    mockGet.mockReturnValue(null)
    const { result } = renderHook(() => useSubmitPanelSize())
    const styleStore: Record<string, string> = {}
    const div = {
      style: {
        setProperty: (prop: string, val: string) => {
          styleStore[prop] = val
        },
        getPropertyValue: (prop: string) => styleStore[prop] ?? '',
      },
    } as unknown as HTMLDivElement
    ;(result.current.panelRef as any).current = div

    const setOpen = vi.fn()
    const cancel = vi.fn()

    // Idle: close is allowed
    act(() => {
      result.current.handleOpenChange(false, { cancel, reason: 'outside-press' }, setOpen)
    })
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(cancel).not.toHaveBeenCalled()
    setOpen.mockClear()

    // Start left resize (hits max width when overshooting is normal)
    const addSpy = vi.spyOn(document, 'addEventListener')
    act(() => {
      result.current.startLeftResize(makePointerDown({ clientX: 400 }) as any)
    })

    // Mid-drag: outside press must not close
    act(() => {
      result.current.handleOpenChange(false, { cancel, reason: 'outside-press' }, setOpen)
    })
    expect(cancel).toHaveBeenCalled()
    expect(setOpen).not.toHaveBeenCalled()
    cancel.mockClear()

    // Release past the panel edge
    const upHandler = addSpy.mock.calls.find((c) => c[0] === 'pointerup')![1] as any
    act(() => {
      upHandler(new PointerEvent('pointerup', { pointerId: 1 }))
    })

    // Immediately after release: still blocked (synthetic click window)
    act(() => {
      result.current.handleOpenChange(false, { cancel, reason: 'outside-press' }, setOpen)
    })
    expect(cancel).toHaveBeenCalled()
    expect(setOpen).not.toHaveBeenCalled()
    cancel.mockClear()

    // After the guard window: dismiss is allowed again
    act(() => {
      vi.advanceTimersByTime(RESIZE_DISMISS_GUARD_MS + 1)
    })
    act(() => {
      result.current.handleOpenChange(false, { cancel, reason: 'outside-press' }, setOpen)
    })
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(cancel).not.toHaveBeenCalled()

    // Opening is always allowed, even during a theoretical guard
    setOpen.mockClear()
    act(() => {
      result.current.handleOpenChange(true, { cancel }, setOpen)
    })
    expect(setOpen).toHaveBeenCalledWith(true)

    addSpy.mockRestore()
  })
})
