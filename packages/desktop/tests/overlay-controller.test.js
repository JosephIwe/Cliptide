import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayController, OVERLAY_ACTIONS } from '../src/overlay/controller.js';

const items = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, preview: `item ${i}` }));

test('the first item is selected when the overlay opens', () => {
  const controller = createOverlayController({ items: items(3) });

  assert.equal(controller.selectedIndex, 0);
  assert.equal(controller.selectedId, 'id-0');
});

test('an empty list has no selection', () => {
  const controller = createOverlayController();

  assert.equal(controller.selectedIndex, -1);
  assert.equal(controller.selected, null);
  assert.equal(controller.isEmpty, true);
});

test('ArrowDown and ArrowUp move the selection', () => {
  const controller = createOverlayController({ items: items(3) });

  assert.deepEqual(controller.handleKey({ key: 'ArrowDown' }).action, OVERLAY_ACTIONS.MOVE);
  assert.equal(controller.selectedId, 'id-1');

  controller.handleKey({ key: 'ArrowDown' });
  assert.equal(controller.selectedId, 'id-2');

  controller.handleKey({ key: 'ArrowUp' });
  assert.equal(controller.selectedId, 'id-1');
});

test('selection clamps at both ends instead of wrapping', () => {
  const controller = createOverlayController({ items: items(2) });

  controller.handleKey({ key: 'ArrowUp' });
  assert.equal(controller.selectedIndex, 0, 'does not wrap to the bottom');

  controller.handleKey({ key: 'ArrowDown' });
  controller.handleKey({ key: 'ArrowDown' });
  controller.handleKey({ key: 'ArrowDown' });
  assert.equal(controller.selectedIndex, 1, 'does not wrap to the top');
});

test('Enter resolves the highlighted item', () => {
  const controller = createOverlayController({ items: items(3) });
  controller.handleKey({ key: 'ArrowDown' });

  const result = controller.handleKey({ key: 'Enter' });

  assert.equal(result.action, OVERLAY_ACTIONS.SELECT);
  assert.equal(result.id, 'id-1');
  assert.equal(result.item.preview, 'item 1');
});

test('Enter on an empty list does nothing rather than resolving null', () => {
  const controller = createOverlayController();

  assert.equal(controller.handleKey({ key: 'Enter' }).action, OVERLAY_ACTIONS.NONE);
});

test('Escape requests dismissal and selects nothing', () => {
  const controller = createOverlayController({ items: items(3) });

  const result = controller.handleKey({ key: 'Escape' });

  assert.equal(result.action, OVERLAY_ACTIONS.DISMISS);
  assert.equal(result.id, undefined, 'dismissal never carries an item to paste');
});

test('ordinary typing is not treated as navigation', () => {
  const controller = createOverlayController({ items: items(3) });

  for (const key of ['a', 'Z', '1', ' ', 'Backspace', 'Tab']) {
    assert.equal(controller.handleKey({ key }).action, OVERLAY_ACTIONS.NONE, key);
  }
  assert.equal(controller.selectedIndex, 0, 'typing did not move the selection');
});

test('replacing the list resets selection to the top', () => {
  const controller = createOverlayController({ items: items(5) });
  controller.handleKey({ key: 'ArrowDown' });
  controller.handleKey({ key: 'ArrowDown' });
  assert.equal(controller.selectedIndex, 2);

  // After a search the ranking changed; a stale index would highlight an
  // unrelated row.
  controller.setItems(items(2));
  assert.equal(controller.selectedIndex, 0);
  assert.equal(controller.selectedId, 'id-0');
});

test('replacing with an empty list clears the selection', () => {
  const controller = createOverlayController({ items: items(3) });
  controller.setItems([]);

  assert.equal(controller.selectedIndex, -1);
  assert.equal(controller.selectedId, null);
  assert.equal(controller.handleKey({ key: 'Enter' }).action, OVERLAY_ACTIONS.NONE);
});

test('clicking selects by index, clamped', () => {
  const controller = createOverlayController({ items: items(3) });

  assert.equal(controller.selectIndex(2).id, 'id-2');
  assert.equal(controller.selectIndex(99).id, 'id-2', 'clamped to the last row');
  assert.equal(controller.selectIndex(-5).id, 'id-0', 'clamped to the first row');
});

test('the query is tracked for the view layer', () => {
  const controller = createOverlayController();

  assert.equal(controller.query, '');
  controller.setQuery('invoice');
  assert.equal(controller.query, 'invoice');
  controller.setQuery(null);
  assert.equal(controller.query, '', 'non-string input does not corrupt the query');
});

test('a malformed key event is ignored', () => {
  const controller = createOverlayController({ items: items(2) });

  assert.equal(controller.handleKey(undefined).action, OVERLAY_ACTIONS.NONE);
  assert.equal(controller.handleKey({}).action, OVERLAY_ACTIONS.NONE);
});
