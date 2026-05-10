import { MODULE_ID, getMerchantActor, getTileMerchantActorId, ensureMerchantOwnership } from "./merchant-store.js";
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

  console.log(`${MODULE_ID} | ready`);
});
