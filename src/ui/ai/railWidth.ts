/**
 * Width clamping for the assistant rail.
 *
 * A fixed 320–720px range ignores the window: a width persisted on a wide
 * display overflows a narrow one, leaving no room for the diff the rail is
 * meant to discuss. Clamping against the viewport keeps a usable gutter, and
 * on a window too narrow for both the rail yields rather than the diff.
 */
export const RAIL_WIDTH = Object.freeze({
	min: 320,
	max: 720,
	/** Diff space the rail must never consume. */
	gutter: 360,
	/** Below this the rail is too narrow to be useful and should be hidden. */
	collapseBelow: 240,
});

/**
 * Resolves a requested rail width against the viewport. Returns null when the
 * window cannot accommodate a usable rail at all, so the caller can collapse
 * it instead of rendering something unreadable.
 */
export function clampRailWidth(
	requested: number,
	viewportWidth: number,
): number | null {
	if (!Number.isFinite(requested) || !Number.isFinite(viewportWidth))
		return RAIL_WIDTH.min;
	const available = viewportWidth - RAIL_WIDTH.gutter;
	if (available < RAIL_WIDTH.collapseBelow) return null;
	const ceiling = Math.min(RAIL_WIDTH.max, available);
	// The floor yields to the ceiling: a narrow window wins over the minimum.
	return Math.round(Math.max(Math.min(requested, ceiling), Math.min(RAIL_WIDTH.min, ceiling)));
}
