// Helpers for reading/writing merchant state on Loot actors and their items.

export const MODULE_ID = "pf2e-cinematic-merchant";

export const ITEM_FLAG_SCOPE = MODULE_ID;
export const TILE_FLAG_SCOPE = MODULE_ID;

// --- Tile <-> merchant linking ---

export function getTileMerchantActorId(tileDoc) {
  return tileDoc?.flags?.[TILE_FLAG_SCOPE]?.actorId ?? null;
}

export async function setTileMerchantActorId(tileDoc, actorId) {
  if (!tileDoc) return;
  if (actorId) {
    return tileDoc.update({ [`flags.${TILE_FLAG_SCOPE}.actorId`]: actorId });
  }
  return tileDoc.update({ [`flags.${TILE_FLAG_SCOPE}.-=actorId`]: null });
}

// Per-tile flag: when true, only clicks on opaque pixels of the tile's image
// trigger the merchant (Monks-ATT-style "use image instead of border").
export function getTileUseImageAlpha(tileDoc) {
  return !!tileDoc?.flags?.[TILE_FLAG_SCOPE]?.useImageAlpha;
}

export async function setTileUseImageAlpha(tileDoc, value) {
  if (!tileDoc) return;
  if (value) {
    return tileDoc.update({ [`flags.${TILE_FLAG_SCOPE}.useImageAlpha`]: true });
  }
  return tileDoc.update({ [`flags.${TILE_FLAG_SCOPE}.-=useImageAlpha`]: null });
}

// Per-tile rectangular click area (in 0..1 fractions of the tile rect). When
// set, clicks outside this rectangle pass through instead of opening the shop.
// Stored as a flag so it travels with the tile.
export function getTileClickArea(tileDoc) {
  const a = tileDoc?.flags?.[TILE_FLAG_SCOPE]?.clickArea;
  if (!a) return null;
  const x = Number(a.x);
  const y = Number(a.y);
  const w = Number(a.w);
  const h = Number(a.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w, h };
}

export async function setTileClickArea(tileDoc, area) {
  if (!tileDoc) return;
  // Full-tile (default) → clear the flag so the tile behaves like a vanilla one.
  if (!area || (area.x <= 0 && area.y <= 0 && area.x + area.w >= 1 && area.y + area.h >= 1)) {
    return tileDoc.update({ [`flags.${TILE_FLAG_SCOPE}.-=clickArea`]: null });
  }
  return tileDoc.update({
    [`flags.${TILE_FLAG_SCOPE}.clickArea`]: {
      x: Math.max(0, Math.min(1, area.x)),
      y: Math.max(0, Math.min(1, area.y)),
      w: Math.max(0.02, Math.min(1, area.w)),
      h: Math.max(0.02, Math.min(1, area.h)),
    },
  });
}

export function getMerchantActor(actorId) {
  if (!actorId) return null;
  const actor = game.actors?.get?.(actorId);
  if (!actor) return null;
  if (actor.type !== "loot") return null;
  return actor;
}

// --- Per-item overrides (price, quantity-cap, etc.) ---

/**
 * Read price-override (in copper) from item flag. Null if no override → uses item.system.price.
 */
export function getItemPriceOverrideCp(item) {
  const v = item?.flags?.[ITEM_FLAG_SCOPE]?.priceOverrideCp;
  return (typeof v === "number" && Number.isFinite(v) && v >= 0) ? v : null;
}

export async function setItemPriceOverrideCp(item, cp) {
  if (!item) return;
  if (cp == null) {
    return item.update({ [`flags.${ITEM_FLAG_SCOPE}.-=priceOverrideCp`]: null });
  }
  return item.update({ [`flags.${ITEM_FLAG_SCOPE}.priceOverrideCp`]: cp });
}

// --- Sell-back / merchant config ---

const DEFAULT_SELL_RATE = 0.5;

export function getMerchantSellRate(actor) {
  const v = actor?.flags?.[MODULE_ID]?.sellRate;
  return (typeof v === "number" && v >= 0 && v <= 2) ? v : DEFAULT_SELL_RATE;
}

