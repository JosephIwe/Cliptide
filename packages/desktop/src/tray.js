/**
 * Tray presence.
 *
 * Cliptide runs in the background with no dock/taskbar window, so the tray is
 * the only always-available handle on the app. It stays deliberately small:
 * open the history, show how to summon it, quit. Anything more belongs in
 * settings, which is a later milestone.
 *
 * Electron pieces are injected so the menu structure and actions are testable
 * without a display server.
 */

/** A 16x16 transparent PNG. Replaced by real artwork before any release. */
const PLACEHOLDER_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo2AUAAAHhgABxeMAJwAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * @param {Object} options
 * @param {{new (image: any): any}} options.Tray Electron's Tray class
 * @param {{buildFromTemplate: Function}} options.Menu
 * @param {{createFromBuffer: Function}} options.nativeImage
 * @param {() => void} options.onOpen
 * @param {() => void} options.onQuit
 * @param {() => string|null} [options.getShortcut] accelerator to display
 */
export function createTrayController({
  Tray,
  Menu,
  nativeImage,
  onOpen,
  onQuit,
  getShortcut = () => null,
}) {
  if (typeof Tray !== 'function') throw new TypeError('createTrayController requires Electron Tray');
  if (typeof onOpen !== 'function' || typeof onQuit !== 'function') {
    throw new TypeError('createTrayController requires onOpen and onQuit');
  }

  let tray = null;

  /** Menu template, exposed so tests can assert it without a real tray. */
  function buildTemplate() {
    const shortcut = getShortcut();
    return [
      {
        label: 'Open Cliptide',
        // Shown for discoverability. The binding itself is owned by the
        // shortcut manager, not by this menu item.
        accelerator: shortcut ?? undefined,
        click: onOpen,
      },
      { type: 'separator' },
      shortcut
        ? { label: `Summon: ${shortcut}`, enabled: false }
        : { label: 'Summon shortcut unavailable', enabled: false },
      { type: 'separator' },
      { label: 'Quit Cliptide', click: onQuit },
    ];
  }

  return {
    get tray() {
      return tray;
    },

    buildTemplate,

    create() {
      const icon = nativeImage?.createFromBuffer
        ? nativeImage.createFromBuffer(PLACEHOLDER_ICON_PNG)
        : PLACEHOLDER_ICON_PNG;

      tray = new Tray(icon);
      tray.setToolTip('Cliptide');
      tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()));

      // Clicking the icon summons directly — the fastest path, and what users
      // expect from a tray utility.
      if (typeof tray.on === 'function') tray.on('click', onOpen);
      return tray;
    },

    /** Rebuild after the bound accelerator changes. */
    refresh() {
      if (!tray) return false;
      tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()));
      return true;
    },

    destroy() {
      if (!tray) return false;
      if (typeof tray.destroy === 'function') tray.destroy();
      tray = null;
      return true;
    },
  };
}

export { PLACEHOLDER_ICON_PNG };
