/**
 * Overlay renderer.
 *
 * A thin view over `controller.js` — the same module the tests drive, so the
 * keyboard behaviour asserted in CI is the behaviour that ships. Everything
 * stateful lives in the controller; this file only translates DOM events into
 * controller calls and controller state into DOM.
 *
 * It has no Node access, no `require`, and no way to reach clipboard payloads.
 * The only capabilities are the four functions on `window.cliptide`.
 */

import { createOverlayController, OVERLAY_ACTIONS } from './controller.js';

const searchInput = document.getElementById('search');
const resultsList = document.getElementById('results');
const emptyState = document.getElementById('empty');

const controller = createOverlayController();

/** Keeps typing responsive without firing a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 40;
let debounceTimer = null;

function render() {
  const { items, selectedIndex } = controller;

  emptyState.hidden = items.length > 0;
  resultsList.hidden = items.length === 0;

  // Rebuilt wholesale: the list is capped at a few dozen rows, so this is
  // cheaper and far less error-prone than diffing.
  const fragment = document.createDocumentFragment();

  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'row';
    row.id = `row-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === selectedIndex));

    if (item.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin';
      pin.textContent = '📌';
      pin.setAttribute('aria-label', 'pinned');
      row.append(pin);
    }

    const preview = document.createElement('span');
    preview.className = 'preview';
    // textContent, never innerHTML: a clipboard preview is untrusted input and
    // must never be parsed as markup.
    preview.textContent = item.preview;
    row.append(preview);

    if (item.sensitive) {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = 'secret';
      flag.title = 'Looks like a credential — preview is masked';
      row.append(flag);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = item.kindLabel;
    row.append(meta);

    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = item.relativeAge;
    row.append(age);

    row.addEventListener('click', () => {
      controller.selectIndex(index);
      render();
      void useSelected();
    });

    fragment.append(row);
  });

  resultsList.replaceChildren(fragment);

  const selected = resultsList.children[selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest' });
    resultsList.setAttribute('aria-activedescendant', selected.id);
  } else {
    resultsList.removeAttribute('aria-activedescendant');
  }
}

async function loadRecent() {
  const items = await window.cliptide.list({});
  controller.setItems(items);
  render();
}

async function runSearch(query) {
  const items = await window.cliptide.search(query, {});
  controller.setItems(items);
  render();
}

async function useSelected() {
  const id = controller.selectedId;
  if (!id) return;
  // The main process reads the payload and writes the clipboard; this process
  // only ever names an id.
  await window.cliptide.use(id);
  await window.cliptide.close();
}

async function dismiss() {
  await window.cliptide.close();
}

searchInput.addEventListener('input', () => {
  const query = searchInput.value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    // An empty box means "show me everything" — the engine treats it that way,
    // so clearing the query restores recent history without a special case.
    void runSearch(query);
  }, SEARCH_DEBOUNCE_MS);
});

// Keys are handled at the document level so navigation works while the search
// box holds focus — which it always does, because this is a keyboard-first tool.
document.addEventListener('keydown', (event) => {
  const result = controller.handleKey(event);

  switch (result.action) {
    case OVERLAY_ACTIONS.MOVE:
      // Stop the caret from jumping to the ends of the search box.
      event.preventDefault();
      render();
      break;
    case OVERLAY_ACTIONS.SELECT:
      event.preventDefault();
      void useSelected();
      break;
    case OVERLAY_ACTIONS.DISMISS:
      event.preventDefault();
      void dismiss();
      break;
    default:
      break;
  }
});

// Re-summoning should feel like a fresh start, not resume a stale query.
window.addEventListener('focus', () => {
  searchInput.value = '';
  searchInput.focus();
  void loadRecent();
});

searchInput.focus();
void loadRecent();