export async function setMerchantSellRate(actor, rate) {
  if (!actor) return;
  return actor.update({ [`flags.${MODULE_ID}.sellRate`]: rate });
}

// --- Price markup (applies to all buy prices) and per-rarity discounts ---

const RARITIES = ["common", "uncommon", "rare", "unique"];
const DEFAULT_RARITY_DISCOUNTS = { common: 0, uncommon: 0, rare: 0, unique: 0 };

export function getMerchantMarkup(actor) {
  const v = actor?.flags?.[MODULE_ID]?.markup;
  return (typeof v === "number" && v >= 0 && v <= 5) ? v : 1.0;
}

export async function setMerchantMarkup(actor, value) {
  if (!actor) return;
  return actor.update({ [`flags.${MODULE_ID}.markup`]: value });
}

export function getMerchantRarityDiscounts(actor) {
  const v = actor?.flags?.[MODULE_ID]?.rarityDiscounts;
  if (!v || typeof v !== "object") return { ...DEFAULT_RARITY_DISCOUNTS };
  const out = { ...DEFAULT_RARITY_DISCOUNTS };
  for (const r of RARITIES) {
    if (typeof v[r] === "number" && v[r] >= -1 && v[r] <= 1) out[r] = v[r];
  }
  return out;
}

export function getMerchantPortraitMirrored(actor) {
  return !!actor?.flags?.[MODULE_ID]?.portraitMirrored;
}

export async function setMerchantPortraitMirrored(actor, mirrored) {
  if (!actor) return;
  return actor.update({ [`flags.${MODULE_ID}.portraitMirrored`]: !!mirrored });
}

export function getMerchantGreetingSounds(actor) {
  const v = actor?.flags?.[MODULE_ID]?.greetingSounds;
  if (!Array.isArray(v)) return [];
  return v.filter(p => typeof p === "string" && p.length > 0);
}

export async function setMerchantGreetingSounds(actor, paths) {
  if (!actor) return;
  const clean = Array.isArray(paths)
    ? paths.filter(p => typeof p === "string" && p.length > 0)
    : [];
  return actor.update({ [`flags.${MODULE_ID}.greetingSounds`]: clean });
}

export async function setMerchantRarityDiscounts(actor, discounts) {
  if (!actor) return;
  const clean = {};
  for (const r of RARITIES) {
    const x = Number(discounts?.[r]);
    clean[r] = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
  }
  return actor.update({ [`flags.${MODULE_ID}.rarityDiscounts`]: clean });
}

// --- Item identity (for merging duplicate stacks on a merchant) ---

/**
 * Stable key that identifies "the same item" so we can merge duplicate
 * stacks instead of creating second entries. Prefer the compendium
 * sourceId; fall back to name+type for hand-rolled items.
 */
export function getItemIdentityKey(item) {
  if (!item) return null;
  const src = item.flags?.core?.sourceId
           ?? item._stats?.compendiumSource
           ?? item.flags?.core?.compendiumSource
           ?? null;
  if (src) return `src:${src}`;
  const name = item.name ?? "";
  const type = item.type ?? "";
  return `nm:${name}|${type}`;
}

export function getItemDataIdentityKey(itemData) {
  if (!itemData) return null;
  const src = itemData.flags?.core?.sourceId
           ?? itemData._stats?.compendiumSource
           ?? itemData.flags?.core?.compendiumSource
           ?? null;
  if (src) return `src:${src}`;
  return `nm:${itemData.name ?? ""}|${itemData.type ?? ""}`;
}

// --- Ammunition detection (PF2E uses `consumable` + several markers) ---

const AMMO_STACK_GROUPS = new Set([
  "arrows", "bolts", "blowgunDarts", "blowgun-darts",
  "rounds", "slingBullets", "sling-bullets", "shuriken",
  "darts", "stones", "rockArrows", "pellets",
]);

