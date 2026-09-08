/**
 * Motion that honours a reduced-motion preference.
 *
 * The global `prefers-reduced-motion` stylesheet rule cannot help here: an
 * explicit `behavior` passed to `scrollIntoView` or `scrollTo` takes precedence
 * over the CSS `scroll-behavior` property, so a hardcoded `"smooth"` animates
 * regardless of what the user asked for. Resolve the behavior through this
 * instead of writing `"smooth"` at the call site.
 */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** True when the user has asked for reduced motion. */
export function prefersReducedMotion(): boolean {
	// matchMedia is absent in some test and embedded environments; assume the
	// user has expressed no preference rather than throwing.
	if (typeof window === "undefined" || typeof window.matchMedia !== "function")
		return false;
	try {
		return window.matchMedia(REDUCED_MOTION).matches === true;
	} catch {
		return false;
	}
}

/**
 * Resolves a desired scroll behavior against the user's preference, so a
 * reduced-motion request wins over the call site's preferred animation.
 */
export function scrollBehavior(
	preferred: ScrollBehavior = "smooth",
): ScrollBehavior {
	return prefersReducedMotion() ? "auto" : preferred;
}
