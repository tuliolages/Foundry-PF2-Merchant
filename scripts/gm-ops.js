// GM-side handlers for transactions that touch the merchant (Loot) actor.
// Players can't update actors they don't own, so all such ops are funneled
// through these handlers via the socket bridge.

import {
  MODULE_ID,
  effectiveItemPriceCp,
  priceToCopper,
  copperToCoins,
  getMerchantSellRate,
  setMerchantCoins,
  readMerchantCoins,
  recordMerchantTransaction,
} from "./merchant-store.js";
import { registerHandler } from "./socket-bridge.js";

function readCoins(actor) {
  if (!actor) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  const inv = actor.inventory?.coins;
  if (inv && (inv.pp != null || inv.gp != null || inv.sp != null || inv.cp != null)) {
    return { pp: inv.pp ?? 0, gp: inv.gp ?? 0, sp: inv.sp ?? 0, cp: inv.cp ?? 0 };
  }
  const sys = actor.system?.coins ?? actor.system?.currency ?? actor.system?.attributes?.currency ?? {};
  return { pp: sys.pp ?? 0, gp: sys.gp ?? 0, sp: sys.sp ?? 0, cp: sys.cp ?? 0 };
}

async function deductCoins(actor, cp) {
  if (!actor || cp <= 0) return;
  if (typeof actor.inventory?.removeCoins === "function") {
    return actor.inventory.removeCoins(copperToCoins(cp));
  }
  const totalCp = priceToCopper({ value: readCoins(actor) });
  const newCp = Math.max(0, totalCp - cp);
  await actor.update({ "system.coins": copperToCoins(newCp) });
}

async function addCoins(actor, cp) {
  if (!actor || cp <= 0) return;
  if (typeof actor.inventory?.addCoins === "function") {
    return actor.inventory.addCoins(copperToCoins(cp));
  }
  const totalCp = priceToCopper({ value: readCoins(actor) });
  await actor.update({ "system.coins": copperToCoins(totalCp + cp) });
}