/**
 * True if this PF2E item is ammunition. Checks all the spots PF2E might
 * carry the marker depending on system version:
 *  - direct type "ammunition" / "ammo"
 *  - consumable with system.category in {"ammo","ammunition"}
 *  - consumable with system.consumableType in {"ammo","ammunition"}
 *  - consumable with a known ammo stack group (arrows, bolts, ...)
 *  - consumable carrying the "ammunition" trait
 */
export function isAmmunitionItem(it) {
  if (!it) return false;
  const t = it.type;
  if (t === "ammunition" || t === "ammo") return true;
  if (t !== "consumable") return false;
  const sys = it.system ?? {};
  if (sys.category === "ammo" || sys.category === "ammunition") return true;
  const consType = sys.consumableType?.value ?? sys.consumableType;
  if (consType === "ammo" || consType === "ammunition") return true;
  if (sys.stackGroup && AMMO_STACK_GROUPS.has(sys.stackGroup)) return true;
  const traits = sys.traits?.value;
  if (Array.isArray(traits) && traits.includes("ammunition")) return true;
  return false;
}

/** Normalized item type for merchant categorization. Maps ammo subtypes
    of `consumable` up to a virtual "ammunition" category. */
export function normalizeMerchantType(it) {
  if (isAmmunitionItem(it)) return "ammunition";
  return it?.type;
}

// --- Coin detection ---

const COIN_SLUGS = new Set(["platinum-pieces", "gold-pieces", "silver-pieces", "copper-pieces"]);
const COIN_NAME_RE = /^(platinum|gold|silver|copper)\s+pieces?$/i;

/**
 * Detect PF2E currency items (Gold Pieces, Silver Pieces, etc.). Those live
 * in actor.inventory.coins and should never appear in buy/sell/vault lists.
 */
export function isCoinItem(item) {
  if (!item) return false;
  if (item.isCoinage === true) return true;            // PF2E getter on treasure
  const sys = item.system ?? {};
  if (sys.stackGroup === "coins") return true;
  if (sys.slug && COIN_SLUGS.has(sys.slug)) return true;
  const name = item.name ?? sys.name ?? "";
  if (COIN_NAME_RE.test(String(name).trim())) return true;
  return false;
}

// --- Merchant services (Pathfinder dienstleistungen — bath, lodging,
//     hireling, spellcasting, repair, ...). Stored as a flag on the
//     merchant actor: an array of { id, name, description, priceCp,
//     level, rarity, img } entries. ---

const SERVICES_FLAG = "services";

/** Read all services on a merchant. Always returns an array. */
export function getMerchantServices(actor) {
  if (!actor) return [];
  const v = actor.flags?.[MODULE_ID]?.[SERVICES_FLAG];
  return Array.isArray(v) ? [...v] : [];
}

async function writeMerchantServices(actor, list) {
  if (!actor) return;
  return actor.update({ [`flags.${MODULE_ID}.${SERVICES_FLAG}`]: list });
}

/** Insert a new service. Auto-assigns an id if none given. */
export async function addMerchantService(actor, service) {
  if (!actor || !service) return;
  const list = getMerchantServices(actor);
  const s = {
    id: service.id ?? foundry.utils.randomID(),
    name: String(service.name ?? "Service"),
    description: String(service.description ?? ""),
    priceCp: Math.max(0, Math.floor(Number(service.priceCp ?? 0)) || 0),
    level: Math.max(0, Math.floor(Number(service.level ?? 0)) || 0),
    rarity: ["common","uncommon","rare","unique"].includes(service.rarity) ? service.rarity : "common",
    img: String(service.img ?? "icons/svg/book.svg"),
  };
  list.push(s);
  await writeMerchantServices(actor, list);
  return s;
}

export async function updateMerchantService(actor, id, patch) {
  if (!actor || !id) return;
  const list = getMerchantServices(actor);
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...patch, id };
  await writeMerchantServices(actor, list);
}

