/** Everything that could take focus; which of it really can is decided by `canTakeFocus`. */
const CANDIDATES = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";

type Focusable = { tabIndex: number; disabled?: boolean; getClientRects: () => { length: number } };

/** In the tab order, not disabled, and drawn: a hidden or collapsed control is skipped by Tab, so the trap skips it too. */
export function canTakeFocus(el: Focusable): boolean {
  return el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0;
}

/**
 * Where Tab should go instead of where the browser would send it, or null to let it be: from the last back to the
 * first (the first to the last with Shift), and back in at the near end when focus has got outside altogether.
 */
export function trapTarget<T>(focusable: T[], active: T | null, shift: boolean, inside: boolean): T | null {
  if (!focusable.length) return null;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!inside) return shift ? last : first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

/** Keep Tab and Shift+Tab inside `container`, for a modal dialog. Call from a keydown listener. */
export function trapTab(e: KeyboardEvent, container: HTMLElement) {
  if (e.key !== "Tab") return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(CANDIDATES)).filter((el) => canTakeFocus(el as HTMLElement & { disabled?: boolean }));
  const active = document.activeElement as HTMLElement | null;
  const to = trapTarget(focusable, active, e.shiftKey, Boolean(active && container.contains(active)));
  if (!to) return;
  e.preventDefault();
  to.focus();
}
