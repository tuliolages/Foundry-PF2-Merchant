// Per-character private "vault" — serialized item snapshots stored as a flag
// on the character actor. Players can stash and retrieve items from any
// merchant window. No extra Loot actor / GM intervention required, since
// players own their own characters and can update their own flags.

import { MODULE_ID, formatCopper, formatCopperHtml, priceToCopper, isCoinItem } from "./merchant-store.js";
import { playVault } from "./sound-fx.js";

const FLAG = "vault";

const VAULTABLE_TYPES = new Set([
  "weapon", "armor", "shield", "consumable", "equipment", "treasure", "backpack",
  "ammunition", "ammo", "kit",
]);

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function localizeRarity(r) {
  const v = game.i18n.localize(`PF2E_CINEMATIC_MERCHANT.rarity.${r}`);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// --- Data layer ---

export function readVault(character) {
  if (!character) return [];
  const v = character.getFlag?.(MODULE_ID, FLAG);
  return Array.isArray(v) ? [...v] : [];
}

async function writeVault(character, list) {
  if (!character) return;
  await character.setFlag(MODULE_ID, FLAG, list);
}

export function vaultCount(character) {
  return readVault(character).length;
}

export async function depositItem(character, item, qty = null) {
  if (!character || !item) return;
  if (item.parent?.id !== character.id) return;
  if (!VAULTABLE_TYPES.has(item.type)) {
    ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.cannotVault"));
    return;
  }
  const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
  const moveQty = qty == null
    ? stockQty
    : Math.max(1, Math.min(stockQty, Math.floor(qty) || 1));

  const data = item.toObject();
  delete data._id;
  data.system = foundry.utils.duplicate(data.system);
  if (data.system.quantity != null) data.system.quantity = moveQty;
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
  data._vaultKey = foundry.utils.randomID();

  const list = readVault(character);
  list.push(data);
  await writeVault(character, list);

  if (stockQty > moveQty) {
    await item.update({ "system.quantity": stockQty - moveQty });
  } else {
    await item.delete();
  }
  playVault();
}

export async function withdrawItem(character, vaultKey, qty = null) {
  if (!character) return;
  const list = readVault(character);
  const idx = list.findIndex(e => e._vaultKey === vaultKey);
  if (idx < 0) return;
  const entry = list[idx];
  const stockQty = Math.max(1, Number(entry.system?.quantity ?? 1));
  const moveQty = qty == null
    ? stockQty
    : Math.max(1, Math.min(stockQty, Math.floor(qty) || 1));

  const out = foundry.utils.duplicate(entry);
  delete out._vaultKey;
  if (out.system?.quantity != null) out.system.quantity = moveQty;
  await character.createEmbeddedDocuments("Item", [out]);

  if (stockQty > moveQty) {
    list[idx] = foundry.utils.duplicate(entry);
    list[idx].system.quantity = stockQty - moveQty;
  } else {
    list.splice(idx, 1);
  }
  await writeVault(character, list);
  playVault();
}

// --- UI ---

let _activeModal = null;

export function openVault(character) {
  if (!character) return;
  if (_activeModal) _activeModal.close();
  _activeModal = new VaultModal(character);
  _activeModal.open();
}

class VaultModal {
  constructor(character) {
    this.character = character;
    this.root = null;
    this.search = "";
    this._hookIds = [];
    this._busy = false;
  }

  open() {
    this._build();
    this.root.classList.add("is-active");
    this._render();
    const refresh = (it) => { if (it.parent?.id === this.character.id) this._render(); };
    this._hookIds.push(["createItem", Hooks.on("createItem", refresh)]);
    this._hookIds.push(["deleteItem", Hooks.on("deleteItem", refresh)]);
    this._hookIds.push(["updateItem", Hooks.on("updateItem", refresh)]);
    this._hookIds.push(["updateActor", Hooks.on("updateActor", (a) => { if (a.id === this.character.id) this._render(); })]);
  }

  close() {
    if (!this.root) return;
    this.root.classList.remove("is-active");
    setTimeout(() => { try { this.root.remove(); } catch {} }, 220);
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    if (_activeModal === this) _activeModal = null;
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-vault-root";
    root.innerHTML = `
      <div class="pf2e-cd-mer-vault-vignette"></div>
      <div class="pf2e-cd-mer-vault-frame">
        <button type="button" class="pf2e-cd-mer-vault-close" data-action="close" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-vault-header">
          <i class="fa-solid fa-vault"></i>
          <div>
            <div class="pf2e-cd-mer-vault-title">${escapeHTML(game.i18n.format("PF2E_CINEMATIC_MERCHANT.vault.title", { name: this.character.name }))}</div>
            <div class="pf2e-cd-mer-vault-sub">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.sub"))}</div>
          </div>
        </div>
        <div class="pf2e-cd-mer-vault-search-row">
          <input type="text" name="vault-search" placeholder="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
        </div>
        <div class="pf2e-cd-mer-vault-body">
          <div class="pf2e-cd-mer-vault-pane pf2e-cd-mer-vault-pane-inv">
            <div class="pf2e-cd-mer-vault-pane-title">
              <i class="fa-solid fa-arrow-right"></i>
              ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.depositTitle"))}
            </div>
            <div class="pf2e-cd-mer-vault-list pf2e-cd-mer-vault-list-inv"></div>
            <div class="pf2e-cd-mer-vault-empty pf2e-cd-mer-vault-empty-inv" hidden>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.invEmpty"))}</div>
          </div>
          <div class="pf2e-cd-mer-vault-pane pf2e-cd-mer-vault-pane-vault">
            <div class="pf2e-cd-mer-vault-pane-title">
              <i class="fa-solid fa-arrow-left"></i>
              ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.withdrawTitle"))}
            </div>
            <div class="pf2e-cd-mer-vault-list pf2e-cd-mer-vault-list-vault"></div>
            <div class="pf2e-cd-mer-vault-empty pf2e-cd-mer-vault-empty-vault" hidden>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.vaultEmpty"))}</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    root.querySelector("[data-action=close]").addEventListener("click", () => this.close());
    root.querySelector(".pf2e-cd-mer-vault-vignette").addEventListener("click", () => this.close());
    const searchInput = root.querySelector("[name=vault-search]");
    searchInput.addEventListener("input", () => {
      this.search = searchInput.value.trim().toLowerCase();
      this._render();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root?.classList.contains("is-active")) this.close();
    });
  }

  _matchesSearch(name) {
    if (!this.search) return true;
    return String(name ?? "").toLowerCase().includes(this.search);
  }

  _render() {
    if (!this.root) return;
    this._renderInventory();
    this._renderVault();
  }

  _renderInventory() {
    const list = this.root.querySelector(".pf2e-cd-mer-vault-list-inv");
    const empty = this.root.querySelector(".pf2e-cd-mer-vault-empty-inv");
    const items = [...(this.character.items ?? [])]
      .filter(i => VAULTABLE_TYPES.has(i.type))
      .filter(i => !isCoinItem(i))
      .filter(i => this._matchesSearch(i.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = items.map(i => this._renderInvRow(i)).join("");
    for (const minus of list.querySelectorAll("[data-action=qty-minus]")) {
      minus.addEventListener("click", (e) => { e.stopPropagation(); this._adjustInvQty(minus.dataset.itemId, -1); });
    }
    for (const plus of list.querySelectorAll("[data-action=qty-plus]")) {
      plus.addEventListener("click", (e) => { e.stopPropagation(); this._adjustInvQty(plus.dataset.itemId, +1); });
    }
    for (const btn of list.querySelectorAll("[data-action=deposit]")) {
      btn.addEventListener("click", async () => {
        if (this._busy) return;
        const id = btn.dataset.itemId;
        const item = this.character.items.get(id);
        if (!item) return;
        const qty = this._readInvQty(id);
        this._busy = true;
        btn.disabled = true;
        try { await depositItem(this.character, item, qty); }
        catch (err) { console.warn(`${MODULE_ID} | deposit failed:`, err); }
        finally { this._busy = false; }
      });
    }
  }

  _renderVault() {
    const list = this.root.querySelector(".pf2e-cd-mer-vault-list-vault");
    const empty = this.root.querySelector(".pf2e-cd-mer-vault-empty-vault");
    const entries = readVault(this.character)
      .filter(e => this._matchesSearch(e.name))
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    if (entries.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = entries.map(e => this._renderVaultRow(e)).join("");
    for (const minus of list.querySelectorAll("[data-action=qty-minus-v]")) {
      minus.addEventListener("click", (e) => { e.stopPropagation(); this._adjustVaultQty(minus.dataset.vaultKey, -1); });
    }
    for (const plus of list.querySelectorAll("[data-action=qty-plus-v]")) {
      plus.addEventListener("click", (e) => { e.stopPropagation(); this._adjustVaultQty(plus.dataset.vaultKey, +1); });
    }
    for (const btn of list.querySelectorAll("[data-action=withdraw]")) {
      btn.addEventListener("click", async () => {
        if (this._busy) return;
        const key = btn.dataset.vaultKey;
        const qty = this._readVaultQty(key);
        this._busy = true;
        btn.disabled = true;
        try { await withdrawItem(this.character, key, qty); }
        catch (err) { console.warn(`${MODULE_ID} | withdraw failed:`, err); }
        finally { this._busy = false; }
      });
    }
  }

  _renderInvRow(item) {
    const qty = Math.max(1, Number(item.system?.quantity ?? 1));
    const lvl = Number(item.system?.level?.value ?? 0);
    const rarity = item.system?.traits?.rarity ?? "common";
    const priceCp = priceToCopper(item.system?.price);
    const qtySel = qty > 1 ? `
      <div class="pf2e-cd-mer-qty">
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-minus" data-item-id="${item.id}" tabindex="-1">−</button>
        <input type="number" class="pf2e-cd-mer-qty-input" data-role="vault-inv-qty" data-item-id="${item.id}" value="1" min="1" max="${qty}" />
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-plus" data-item-id="${item.id}" tabindex="-1">+</button>
      </div>` : "";
    return `
      <div class="pf2e-cd-mer-vault-row rarity-${rarity}">
        <img class="pf2e-cd-mer-vault-row-img" src="${escapeHTML(item.img ?? "icons/svg/item-bag.svg")}" alt="" />
        <div class="pf2e-cd-mer-vault-row-info">
          <div class="pf2e-cd-mer-vault-row-name">${escapeHTML(item.name)}</div>
          <div class="pf2e-cd-mer-vault-row-meta">
            <span class="tag tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="tag tag-level">L ${lvl}</span>
            ${qty > 1 ? `<span class="tag tag-qty">×${qty}</span>` : ""}
            ${priceCp > 0 ? `<span class="tag tag-price">${formatCopperHtml(priceCp)}</span>` : ""}
          </div>
        </div>
        ${qtySel}
        <button type="button" class="pf2e-cd-mer-vault-deposit-btn" data-action="deposit" data-item-id="${item.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.depositBtn"))}">
          <i class="fa-solid fa-arrow-right"></i>
        </button>
      </div>
    `;
  }

  _renderVaultRow(entry) {
    const qty = Math.max(1, Number(entry.system?.quantity ?? 1));
    const lvl = Number(entry.system?.level?.value ?? 0);
    const rarity = entry.system?.traits?.rarity ?? "common";
    const priceCp = priceToCopper(entry.system?.price);
    const qtySel = qty > 1 ? `
      <div class="pf2e-cd-mer-qty">
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-minus-v" data-vault-key="${entry._vaultKey}" tabindex="-1">−</button>
        <input type="number" class="pf2e-cd-mer-qty-input" data-role="vault-vault-qty" data-vault-key="${entry._vaultKey}" value="1" min="1" max="${qty}" />
        <button type="button" class="pf2e-cd-mer-qty-btn" data-action="qty-plus-v" data-vault-key="${entry._vaultKey}" tabindex="-1">+</button>
      </div>` : "";
    return `
      <div class="pf2e-cd-mer-vault-row rarity-${rarity}">
        <button type="button" class="pf2e-cd-mer-vault-withdraw-btn" data-action="withdraw" data-vault-key="${entry._vaultKey}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.vault.withdrawBtn"))}">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        ${qtySel}
        <div class="pf2e-cd-mer-vault-row-info">
          <div class="pf2e-cd-mer-vault-row-name">${escapeHTML(entry.name ?? "?")}</div>
          <div class="pf2e-cd-mer-vault-row-meta">
            <span class="tag tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="tag tag-level">L ${lvl}</span>
            ${qty > 1 ? `<span class="tag tag-qty">×${qty}</span>` : ""}
            ${priceCp > 0 ? `<span class="tag tag-price">${formatCopperHtml(priceCp)}</span>` : ""}
          </div>
        </div>
        <img class="pf2e-cd-mer-vault-row-img" src="${escapeHTML(entry.img ?? "icons/svg/item-bag.svg")}" alt="" />
      </div>
    `;
  }

  _readInvQty(itemId) {
    const input = this.root.querySelector(`[data-role=vault-inv-qty][data-item-id="${itemId}"]`);
    if (!input) return null;
    const v = Math.floor(Number(input.value)) || 1;
    return Math.max(1, v);
  }
  _adjustInvQty(itemId, delta) {
    const input = this.root.querySelector(`[data-role=vault-inv-qty][data-item-id="${itemId}"]`);
    if (!input) return;
    const item = this.character.items.get(itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value)) || 1;
    v = Math.max(1, Math.min(max, v + delta));
    input.value = String(v);
  }
  _readVaultQty(vaultKey) {
    const input = this.root.querySelector(`[data-role=vault-vault-qty][data-vault-key="${vaultKey}"]`);
    if (!input) return null;
    const v = Math.floor(Number(input.value)) || 1;
    return Math.max(1, v);
  }
  _adjustVaultQty(vaultKey, delta) {
    const input = this.root.querySelector(`[data-role=vault-vault-qty][data-vault-key="${vaultKey}"]`);
    if (!input) return;
    const list = readVault(this.character);
    const entry = list.find(e => e._vaultKey === vaultKey);
    const max = Math.max(1, Number(entry?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value)) || 1;
    v = Math.max(1, Math.min(max, v + delta));
    input.value = String(v);
  }
}