export async function removeMerchantService(actor, id) {
  if (!actor || !id) return;
  const list = getMerchantServices(actor).filter(s => s.id !== id);
  await writeMerchantServices(actor, list);
}

// --- Merchant ownership ---

/**
 * Bump a merchant Loot actor's ownership so every player can directly run
 * Buy/Sell ops without needing the GM online to relay them.
 *  - default → OWNER (catches every user not explicitly listed)
 *  - per-user overrides below OWNER → OWNER (catches users explicitly set
 *    to NONE/LIMITED/OBSERVER, which would otherwise override the default)
 * No-op for non-GMs (only GMs can change ownership).
 */
export async function ensureMerchantOwnership(actor) {
  if (!actor) return;
  if (!game.user.isGM) return;
  const OWNER = (CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
  const cur = actor.ownership ?? {};
  const next = foundry.utils?.deepClone?.(cur) ?? foundry.utils.duplicate(cur);
  let changed = false;
  if ((cur.default ?? 0) < OWNER) {
    next.default = OWNER;
    changed = true;
  }
  for (const [key, level] of Object.entries(cur)) {
    if (key === "default") continue;
    if (typeof level === "number" && level < OWNER) {
      next[key] = OWNER;
      changed = true;
    }
  }
  if (!changed) {
    console.log(`${MODULE_ID} | merchant "${actor.name}" already has player ownership`);
    return;
  }
  try {
    await actor.update({ ownership: next }, { diff: false });
    console.log(`${MODULE_ID} | merchant ownership refreshed for "${actor.name}"`, next);
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to update merchant ownership for "${actor.name}":`, err);
  }
}

// --- Merchant coin balance (GM-set absolute purse) ---

export function readMerchantCoins(actor) {
  if (!actor) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  const inv = actor.inventory?.coins;
  if (inv && (inv.pp != null || inv.gp != null || inv.sp != null || inv.cp != null)) {
    return { pp: inv.pp ?? 0, gp: inv.gp ?? 0, sp: inv.sp ?? 0, cp: inv.cp ?? 0 };
  }
  const sys = actor.system?.coins ?? actor.system?.currency ?? actor.system?.attributes?.currency ?? {};
  return { pp: sys.pp ?? 0, gp: sys.gp ?? 0, sp: sys.sp ?? 0, cp: sys.cp ?? 0 };
}

export async function setMerchantCoins(actor, coins) {
  if (!actor) return;
  const target = {
    pp: Math.max(0, Math.floor(Number(coins?.pp ?? 0)) || 0),
    gp: Math.max(0, Math.floor(Number(coins?.gp ?? 0)) || 0),
    sp: Math.max(0, Math.floor(Number(coins?.sp ?? 0)) || 0),
    cp: Math.max(0, Math.floor(Number(coins?.cp ?? 0)) || 0),
  };
  // Loot actors in PF2E v14 expose addCoins/removeCoins on the inventory and
  // store the totals at system.coins. Try inventory delta first; fall back to
  // a direct write so this works regardless of subtype.
  const cur = readMerchantCoins(actor);
  const deltas = {
    pp: target.pp - (cur.pp ?? 0),
    gp: target.gp - (cur.gp ?? 0),
    sp: target.sp - (cur.sp ?? 0),
    cp: target.cp - (cur.cp ?? 0),
  };
  const noChange = deltas.pp === 0 && deltas.gp === 0 && deltas.sp === 0 && deltas.cp === 0;
  if (noChange) return;

  if (typeof actor.inventory?.addCoins === "function" && typeof actor.inventory?.removeCoins === "function") {
    try {
      const add = { pp: 0, gp: 0, sp: 0, cp: 0 };
      const rem = { pp: 0, gp: 0, sp: 0, cp: 0 };
      for (const k of ["pp", "gp", "sp", "cp"]) {
        if (deltas[k] > 0) add[k] = deltas[k];
        else if (deltas[k] < 0) rem[k] = -deltas[k];
      }
      if (rem.pp || rem.gp || rem.sp || rem.cp) await actor.inventory.removeCoins(rem);
      if (add.pp || add.gp || add.sp || add.cp) await actor.inventory.addCoins(add);
      return;
    } catch (err) {
      console.warn(`${MODULE_ID} | inventory.addCoins/removeCoins failed, falling back to system.coins update:`, err);
    }
  }
  return actor.update({ "system.coins": target });
}

// --- PF2E price/coin helpers ---

const COIN_VALUES_CP = { pp: 1000, gp: 100, sp: 10, cp: 1 };

/** Convert a PF2E price object {value: {pp, gp, sp, cp}} to total copper. */
export function priceToCopper(price) {
  if (!price) return 0;
  const v = price.value ?? price;
  if (typeof v === "number") return v;
  return ((v.pp ?? 0) * COIN_VALUES_CP.pp)
       + ((v.gp ?? 0) * COIN_VALUES_CP.gp)
       + ((v.sp ?? 0) * COIN_VALUES_CP.sp)
       + ((v.cp ?? 0) * COIN_VALUES_CP.cp);
}

/** Convert copper to a denominations object {pp, gp, sp, cp}, prefer larger coins. */
export function copperToCoins(cp) {
  if (!cp || cp <= 0) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  let remaining = Math.round(cp);
  const out = { pp: 0, gp: 0, sp: 0, cp: 0 };
  for (const [coin, val] of Object.entries(COIN_VALUES_CP)) {
    const n = Math.floor(remaining / val);
    out[coin] = n;
    remaining -= n * val;
  }
  return out;
}

/** Format copper as a compact PF2E price string ("3 gp 5 sp"). */
export function formatCopper(cp) {
  if (cp == null || cp <= 0) return "—";
  const coins = copperToCoins(cp);
  const parts = [];
  for (const [coin, n] of Object.entries(coins)) {
    if (n > 0) parts.push(`${n} ${coin}`);
  }
  return parts.length > 0 ? parts.join(" ") : "—";
}

/**
 * Effective per-item BUY price in copper.
 *  - GM-set override wins (no markup applied)
 *  - Otherwise: base × merchant.markup × (1 - rarityDiscount[rarity]) × (1 - dailyOfferPct)
 */
export function effectiveItemPriceCp(item) {
  const override = getItemPriceOverrideCp(item);
  let cp;
  if (override != null) {
    cp = override;
  } else {
    cp = priceToCopper(item.system?.price);
    const actor = item?.parent;
    if (actor) {
      const markup = getMerchantMarkup(actor);
      const rarityDisc = getMerchantRarityDiscounts(actor);
      const rarity = item.system?.traits?.rarity ?? "common";
      const rDisc = Number(rarityDisc?.[rarity] ?? 0);
      cp = cp * markup * (1 - rDisc);
    }
  }
  const offer = getItemDailyOfferPct(item);
  if (offer > 0) cp = cp * (1 - offer);
  return Math.max(0, Math.round(cp));
}

/** Per-item daily-offer discount, 0..0.95. Returns 0 if not set. */
export function getItemDailyOfferPct(item) {
  const v = Number(item?.flags?.[ITEM_FLAG_SCOPE]?.dailyOfferPct);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(0.95, v));
}

export async function setItemDailyOfferPct(item, pct) {
  if (!item) return;
  if (pct == null || !Number.isFinite(Number(pct)) || Number(pct) <= 0) {
    return item.update({ [`flags.${ITEM_FLAG_SCOPE}.-=dailyOfferPct`]: null });
  }
  const clean = Math.max(0, Math.min(0.95, Number(pct)));
  return item.update({ [`flags.${ITEM_FLAG_SCOPE}.dailyOfferPct`]: clean });
}

/** Items currently on offer for this merchant. */
export function getMerchantDailyOffers(actor) {
  if (!actor?.items) return [];
  const out = [];
  for (const it of actor.items) {
    if (isCoinItem(it)) continue;
    const pct = getItemDailyOfferPct(it);
    if (pct > 0) out.push(it);
  }
  return out;
}
