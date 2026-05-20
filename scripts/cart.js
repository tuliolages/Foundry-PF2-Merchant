// Shopping-cart state for the current merchant session and a drawer modal
// that lets the player review, edit qty, and check out atomically.

import {
  MODULE_ID, effectiveItemPriceCp, formatCopper, priceToCopper, copperToCoins,
} from "./merchant-store.js";
import { makeDraggable } from "./draggable.js";

let _activeDrawer = null;

export class Cart {
  constructor() {
    this.items = new Map(); // itemId -> qty
  }

  clear() { this.items.clear(); }

  add(itemId, qty = 1) {
    if (!itemId || qty < 1) return;
    this.items.set(itemId, (this.items.get(itemId) ?? 0) + qty);
  }

  set(itemId, qty) {
    if (qty <= 0) { this.items.delete(itemId); return; }
    this.items.set(itemId, qty);
  }

  remove(itemId) { this.items.delete(itemId); }

  has(itemId) { return this.items.has(itemId); }

  size() {
    let n = 0;
    for (const q of this.items.values()) n += q;
    return n;
  }

  totalCp(merchantActor) {
    let total = 0;
    for (const [id, qty] of this.items.entries()) {
      const item = merchantActor?.items?.get?.(id);
      if (!item) continue;
      total += effectiveItemPriceCp(item) * qty;
    }
    return total;
  }

  // Returns array of { item, qty, unitCp, lineCp }, dropping items that vanished.
  resolve(merchantActor) {
    const out = [];
    for (const [id, qty] of this.items.entries()) {
      const item = merchantActor?.items?.get?.(id);
      if (!item) continue;
      const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
      const effQty = Math.min(qty, stockQty);
      if (effQty < 1) continue;
      const unitCp = effectiveItemPriceCp(item);
      out.push({ item, qty: effQty, stockQty, unitCp, lineCp: unitCp * effQty });
    }
    return out;
  }

  // Trim to current stock so totals stay correct after merchant updates.
  reconcile(merchantActor) {
    for (const [id, qty] of [...this.items.entries()]) {
      const item = merchantActor?.items?.get?.(id);
      if (!item) { this.items.delete(id); continue; }
      const stockQty = Math.max(0, Number(item.system?.quantity ?? 1));
      if (stockQty === 0) { this.items.delete(id); continue; }
      if (qty > stockQty) this.items.set(id, stockQty);
    }
  }
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

export function openCartDrawer(cart, merchantActor, viewerActor, opts = {}) {
  if (_activeDrawer) _activeDrawer.close();
  _activeDrawer = new CartDrawer(cart, merchantActor, viewerActor, opts);
  _activeDrawer.open();
}

class CartDrawer {
  constructor(cart, merchantActor, viewerActor, opts) {
    this.cart = cart;
    this.merchant = merchantActor;
    this.viewer = viewerActor;
    this.onCheckout = opts.onCheckout ?? null; // async (lines) => void
    this.onChanged = opts.onChanged ?? null;
    this.root = null;
    this._busy = false;
  }

  open() {
    this._build();
    this.root.classList.add("is-active");
    this._render();
  }

