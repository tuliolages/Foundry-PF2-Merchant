import { MODULE_ID, getMerchantActor, getTileMerchantActorId, ensureMerchantOwnership, getItemIdentityKey, isCoinItem } from "./merchant-store.js";
import { registerTileHooks } from "./tile-link.js";
import { MerchantWindow } from "./merchant-window.js";
import { registerSoundSettings } from "./sound-fx.js";
import { registerSocketBridge } from "./socket-bridge.js";
import { registerGMHandlers } from "./gm-ops.js";

let merchantWindow = null;

Hooks.once("init", () => {
  registerSoundSettings();
});

Hooks.once("ready", async () => {
  if (game.system.id !== "pf2e") {
    console.warn(`${MODULE_ID} | not running on PF2E system, disabled`);
    return;
  }
  // One-time migration: GM auto-heals ownership on every Loot actor that
  // is currently linked to a merchant tile. After this runs once, players
  // can buy/sell directly without needing a GM online.
  if (game.user.isGM) {
    const seen = new Set();
    for (const scene of game.scenes ?? []) {
      for (const tile of scene.tiles ?? []) {
        const actorId = getTileMerchantActorId(tile);
        if (actorId && !seen.has(actorId)) {
          seen.add(actorId);
          const actor = getMerchantActor(actorId);
          if (actor) await ensureMerchantOwnership(actor);
        }
      }
    }
  }

  // GM auto-heal: every time the GM opens a Loot actor sheet, refresh
  // ownership in case it's a merchant whose perms haven't been fixed yet.
  Hooks.on("renderActorSheet", (app) => {
    if (!game.user.isGM) return;
    const actor = app?.actor;
    if (!actor || actor.type !== "loot") return;
    ensureMerchantOwnership(actor);
  });

  // Auto-merge duplicate stacks: when an item is created on a Loot actor
  // and a sibling with the same identity already exists, bump the existing
  // quantity and delete the new entry. Keeps merchant inventories tidy
  // regardless of how items got there (import, sell-in, random stock, drag).
  Hooks.on("createItem", async (item, _options, userId) => {
    if (game.user.id !== userId) return;          // only the originator runs
    const parent = item?.parent;
    if (!parent || parent.type !== "loot") return; // merchants only
    if (isCoinItem(item)) return;                  // coin items are PF2E-managed
    const key = getItemIdentityKey(item);
    if (!key) return;
    let target = null;
    for (const sibling of parent.items) {
      if (sibling.id === item.id) continue;
      if (getItemIdentityKey(sibling) === key) { target = sibling; break; }
    }
    if (!target) return;
    try {
      const targetQty = Math.max(1, Number(target.system?.quantity ?? 1));
      const incomingQty = Math.max(1, Number(item.system?.quantity ?? 1));
      await target.update({ "system.quantity": targetQty + incomingQty });
      await item.delete();
    } catch (err) {
      console.warn(`${MODULE_ID} | merge duplicate item failed:`, err);
    }
  });
  // Wire socket bridge so the active GM can serve as a fallback when a
  // player's direct ops are denied by Foundry permissions.
  registerGMHandlers();
  registerSocketBridge();

  merchantWindow = new MerchantWindow();
  merchantWindow.mount();

  registerTileHooks((actor, tile) => {
    if (!actor) return;
    merchantWindow.open(actor, tile);
  });

  // Module API for macros / external use
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = mod.api ?? {};
    mod.api.openMerchant = (actorOrId) => {
      const actor = typeof actorOrId === "string" ? getMerchantActor(actorOrId) : actorOrId;
      if (!actor) {
        ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.actorMissing"));
        return;
      }
      merchantWindow.open(actor);
    };
    // Manual GM trigger: walk every linked merchant and force-refresh
    // ownership. Useful as a last resort if auto-heal didn't fire.
    mod.api.refreshAllMerchantPermissions = async () => {
      if (!game.user.isGM) {
        ui.notifications?.warn("GM only");
        return;
      }
      let n = 0;
      const seen = new Set();
      for (const scene of game.scenes ?? []) {
        for (const tile of scene.tiles ?? []) {
          const actorId = getTileMerchantActorId(tile);
          if (actorId && !seen.has(actorId)) {
            seen.add(actorId);
            const actor = getMerchantActor(actorId);
            if (actor) {
              await ensureMerchantOwnership(actor);
              n++;
            }
          }
        }
      }
      ui.notifications?.info(`Refreshed permissions on ${n} merchant(s).`);
      return n;
    };
  }
});
