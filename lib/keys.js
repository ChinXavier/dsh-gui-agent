/**
 * Keyboard name -> Windows virtual-key code mapping and combo parsing.
 * Kept dependency-free so the helper only receives numeric VK lists.
 */

const NAMED_VK = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  menu: 0x12,
  pause: 0x13,
  capslock: 0x14,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  arrowleft: 0x25,
  up: 0x26,
  arrowup: 0x26,
  right: 0x27,
  arrowright: 0x27,
  down: 0x28,
  arrowdown: 0x28,
  insert: 0x2d,
  ins: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  printscreen: 0x2c,
  win: 0x5b,
  lwin: 0x5b,
  rwin: 0x5c,
  meta: 0x5b,
  cmd: 0x5b,
  super: 0x5b,
  app: 0x5d,
  numlock: 0x90,
  scrolllock: 0x91,
  multiply: 0x6a,
  add: 0x6b,
  subtract: 0x6d,
  decimal: 0x6e,
  divide: 0x6f,
  semicolon: 0xba,
  equals: 0xbb,
  comma: 0xbc,
  minus: 0xbd,
  period: 0xbe,
  slash: 0xbf,
  backtick: 0xc0,
  grave: 0xc0,
  bracketleft: 0xdb,
  backslash: 0xdc,
  bracketright: 0xdd,
  quote: 0xde,
  apostrophe: 0xde,
};

for (let i = 1; i <= 24; i += 1) NAMED_VK[`f${i}`] = 0x6f + i;

// Unshifted key that produces a shifted symbol on a US layout.
const SHIFTED_SYMBOLS = {
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
};

const PUNCTUATION = {
  '-': 0xbd,
  '=': 0xbb,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  ';': 0xba,
  "'": 0xde,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
};

function singleCharVk(ch) {
  if (/[a-z]/i.test(ch)) return { vk: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/[0-9]/.test(ch)) return { vk: ch.charCodeAt(0), shift: false };
  if (Object.hasOwn(PUNCTUATION, ch)) return { vk: PUNCTUATION[ch], shift: false };
  if (Object.hasOwn(SHIFTED_SYMBOLS, ch)) {
    const base = SHIFTED_SYMBOLS[ch];
    const baseInfo = singleCharVk(base);
    return { vk: baseInfo.vk, shift: true };
  }
  return null;
}

function tokenToKey(token) {
  const lower = token.toLowerCase();
  if (Object.hasOwn(NAMED_VK, lower)) return { vk: NAMED_VK[lower], shift: false };
  if (/^[a-z0-9]$/i.test(token)) return singleCharVk(token);
  if (token.length === 1) {
    const info = singleCharVk(token);
    if (info) return info;
  }
  return null;
}

/**
 * Parse a combo such as "ctrl+shift+t", "alt+f4", "enter" or "!" into an
 * ordered list of virtual-key codes where the final code is the main key.
 */
export function parseCombo(combo) {
  const parts = String(combo)
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('empty key combo');

  const modifiers = [];
  let keyToken = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.push(NAMED_VK.ctrl);
    else if (lower === 'shift') modifiers.push(NAMED_VK.shift);
    else if (lower === 'alt') modifiers.push(NAMED_VK.alt);
    else if (lower === 'win' || lower === 'meta' || lower === 'cmd' || lower === 'super') modifiers.push(NAMED_VK.win);
    else keyToken = part;
  }
  if (keyToken === null) throw new Error(`no main key in combo: ${combo}`);
  const info = tokenToKey(keyToken);
  if (!info) throw new Error(`unknown key: ${keyToken}`);

  const vks = [...modifiers];
  if (info.shift) vks.push(NAMED_VK.shift);
  vks.push(info.vk);
  return vks;
}

/** Parse a list of combos into a list of VK arrays. */
export function parseComboList(combos) {
  if (!Array.isArray(combos) || combos.length === 0) throw new Error('keys array is required');
  return combos.map((combo) => parseCombo(combo));
}
