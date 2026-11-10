// Unsaved-changes state for a block of form fields, by value rather than by
// event: the block is dirty only while what it holds differs from what it held
// before the person first touched it. So a page's own setup (filling a select,
// a synthetic 'change' that only resyncs a styled trigger, reconciling two
// conflicting toggles on load), re-picking the same option, or typing a value
// and then putting it back never reads as a pending change.
//
// The baseline is taken lazily, on the first pointerdown or focus inside the
// block: by then every load-time fill has run, and it always lands before the
// person's own first edit.

const SKIP_TYPES = new Set(['button', 'submit', 'reset', 'file', 'image']);

/**
 * @param {Element} root  the block whose edits are tracked
 * @param {{
 *   fields?: () => Array<Element | null | undefined>,  only these controls (default: every control in root)
 *   skip?: string,                    selector for controls inside root that are not part of the save
 *   extra?: () => string,             state kept outside form controls (picked swatches, tag chips, …)
 *   onChange?: (dirty: boolean) => void,
 * }} [opts]
 */
export function trackDirty(root, { fields, skip, extra, onChange } = {}) {
  /** @type {string | null} */
  let baseline = null;
  let dirty = false;

  function controls() {
    const list = fields ? fields() : [...root.querySelectorAll('input, select, textarea')];
    return list.filter((el) => {
      if (!el) return false;
      if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) return false;
      if (skip && el.closest(skip)) return false;
      return !el.closest('[data-dirty-ignore]');
    });
  }

  function snapshot() {
    const values = controls().map((el) => {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
      if (el instanceof HTMLSelectElement && el.multiple) return [...el.selectedOptions].map((o) => o.value);
      return /** @type {HTMLInputElement} */ (el).value;
    });
    return JSON.stringify([values, extra ? extra() : null]);
  }

  function arm() {
    if (baseline === null) baseline = snapshot();
  }

  function refresh() {
    const next = baseline !== null && snapshot() !== baseline;
    if (next !== dirty) {
      dirty = next;
      onChange?.(dirty);
    }
  }

  root.addEventListener('pointerdown', arm, true);
  root.addEventListener('focusin', arm, true);
  root.addEventListener('keydown', arm, true);
  root.addEventListener('input', refresh);
  root.addEventListener('change', refresh);
  // Buttons that add or remove rows (Docker ports, tag chips) change the
  // fields without an input event: re-check once the click has been handled.
  root.addEventListener('click', () => setTimeout(refresh, 0));

  return {
    /** Re-check after a change made outside an input/change event (a swatch click, a removed chip). */
    refresh,
    /** A save landed: clean now, and the next touch takes a fresh baseline
     *  (after the page has cleared write-only fields like a webhook URL). */
    reset() {
      baseline = null;
      refresh();
    },
    isDirty: () => dirty,
  };
}
