/**
 * Overlay selection state machine.
 *
 * Pure and DOM-free, so the interaction that matters most — arrow keys, Enter,
 * Escape — is tested directly rather than through a browser harness. The
 * renderer imports this same module, so what the tests assert is what ships.
 *
 * Interaction contract:
 *
 *   ArrowDown / ArrowUp  move the selection, clamped at the ends
 *   Enter                resolve the selected item
 *   Escape               dismiss, changing nothing
 *
 * Selection clamps rather than wraps. Wrapping in a short list makes it easy to
 * shoot past the item you wanted and land on the opposite end, which in a
 * paste tool means pasting the wrong thing.
 */

export const OVERLAY_ACTIONS = Object.freeze({
  MOVE: 'move',
  SELECT: 'select',
  DISMISS: 'dismiss',
  SEARCH: 'search',
  NONE: 'none',
});

export function createOverlayController({ items = [] } = {}) {
  let current = [...items];
  let selectedIndex = current.length > 0 ? 0 : -1;
  let query = '';

  const clamp = (index) => {
    if (current.length === 0) return -1;
    return Math.min(current.length - 1, Math.max(0, index));
  };

  return {
    get items() {
      return current;
    },

    get selectedIndex() {
      return selectedIndex;
    },

    get selected() {
      return selectedIndex >= 0 ? (current[selectedIndex] ?? null) : null;
    },

    get selectedId() {
      return this.selected?.id ?? null;
    },

    get query() {
      return query;
    },

    get isEmpty() {
      return current.length === 0;
    },

    /**
     * Replace the visible list.
     *
     * Selection resets to the top. After a search the ranking changed, so
     * holding a stale index would leave the highlight on an unrelated row.
     */
    setItems(next) {
      current = [...next];
      selectedIndex = current.length > 0 ? 0 : -1;
      return this;
    },

    setQuery(next) {
      query = typeof next === 'string' ? next : '';
      return this;
    },

    moveDown() {
      selectedIndex = clamp(selectedIndex + 1);
      return this.selected;
    },

    moveUp() {
      selectedIndex = clamp(selectedIndex - 1);
      return this.selected;
    },

    /** Direct selection, for a pointer click. */
    selectIndex(index) {
      selectedIndex = clamp(index);
      return this.selected;
    },

    /**
     * Map a keyboard event to an intent.
     *
     * Returns the action plus whatever the caller needs to act on it, so the
     * renderer stays a thin translation layer between DOM events and this.
     *
     * @param {{key: string}} event
     */
    handleKey(event) {
      switch (event?.key) {
        case 'ArrowDown':
          this.moveDown();
          return { action: OVERLAY_ACTIONS.MOVE, index: selectedIndex, item: this.selected };
        case 'ArrowUp':
          this.moveUp();
          return { action: OVERLAY_ACTIONS.MOVE, index: selectedIndex, item: this.selected };
        case 'Enter': {
          const item = this.selected;
          // Enter on an empty result set must do nothing rather than resolve
          // null — the caller would otherwise try to paste "no item".
          if (!item) return { action: OVERLAY_ACTIONS.NONE };
          return { action: OVERLAY_ACTIONS.SELECT, id: item.id, item };
        }
        case 'Escape':
          return { action: OVERLAY_ACTIONS.DISMISS };
        default:
          return { action: OVERLAY_ACTIONS.NONE };
      }
    },
  };
}
