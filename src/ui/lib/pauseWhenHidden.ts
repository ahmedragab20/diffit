/**
 * Pauses animation while the page is hidden.
 *
 * The plan requires activity animation to pause "when inactive/hidden". A
 * looping indicator in a background tab burns battery for nobody's benefit,
 * and browsers throttle rather than stop it. CSS cannot observe page
 * visibility, so the state is reflected onto the root element and the
 * stylesheet pauses on that.
 *
 * Reflecting state rather than stopping animations individually means a new
 * animation added later is covered without anyone remembering to opt in.
 */
export const PAGE_HIDDEN_ATTRIBUTE = "data-page-hidden";

/**
 * Starts reflecting visibility onto the root element. Returns a teardown, and
 * is safe to call where there is no document.
 */
export function observePageVisibility(
	target: Document | undefined = typeof document === "undefined"
		? undefined
		: document,
): () => void {
	if (!target?.documentElement) return () => {};
	const root = target.documentElement;
	const reflect = () => {
		if (target.visibilityState === "hidden")
			root.setAttribute(PAGE_HIDDEN_ATTRIBUTE, "true");
		else root.removeAttribute(PAGE_HIDDEN_ATTRIBUTE);
	};
	reflect();
	target.addEventListener("visibilitychange", reflect);
	return () => {
		target.removeEventListener("visibilitychange", reflect);
		root.removeAttribute(PAGE_HIDDEN_ATTRIBUTE);
	};
}