export function registerGMHandlers() {
  // --- Buy: viewer buys qty of itemId from merchant --------------------------
  registerHandler("merchant.buy", async ({ merchantId, viewerId, itemId, qty }) => {
    const merchant = game.actors?.get?.(merchantId);
    const viewer = game.actors?.get?.(viewerId);
    const item = merchant?.items?.get?.(itemId);
    if (!merchant || !viewer || !item) throw new Error("merchant.buy: missing actor or item");

    const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
    const buyQty = Math.max(1, Math.min(stockQty, Math.floor(qty) || 1));
    const unitCp = effectiveItemPriceCp(item);
    const totalCp = unitCp * buyQty;
    const buyerCp = priceToCopper({ value: readCoins(viewer) });
    if (buyerCp < totalCp) throw new Error("not_enough_gold");

    await deductCoins(viewer, totalCp);
    await addCoins(merchant, totalCp);

    const data = item.toObject();
    delete data._id;
    data.system = foundry.utils.duplicate(data.system);
    if (data.system.quantity != null) data.system.quantity = buyQty;
    if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
    await viewer.createEmbeddedDocuments("Item", [data]);

    if (stockQty > buyQty) {
      await item.update({ "system.quantity": stockQty - buyQty });
    } else {
      await item.delete();
    }
    await recordMerchantTransaction(merchant, {
      kind: "buy",
      characterId: viewer.id, characterName: viewer.name,
      itemName: item.name, itemImg: item.img,
      qty: buyQty, cp: totalCp,
    });
    return { ok: true, totalCp, qty: buyQty, name: item.name };
  });

  // --- Sell: viewer sells qty of itemId to merchant --------------------------
  registerHandler("merchant.sell", async ({ merchantId, viewerId, itemId, qty }) => {
    const merchant = game.actors?.get?.(merchantId);
    const viewer = game.actors?.get?.(viewerId);
    const item = viewer?.items?.get?.(itemId);
    if (!merchant || !viewer || !item) throw new Error("merchant.sell: missing actor or item");

    const baseCp = priceToCopper(item.system?.price);
    const rate = getMerchantSellRate(merchant);
    const unitCp = Math.floor(baseCp * rate);
    if (unitCp <= 0) throw new Error("worthless");

    const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
    const sellQty = Math.max(1, Math.min(stockQty, Math.floor(qty) || 1));
    const totalCp = unitCp * sellQty;

    await addCoins(viewer, totalCp);
    await deductCoins(merchant, totalCp);

    const data = item.toObject();
    delete data._id;
    data.system = foundry.utils.duplicate(data.system);
    if (data.system.quantity != null) data.system.quantity = sellQty;
    await merchant.createEmbeddedDocuments("Item", [data]);

    if (stockQty > sellQty) await item.update({ "system.quantity": stockQty - sellQty });
    else await item.delete();
    return { ok: true, totalCp, qty: sellQty, name: item.name };
  });

  // --- Cart checkout: atomic bulk buy --------------------------------------
  registerHandler("merchant.checkout", async ({ merchantId, viewerId, lines }) => {
    const merchant = game.actors?.get?.(merchantId);
    const viewer = game.actors?.get?.(viewerId);
    if (!merchant || !viewer) throw new Error("merchant.checkout: missing actor");
    if (!Array.isArray(lines) || lines.length === 0) throw new Error("merchant.checkout: empty");

    let totalCp = 0;
    const itemsToCreate = [];
    const merchantUpdates = [];
    const merchantDeletes = [];
    const summary = [];
    const logEntries = [];

    for (const line of lines) {
      const item = merchant.items.get(line.itemId);
      if (!item) continue;
      const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
      const buyQty = Math.max(1, Math.min(stockQty, Math.floor(line.qty) || 1));
      const unitCp = effectiveItemPriceCp(item);
      const lineCp = unitCp * buyQty;
      totalCp += lineCp;
      summary.push({ name: item.name, qty: buyQty, cp: lineCp });
      // Capture data needed for the history entry BEFORE the item is mutated
      // or deleted below.
      logEntries.push({ name: item.name, img: item.img, qty: buyQty, cp: lineCp });

      const data = item.toObject();
      delete data._id;
      data.system = foundry.utils.duplicate(data.system);
      if (data.system.quantity != null) data.system.quantity = buyQty;
      if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
      itemsToCreate.push(data);
      if (stockQty > buyQty) merchantUpdates.push({ _id: item.id, "system.quantity": stockQty - buyQty });
      else merchantDeletes.push(item.id);
    }

    const buyerCp = priceToCopper({ value: readCoins(viewer) });
    if (buyerCp < totalCp) throw new Error("not_enough_gold");

    await deductCoins(viewer, totalCp);
    await addCoins(merchant, totalCp);
    if (itemsToCreate.length) await viewer.createEmbeddedDocuments("Item", itemsToCreate);
    if (merchantUpdates.length) await merchant.updateEmbeddedDocuments("Item", merchantUpdates);
    if (merchantDeletes.length) await merchant.deleteEmbeddedDocuments("Item", merchantDeletes);

    // One history entry per line so the GM sees the individual items, not
    // just an opaque "checkout" event. Sequential to avoid racing concurrent
    // actor.update calls on the same flag.
    for (const e of logEntries) {
      await recordMerchantTransaction(merchant, {
        kind: "buy",
        characterId: viewer.id, characterName: viewer.name,
        itemName: e.name, itemImg: e.img,
        qty: e.qty, cp: e.cp,
      });
    }

    return { ok: true, totalCp, lines: summary };
  });

  // --- Merchant ops (GM tools players might trigger) -------------------------
  registerHandler("merchant.setCoins", async ({ merchantId, coins }) => {
    const merchant = game.actors?.get?.(merchantId);
    if (!merchant) throw new Error("merchant.setCoins: missing actor");
    await setMerchantCoins(merchant, coins);
    return { ok: true, coins: readMerchantCoins(merchant) };
  });
}
