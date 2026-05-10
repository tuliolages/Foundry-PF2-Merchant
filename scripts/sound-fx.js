// Sound effects for buy/sell/open. Settings-driven; defaults to Foundry's
// built-in core sounds so it works out of the box.

import { MODULE_ID } from "./merchant-store.js";

const KEYS = {
  enabled: "soundsEnabled",
  volume:  "soundsVolume",
  open:    "soundOpen",
  buy:     "soundBuy",
  sell:    "soundSell",
  vault:   "soundVault",
};

// Bundled with the module — paths relative to the Foundry data root.
const DEFAULT_OPEN  = `modules/${MODULE_ID}/sounds/shop-bell.mp3`;
const DEFAULT_BUY   = `modules/${MODULE_ID}/sounds/clinking-coins.mp3`;
const DEFAULT_SELL  = `modules/${MODULE_ID}/sounds/clinking-coins.mp3`;
const DEFAULT_VAULT = `modules/${MODULE_ID}/sounds/vault-pop.mp3`;

export function registerSoundSettings() {
  const FilePicker = (foundry.applications?.apps?.FilePicker?.implementation) ?? globalThis.FilePicker;

  game.settings.register(MODULE_ID, KEYS.enabled, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundEnabled",
    hint: "PF2E_CINEMATIC_MERCHANT.settings.soundEnabledHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, KEYS.volume, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundVolume",
    hint: "PF2E_CINEMATIC_MERCHANT.settings.soundVolumeHint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.5,
  });
  game.settings.register(MODULE_ID, KEYS.open, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundOpen",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_OPEN,
    filePicker: "audio",
  });
  game.settings.register(MODULE_ID, KEYS.buy, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundBuy",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_BUY,
    filePicker: "audio",
  });
  game.settings.register(MODULE_ID, KEYS.sell, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundSell",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SELL,
    filePicker: "audio",
  });
  game.settings.register(MODULE_ID, KEYS.vault, {
    name: "PF2E_CINEMATIC_MERCHANT.settings.soundVault",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_VAULT,
    filePicker: "audio",
  });
}

function playPath(src, volume) {
  if (!src) return;
  console.log(`${MODULE_ID} | sound: playing ${src} at volume ${volume}`);
  // Try Foundry's audio helper first — it integrates with the volume mixer.
  try {
    const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    if (helper?.play) {
      const p = helper.play({ src, volume, autoplay: true, loop: false }, false);
      if (p?.catch) p.catch(err => {
        console.warn(`${MODULE_ID} | AudioHelper.play rejected for ${src}, falling back:`, err);
        nativePlay(src, volume);
      });
      return;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | AudioHelper threw, falling back:`, err);
  }
  nativePlay(src, volume);
}

function nativePlay(src, volume) {
  try {
    const a = new Audio(src);
    a.volume = volume;
    a.play().catch(err => console.warn(`${MODULE_ID} | native Audio.play rejected for ${src}:`, err));
  } catch (err) {
    console.warn(`${MODULE_ID} | native Audio failed (${src}):`, err);
  }
}

function readVolume() {
  try {
    const v = Number(game.settings.get(MODULE_ID, KEYS.volume));
    if (!Number.isFinite(v)) return 0.5;
    return Math.max(0, Math.min(1, v));
  } catch { return 0.5; }
}

function isEnabled() {
  try { return !!game.settings.get(MODULE_ID, KEYS.enabled); }
  catch { return true; }
}

// Old defaults from earlier dev iterations — silently redirect to the new
// bundled sounds so users who have these saved (without explicitly choosing
// a custom path) still get audio.
const LEGACY_DEFAULTS = new Set([
  "sounds/notify.wav", "sounds/lock.wav", "sounds/door-open.wav",
  `modules/${MODULE_ID}/sounds/coin.mp3`,
  `modules/${MODULE_ID}/sounds/coin-pickup.mp3`,
]);

function getPath(key, fallback) {
  try {
    const v = String(game.settings.get(MODULE_ID, key) ?? "").trim();
    if (!v) return fallback;
    if (LEGACY_DEFAULTS.has(v)) return fallback;
    return v;
  } catch { return fallback; }
}

export function playOpen() {
  if (!isEnabled()) return;
  playPath(getPath(KEYS.open, DEFAULT_OPEN), readVolume());
}
export function playBuy() {
  if (!isEnabled()) return;
  playPath(getPath(KEYS.buy, DEFAULT_BUY), readVolume());
}
export function playSell() {
  if (!isEnabled()) return;
  playPath(getPath(KEYS.sell, DEFAULT_SELL), readVolume());
}
export function playVault() {
  if (!isEnabled()) return;
  playPath(getPath(KEYS.vault, DEFAULT_VAULT), readVolume());
}

// Generic UI click — reuses the vault pop sound at a lower volume so it
// doesn't drown out buy/sell coin sounds when both fire on the same click.
export function playClick() {
  if (!isEnabled()) return;
  playPath(getPath(KEYS.vault, DEFAULT_VAULT), readVolume() * 0.4);
}
