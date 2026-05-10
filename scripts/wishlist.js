// Per-user wishlist of items the player wants to buy. Stored as a flag on
// game.user so it survives reloads and works across merchants.
//
// Storage shape: array of strings. Each entry is a stable key derived from
// either the compendium sourceId (preferred) or "name|type" (fallback).

import { MODULE_ID } from "./merchant-store.js";

const FLAG = "wishlist";

export function getItemKey(item) {
  if (!item) return null;
  // PF2E imports items with a sourceId pointing back to the compendium.
  const src = item.flags?.core?.sourceId
           ?? item._stats?.compendiumSource
           ?? item.flags?.core?.compendiumSource
           ?? null;
  if (src) return `src:${src}`;
  return `nm:${item.name}|${item.type}`;
}

function readList() {
  try {
    const raw = game.user?.getFlag?.(MODULE_ID, FLAG);
    if (Array.isArray(raw)) return raw;
  } catch { /* tolerate */ }
  return [];
}

async function writeList(list) {
  try {
    await game.user?.setFlag?.(MODULE_ID, FLAG, list);
  } catch (err) {
    console.warn(`${MODULE_ID} | wishlist write failed:`, err);
  }
}

export function isWishlisted(item) {
  const key = getItemKey(item);
  if (!key) return false;
  return readList().includes(key);
}

export async function toggleWishlist(item) {
  const key = getItemKey(item);
  if (!key) return false;
  const list = readList();
  const idx = list.indexOf(key);
  if (idx >= 0) {
    list.splice(idx, 1);
    await writeList(list);
    return false;
  }
  list.push(key);
  await writeList(list);
  return true;
}

export function getAllWishlistKeys() {
  return new Set(readList());
}

export async function clearWishlist() {
  await writeList([]);
}
