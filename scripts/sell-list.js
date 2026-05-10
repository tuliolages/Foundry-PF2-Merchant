// Modal listing the player's inventory with Sell buttons per item.

import { MODULE_ID, priceToCopper, formatCopper, getMerchantSellRate, isCoinItem } from "./merchant-store.js";

const SELLABLE_TYPES = new Set([
  "weapon", "armor", "shield", "consumable", "equipment", "treasure", "backpack",
  "ammunition", "ammo", "kit",
]);

let _activeModal = null;

export function openSellList(viewer, merchant, onSell) {
  if (_activeModal) _activeModal.close();
  _activeModal = new SellListModal(viewer, merchant, onSell);
  _activeModal.open();
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function t(key) {
  const v = game.i18n?.localize?.(key);
  return v && v !== key && !v.startsWith("PF2E_CINEMATIC_MERCHANT.") ? v : key.split(".").pop();
}

function localizeRarity(r) {
  const v = game.i18n.localize(`PF2E_CINEMATIC_MERCHANT.rarity.${r}`);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function localizeCategory(slug) {
  const map = { weapon:"weapon", armor:"armor", shield:"shield", consumable:"consumable", equipment:"equipment", treasure:"treasure", backpack:"container", ammunition:"ammunition", ammo:"ammunition", kit:"kit" };
  const key = `PF2E_CINEMATIC_MERCHANT.cat.${map[slug] ?? slug}`;
  const v = game.i18n.localize(key);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

class SellListModal {
  constructor(viewer, merchant, onSell) {
    this.viewer = viewer;
    this.merchant = merchant;
    this.onSell = onSell;
    this.root = null;
    this.refs = null;
    this.search = "";
    this._onEsc = null;
    this._actorHookId = null;
  }

  async open() {
    this._build();
    this.root.classList.add("is-active");
    this._renderList();
    // Re-render on viewer inventory change so list stays current after each sale.
    this._actorHookId = Hooks.on("createItem", (it) => {
      if (it.parent?.id === this.viewer.id || it.parent?.id === this.merchant.id) this._renderList();
    });
    this._actorHookId2 = Hooks.on("deleteItem", (it) => {
      if (it.parent?.id === this.viewer.id || it.parent?.id === this.merchant.id) this._renderList();
    });
    this._actorHookId3 = Hooks.on("updateItem", (it) => {
      if (it.parent?.id === this.viewer.id || it.parent?.id === this.merchant.id) this._renderList();
    });
  }

  close() {
    if (!this.root) return;
    this.root.classList.remove("is-active");
    setTimeout(() => { try { this.root.remove(); } catch {} }, 240);
    if (this._onEsc) { document.removeEventListener("keydown", this._onEsc); this._onEsc = null; }
    if (this._actorHookId)  Hooks.off("createItem", this._actorHookId);
    if (this._actorHookId2) Hooks.off("deleteItem", this._actorHookId2);
    if (this._actorHookId3) Hooks.off("updateItem", this._actorHookId3);
    if (_activeModal === this) _activeModal = null;
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-sell-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;
    this.refs = {
      closeBtn:   root.querySelector("[data-action=close]"),
      search:     root.querySelector("[name=sell-search]"),
      list:       root.querySelector(".pf2e-cd-mer-sell-list"),
      empty:      root.querySelector(".pf2e-cd-mer-sell-empty"),
      vignette:   root.querySelector(".pf2e-cd-mer-sell-vignette"),
      rateLabel:  root.querySelector(".pf2e-cd-mer-sell-rate"),
    };
    this.refs.closeBtn.addEventListener("click", () => this.close());
    this.refs.vignette.addEventListener("click", () => this.close());
    this.refs.search.addEventListener("input", () => {
      this.search = this.refs.search.value.trim().toLowerCase();
      this._renderList();
    });
    document.addEventListener("keydown", this._onEsc = (e) => { if (e.key === "Escape") this.close(); });

    const rate = getMerchantSellRate(this.merchant);
    this.refs.rateLabel.textContent = game.i18n.format(
      "PF2E_CINEMATIC_MERCHANT.sell.rateInfo",
      { rate: Math.round(rate * 100) }
    );
  }

  _renderList() {
    if (!this.refs?.list) return;
    const items = this._collectSellableItems();
    if (items.length === 0) {
      this.refs.list.innerHTML = "";
      this.refs.empty.hidden = false;
      return;
    }
    this.refs.empty.hidden = true;
    this.refs.list.innerHTML = items.map(it => this._renderRow(it)).join("");
    for (const minus of this.refs.list.querySelectorAll("[data-action=qty-minus]")) {
      minus.addEventListener("click", (e) => {
        e.stopPropagation();
        this._adjustQty(minus.dataset.itemId, -1);
      });
    }
    for (const plus of this.refs.list.querySelectorAll("[data-action=qty-plus]")) {
      plus.addEventListener("click", (e) => {
        e.stopPropagation();
        this._adjustQty(plus.dataset.itemId, +1);
      });
    }
    for (const input of this.refs.list.querySelectorAll("[data-role=qty-input]")) {
      input.addEventListener("change", () => this._sanitizeQty(input));
      input.addEventListener("click", (e) => e.stopPropagation());
    }
    for (const btn of this.refs.list.querySelectorAll("[data-action=sell]")) {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const itemId = btn.dataset.itemId;
        const item = this.viewer.items.get(itemId);
        const qty = this._readQty(itemId);
        try {
          if (item && this.onSell) await this.onSell(item, qty);
        } catch (err) {
          console.warn(`${MODULE_ID} | sell failed:`, err);
        } finally {
          // Always re-enable, even if the button is still in the DOM (cancel
          // path doesn't trigger a re-render via item hooks).
          btn.disabled = false;
          this._renderList();
        }
      });
    }
  }

  _readQty(itemId) {
    const input = this.refs.list.querySelector(`[data-role=qty-input][data-item-id="${itemId}"]`);
    if (!input) return 1;
    return Math.max(1, Math.floor(Number(input.value)) || 1);
  }

  _sanitizeQty(input) {
    const item = this.viewer.items.get(input.dataset.itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value));
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > max) v = max;
    input.value = String(v);
  }

  _adjustQty(itemId, delta) {
    const input = this.refs.list.querySelector(`[data-role=qty-input][data-item-id="${itemId}"]`);
    if (!input) return;
    const item = this.viewer.items.get(itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value)) || 1;
    v = Math.max(1, Math.min(max, v + delta));
    input.value = String(v);
  }

  _collectSellableItems() {
    const out = [];
    for (const item of this.viewer.items ?? []) {
      if (!SELLABLE_TYPES.has(item.type)) continue;
      if (isCoinItem(item)) continue; // PF2E currency lives in inventory.coins, not as sellable goods
      const baseCp = priceToCopper(item.system?.price);
      if (baseCp <= 0) continue; // Worthless = can't sell
      if (this.search && !item.name.toLowerCase().includes(this.search)) continue;
      out.push(item);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  _renderRow(item) {
    const baseCp = priceToCopper(item.system?.price);
    const rate = getMerchantSellRate(this.merchant);
    const sellCp = Math.floor(baseCp * rate);
    const qty = Number(item.system?.quantity ?? 1);
    const lvl = Number(item.system?.level?.value ?? 0);
    const rarity = item.system?.traits?.rarity ?? "common";
    const qtySelector = qty > 1 ? `
      <div class="pf2e-cd-mer-qty">
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-minus" data-item-id="${item.id}" tabindex="-1">−</button>
        <input type="number" class="pf2e-cd-mer-qty-input" data-role="qty-input" data-item-id="${item.id}" value="1" min="1" max="${qty}" />
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-plus" data-item-id="${item.id}" tabindex="-1">+</button>
      </div>` : "";
    return `
      <div class="pf2e-cd-mer-sell-row rarity-${rarity}">
        <img class="pf2e-cd-mer-sell-row-img" src="${escapeHTML(item.img ?? "icons/svg/item-bag.svg")}" alt="" />
        <div class="pf2e-cd-mer-sell-row-info">
          <div class="pf2e-cd-mer-sell-row-name">${escapeHTML(item.name)}</div>
          <div class="pf2e-cd-mer-sell-row-meta">
            <span class="tag tag-cat">${escapeHTML(localizeCategory(item.type))}</span>
            <span class="tag tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="tag tag-level">L ${lvl}</span>
            ${qty > 1 ? `<span class="tag tag-qty">×${qty}</span>` : ""}
          </div>
        </div>
        <div class="pf2e-cd-mer-sell-row-price">${formatCopper(sellCp)}</div>
        ${qtySelector}
        <button type="button" class="pf2e-cd-mer-sell-row-btn" data-action="sell" data-item-id="${item.id}">
          <i class="fa-solid fa-coins"></i>
          <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.sell.sellBtn"))}</span>
        </button>
      </div>
    `;
  }

  _html() {
    return `
      <div class="pf2e-cd-mer-sell-vignette"></div>
      <div class="pf2e-cd-mer-sell-frame">
        <button type="button" class="pf2e-cd-mer-sell-close" data-action="close" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-sell-header">
          <div class="pf2e-cd-mer-sell-subtitle">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.sell.subtitle"))}</div>
          <div class="pf2e-cd-mer-sell-title">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.sell.title"))}</div>
          <div class="pf2e-cd-mer-sell-rate"></div>
        </div>
        <div class="pf2e-cd-mer-sell-search-row">
          <input type="text" name="sell-search" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
        </div>
        <div class="pf2e-cd-mer-sell-list"></div>
        <div class="pf2e-cd-mer-sell-empty" hidden>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.sell.empty"))}</div>
      </div>
    `;
  }
}