  close() {
    if (!this.root) return;
    this.root.classList.remove("is-active");
    setTimeout(() => { try { this.root.remove(); } catch {} }, 220);
    if (_activeDrawer === this) _activeDrawer = null;
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-cart-root";
    root.innerHTML = `
      <div class="pf2e-cd-mer-cart-vignette"></div>
      <div class="pf2e-cd-mer-cart-frame">
        <button type="button" class="pf2e-cd-mer-cart-close" data-action="close" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-cart-header">
          <i class="fa-solid fa-basket-shopping"></i>
          <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.title"))}</span>
        </div>
        <div class="pf2e-cd-mer-cart-list"></div>
        <div class="pf2e-cd-mer-cart-empty" hidden>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.empty"))}</div>
        <div class="pf2e-cd-mer-cart-footer">
          <div class="pf2e-cd-mer-cart-total"></div>
          <div class="pf2e-cd-mer-cart-actions">
            <button type="button" class="pf2e-cd-mer-cart-clear" data-action="cart-clear">
              <i class="fa-solid fa-broom"></i> ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.clear"))}
            </button>
            <button type="button" class="pf2e-cd-mer-cart-checkout" data-action="cart-checkout">
              <i class="fa-solid fa-coins"></i> <span class="label">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.checkout"))}</span>
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    root.querySelector("[data-action=close]").addEventListener("click", () => this.close());
    root.querySelector(".pf2e-cd-mer-cart-vignette").addEventListener("click", () => this.close());
    makeDraggable(
      root.querySelector(".pf2e-cd-mer-cart-frame"),
      root.querySelector(".pf2e-cd-mer-cart-header"),
      "cart"
    );
    root.querySelector("[data-action=cart-clear]").addEventListener("click", () => {
      this.cart.clear();
      this.onChanged?.();
      this._render();
    });
    root.querySelector("[data-action=cart-checkout]").addEventListener("click", () => this._checkout());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.root?.classList.contains("is-active")) this.close(); });
  }

  _render() {
    if (!this.root) return;
    this.cart.reconcile(this.merchant);
    const lines = this.cart.resolve(this.merchant);
    const list = this.root.querySelector(".pf2e-cd-mer-cart-list");
    const empty = this.root.querySelector(".pf2e-cd-mer-cart-empty");
    const total = lines.reduce((s, l) => s + l.lineCp, 0);
    const checkoutBtn = this.root.querySelector("[data-action=cart-checkout]");
    const totalEl = this.root.querySelector(".pf2e-cd-mer-cart-total");

    if (lines.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      totalEl.innerHTML = "";
      checkoutBtn.disabled = true;
      return;
    }
    empty.hidden = true;
    list.innerHTML = lines.map(l => this._row(l)).join("");
    totalEl.innerHTML = `
      <span class="pf2e-cd-mer-cart-total-label">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.total"))}</span>
      <span class="pf2e-cd-mer-cart-total-value">${escapeHTML(formatCopper(total))}</span>
    `;

    // Affordability check — disable checkout if viewer can't pay
    const buyerCp = this._buyerCp();
    const canAfford = buyerCp >= total;
    checkoutBtn.disabled = this._busy || !canAfford;
    if (!canAfford) {
      checkoutBtn.title = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.notEnoughGold");
      this.root.querySelector(".pf2e-cd-mer-cart-frame").classList.add("is-broke");
    } else {
      checkoutBtn.title = "";
      this.root.querySelector(".pf2e-cd-mer-cart-frame").classList.remove("is-broke");
    }

    // Wire row controls
    for (const minus of list.querySelectorAll("[data-action=line-minus]")) {
      minus.addEventListener("click", () => this._adjust(minus.dataset.itemId, -1));
    }
    for (const plus of list.querySelectorAll("[data-action=line-plus]")) {
      plus.addEventListener("click", () => this._adjust(plus.dataset.itemId, +1));
    }
    for (const rm of list.querySelectorAll("[data-action=line-remove]")) {
      rm.addEventListener("click", () => {
        this.cart.remove(rm.dataset.itemId);
        this.onChanged?.();
        this._render();
      });
    }
  }

  _adjust(itemId, delta) {
    const cur = this.cart.items.get(itemId) ?? 0;
    const item = this.merchant.items.get(itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === 0) this.cart.remove(itemId);
    else this.cart.set(itemId, next);
    this.onChanged?.();
    this._render();
  }

  _row(line) {
    const { item, qty, stockQty, unitCp, lineCp } = line;
    const rarity = item.system?.traits?.rarity ?? "common";
    return `
      <div class="pf2e-cd-mer-cart-row rarity-${rarity}" data-item-id="${item.id}">
        <img class="pf2e-cd-mer-cart-row-img" src="${escapeHTML(item.img ?? "icons/svg/item-bag.svg")}" alt="" />
        <div class="pf2e-cd-mer-cart-row-info">
          <div class="pf2e-cd-mer-cart-row-name">${escapeHTML(item.name)}</div>
          <div class="pf2e-cd-mer-cart-row-unit">${escapeHTML(formatCopper(unitCp))} ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.each"))}</div>
        </div>
        <div class="pf2e-cd-mer-cart-row-qty">
          <button type="button" data-action="line-minus" data-item-id="${item.id}">−</button>
          <span>${qty}</span>
          <button type="button" data-action="line-plus" data-item-id="${item.id}" ${qty >= stockQty ? "disabled" : ""}>+</button>
        </div>
        <div class="pf2e-cd-mer-cart-row-line">${escapeHTML(formatCopper(lineCp))}</div>
        <button type="button" class="pf2e-cd-mer-cart-row-remove" data-action="line-remove" data-item-id="${item.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cart.removeItem"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;
  }

  _buyerCp() {
    if (!this.viewer) return 0;
    const inv = this.viewer.inventory?.coins;
    const sys = inv && (inv.pp != null || inv.gp != null || inv.sp != null || inv.cp != null)
      ? inv
      : (this.viewer.system?.coins ?? this.viewer.system?.currency ?? {});
    return priceToCopper({ value: { pp: sys.pp ?? 0, gp: sys.gp ?? 0, sp: sys.sp ?? 0, cp: sys.cp ?? 0 } });
  }

  async _checkout() {
    if (this._busy) return;
    const lines = this.cart.resolve(this.merchant);
    if (lines.length === 0) return;
    this._busy = true;
    const btn = this.root.querySelector("[data-action=cart-checkout]");
    btn.disabled = true;
    try {
      if (typeof this.onCheckout === "function") {
        await this.onCheckout(lines);
      }
      this.cart.clear();
      this.onChanged?.();
      this.close();
    } catch (err) {
      console.warn(`${MODULE_ID} | cart checkout failed:`, err);
      ui.notifications?.error(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.buyFailed"));
    } finally {
      this._busy = false;
    }
  }
}
