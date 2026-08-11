/**
 * A fake of Electron's `clipboard`, shaped from the real API.
 *
 * The method set and behaviours here were taken from a probe run against
 * Electron 43.3.0 rather than from documentation — including the finding that
 * `availableFormats()` does NOT list custom types written via `writeBuffer`,
 * while `has(name)` does see them. Tests that relied on availableFormats for
 * marker detection would pass against a naive fake and fail on a real Mac.
 */

export class FakeNativeImage {
  constructor({ width = 0, height = 0, png = null } = {}) {
    this.width = width;
    this.height = height;
    this.png = png ?? Buffer.alloc(0);
    this.toPNGCalls = 0;
  }

  isEmpty() {
    return this.width === 0 || this.height === 0;
  }

  getSize() {
    return { width: this.width, height: this.height };
  }

  toPNG() {
    this.toPNGCalls += 1;
    return this.png;
  }
}

export class FakeClipboard {
  constructor() {
    this.text = '';
    /** @type {Map<string, Buffer>} custom formats written via writeBuffer */
    this.buffers = new Map();
    this.image = null;
    /** Formats whose has() should throw, mimicking unregistered-type errors. */
    this.throwOnHas = new Set();
    this.throwOnReadBuffer = new Set();
    this.calls = { readText: 0, has: 0, availableFormats: 0, readImage: 0, readBuffer: 0 };
  }

  // --- test controls -------------------------------------------------------

  /** Simulate an app placing text on the clipboard. */
  setText(text) {
    this.text = text;
    this.buffers.clear();
    this.image = null;
    return this;
  }

  /** Simulate a password manager: text plus a concealed marker. */
  setConcealed(text, format, value = Buffer.from([1])) {
    this.text = text;
    this.buffers.set(format, value);
    return this;
  }

  setImage(image) {
    this.text = '';
    this.image = image;
    return this;
  }

  // --- Electron clipboard API ---------------------------------------------

  readText() {
    this.calls.readText += 1;
    return this.text;
  }

  writeText(text) {
    this.setText(text);
  }

  /**
   * Standard MIME formats only. Custom types written via writeBuffer are
   * deliberately absent — this mirrors measured Electron behaviour.
   */
  availableFormats() {
    this.calls.availableFormats += 1;
    const formats = [];
    if (this.text !== '') formats.push('text/plain');
    if (this.image) formats.push('image/png');
    return formats;
  }

  has(format) {
    this.calls.has += 1;
    if (this.throwOnHas.has(format)) throw new Error(`format not registered: ${format}`);
    if (format === 'text/plain') return this.text !== '';
    if (format === 'image/png') return this.image !== null;
    return this.buffers.has(format);
  }

  readBuffer(format) {
    this.calls.readBuffer += 1;
    if (this.throwOnReadBuffer.has(format)) throw new Error(`cannot read: ${format}`);
    return this.buffers.get(format) ?? Buffer.alloc(0);
  }

  writeBuffer(format, buffer) {
    this.buffers.set(format, buffer);
  }

  readImage() {
    this.calls.readImage += 1;
    return this.image ?? new FakeNativeImage();
  }

  writeImage(bytes) {
    this.image = new FakeNativeImage({ width: 1, height: 1, png: bytes });
    this.text = '';
  }

  clear() {
    this.text = '';
    this.buffers.clear();
    this.image = null;
  }
}
