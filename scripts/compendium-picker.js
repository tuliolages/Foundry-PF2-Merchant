// Bulk-import items from any Item compendium pack into a merchant (Loot actor).
// GM-only. Filters by name, category, rarity, level, source pack.

import { MODULE_ID, formatCopper, priceToCopper, normalizeMerchantType } from "./merchant-store.js";

const ALLOWED_TYPES = new Set([
  "weapon", "armor", "shield", "consumable", "equipment", "treasure", "backpack",
  "ammunition", "ammo", "kit",
]);
const CATEGORY_CHIPS = [
  { value: "weapon",     icon: "fa-hammer",              labelKey: "PF2E_CINEMATIC_MERCHANT.cat.weapon" },
  { value: "armor",      icon: "fa-shirt",               labelKey: "PF2E_CINEMATIC_MERCHANT.cat.armor" },
  { value: "shield",     icon: "fa-shield-halved",       labelKey: "PF2E_CINEMATIC_MERCHANT.cat.shield" },
  { value: "consumable", icon: "fa-flask",               labelKey: "PF2E_CINEMATIC_MERCHANT.cat.consumable" },
  { value: "ammunition", icon: "fa-bolt-lightning",      labelKey: "PF2E_CINEMATIC_MERCHANT.cat.ammunition" },
  { value: "equipment",  icon: "fa-screwdriver-wrench",  labelKey: "PF2E_CINEMATIC_MERCHANT.cat.equipment" },
  { value: "treasure",   icon: "fa-gem",                 labelKey: "PF2E_CINEMATIC_MERCHANT.cat.treasure" },
  { value: "backpack",   icon: "fa-suitcase",            labelKey: "PF2E_CINEMATIC_MERCHANT.cat.container" },
  { value: "kit",        icon: "fa-toolbox",             labelKey: "PF2E_CINEMATIC_MERCHANT.cat.kit" },
];
const RARITIES = ["common", "uncommon", "rare", "unique"];

// Use the shared normalizer from merchant-store.js so all entry points
// classify ammo items identically.
const normalizeItemType = normalizeMerchantType;

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

function localizeCategory(slug) {
  const map = { weapon:"weapon", armor:"armor", shield:"shield", consumable:"consumable", equipment:"equipment", treasure:"treasure", backpack:"container" };
  const key = `PF2E_CINEMATIC_MERCHANT.cat.${map[slug] ?? slug}`;
  const v = game.i18n.localize(key);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function t(key) {
  const v = game.i18n.localize(key);
  return v && v !== key ? v : key.split(".").pop();
}

let _activePicker = null;

export async function openCompendiumPicker(targetActor, onImported) {
  if (_activePicker) _activePicker.close();
  _activePicker = new CompendiumPicker(targetActor, onImported);
  await _activePicker.open();
}

class CompendiumPicker {
  constructor(targetActor, onImported) {
    this.actor = targetActor;
    this.onImported = onImported;
    this.allItems = [];      // flat array { name, _id, type, system, img, packId, packName }
    this.filtered = [];
    this.selected = new Set(); // "packId.itemId"
    this.filters = {
      search: "",
      categories: new Set(CATEGORY_CHIPS.map(c => c.value)), // all enabled by default
      rarity: "all",
      levelMin: null,
      levelMax: null,
      pack: "all",
    };
    this.root = null;
    this.refs = {};
    this._loading = false;
  }

  async open() {
    this._buildModal();
    this.root.classList.add("is-active");
    await this._loadIndexes();
    this._refreshList();
  }

  close() {
    if (this.root) {
      this.root.classList.remove("is-active");
      setTimeout(() => { try { this.root.remove(); } catch {} }, 240);
    }
    if (_activePicker === this) _activePicker = null;
  }

  async _loadIndexes() {
    this._loading = true;
    if (this.refs.list) this.refs.list.innerHTML = `<div class="pf2e-cd-mer-picker-loading">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.loading"))}</div>`;
    const itemPacks = (game.packs ?? []).filter(p => p.metadata?.type === "Item" && p.visible !== false);
    this.allItems = [];
    const packOpts = [];

    for (const pack of itemPacks) {
      try {
        const idx = await pack.getIndex({ fields: [
          "system.price", "system.level.value", "system.traits.rarity",
          "system.traits.value", "system.category", "system.consumableType",
          "system.consumableType.value", "system.stackGroup",
          "type", "img",
        ]});
        const list = [...idx]
          .filter(it => ALLOWED_TYPES.has(normalizeItemType(it)))
          .map(it => ({
            ...it,
            type: normalizeItemType(it),
            packId: pack.collection,
            packName: pack.metadata.label ?? pack.collection,
          }));
        this.allItems.push(...list);
        if (list.length > 0) packOpts.push({ id: pack.collection, label: pack.metadata.label, count: list.length });
      } catch (err) {
        console.warn(`${MODULE_ID} | failed to index pack ${pack.collection}:`, err);
      }
    }

    // Populate pack filter
    if (this.refs.packSel) {
      const opts = [`<option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.allPacks"))} (${this.allItems.length})</option>`]
        .concat(packOpts.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.label)} (${p.count})</option>`));
      this.refs.packSel.innerHTML = opts.join("");
    }
    this._loading = false;
  }

  _filterItems() {
    const f = this.filters;
    this.filtered = this.allItems.filter(it => {
      if (f.pack !== "all" && it.packId !== f.pack) return false;
      if (f.search && !it.name.toLowerCase().includes(f.search)) return false;
      if (!f.categories.has(it.type)) return false;
      const r = it.system?.traits?.rarity ?? "common";
      if (f.rarity !== "all" && r !== f.rarity) return false;
      const lvl = Number(it.system?.level?.value ?? 0);
      if (f.levelMin != null && lvl < f.levelMin) return false;
      if (f.levelMax != null && lvl > f.levelMax) return false;
      return true;
    }).sort((a, b) => {
      const lvlA = Number(a.system?.level?.value ?? 0);
      const lvlB = Number(b.system?.level?.value ?? 0);
      if (lvlA !== lvlB) return lvlA - lvlB;
      return a.name.localeCompare(b.name);
    });
  }

  _refreshList() {
    if (this._loading) return;
    this._filterItems();
    if (!this.refs.list) return;
    if (this.filtered.length === 0) {
      this.refs.list.innerHTML = `<div class="pf2e-cd-mer-picker-empty">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.empty"))}</div>`;
    } else {
      // Cap rendering at 500 to keep DOM responsive; user can refine filters.
      const CAP = 500;
      const slice = this.filtered.slice(0, CAP);
      const rows = slice.map(it => this._renderRow(it)).join("");
      const note = this.filtered.length > CAP
        ? `<div class="pf2e-cd-mer-picker-cap">${game.i18n.format("PF2E_CINEMATIC_MERCHANT.picker.capped", { shown: CAP, total: this.filtered.length })}</div>`
        : "";
      this.refs.list.innerHTML = note + rows;
      // Wire row checkbox clicks
      for (const cb of this.refs.list.querySelectorAll(".pf2e-cd-mer-picker-row-cb")) {
        cb.addEventListener("change", (e) => this._toggleSelect(cb.dataset.key, e.target.checked));
      }
      for (const row of this.refs.list.querySelectorAll(".pf2e-cd-mer-picker-row")) {
        row.addEventListener("click", (e) => {
          if (e.target.tagName === "INPUT") return;
          const cb = row.querySelector(".pf2e-cd-mer-picker-row-cb");
          if (cb) {
            cb.checked = !cb.checked;
            this._toggleSelect(cb.dataset.key, cb.checked);
          }
        });
      }
    }
    this._refreshFooter();
  }

  _renderRow(it) {
    const key = `${it.packId}.${it._id ?? it.id}`;
    const checked = this.selected.has(key) ? "checked" : "";
    const lvl = Number(it.system?.level?.value ?? 0);
    const rarity = it.system?.traits?.rarity ?? "common";
    const priceCp = priceToCopper(it.system?.price);
    return `
      <label class="pf2e-cd-mer-picker-row rarity-${rarity}">
        <input type="checkbox" class="pf2e-cd-mer-picker-row-cb" data-key="${escapeHTML(key)}" ${checked} />
        <img class="pf2e-cd-mer-picker-row-img" src="${escapeHTML(it.img ?? "icons/svg/item-bag.svg")}" alt="" />
        <div class="pf2e-cd-mer-picker-row-main">
          <div class="pf2e-cd-mer-picker-row-name">${escapeHTML(it.name)}</div>
          <div class="pf2e-cd-mer-picker-row-meta">
            <span class="tag tag-cat">${escapeHTML(localizeCategory(it.type))}</span>
            <span class="tag tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="tag tag-level">L ${lvl}</span>
            <span class="tag tag-pack">${escapeHTML(it.packName)}</span>
          </div>
        </div>
        <div class="pf2e-cd-mer-picker-row-price">${formatCopper(priceCp)}</div>
      </label>
    `;
  }

  _toggleSelect(key, on) {
    if (on) this.selected.add(key);
    else this.selected.delete(key);
    this._refreshFooter();
  }

  _refreshFooter() {
    if (this.refs.count) {
      this.refs.count.textContent = game.i18n.format(
        "PF2E_CINEMATIC_MERCHANT.picker.selectionCount",
        { selected: this.selected.size, filtered: this.filtered.length }
      );
    }
    if (this.refs.importBtn) {
      this.refs.importBtn.disabled = this.selected.size === 0;
      this.refs.importBtn.querySelector(".count").textContent = String(this.selected.size);
    }
  }

  _buildModal() {
    if (this.root) try { this.root.remove(); } catch {}
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-picker-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;

    this.refs = {
      frame:       root.querySelector(".pf2e-cd-mer-picker-frame"),
      title:       root.querySelector(".pf2e-cd-mer-picker-title"),
      list:        root.querySelector(".pf2e-cd-mer-picker-list"),
      footer:      root.querySelector(".pf2e-cd-mer-picker-footer"),
      count:       root.querySelector(".pf2e-cd-mer-picker-count"),
      importBtn:   root.querySelector("[data-action=picker-import]"),
      closeBtn:    root.querySelector("[data-action=picker-close]"),
      selAllBtn:   root.querySelector("[data-action=picker-select-all]"),
      selNoneBtn:  root.querySelector("[data-action=picker-select-none]"),
      catAllBtn:   root.querySelector("[data-action=picker-cat-all]"),
      catNoneBtn:  root.querySelector("[data-action=picker-cat-none]"),
      catChips:    root.querySelectorAll(".pf2e-cd-mer-cat-chip"),
      search:      root.querySelector("[name=picker-search]"),
      raritySel:   root.querySelector("[name=picker-rarity]"),
      levelMin:    root.querySelector("[name=picker-level-min]"),
      levelMax:    root.querySelector("[name=picker-level-max]"),
      packSel:     root.querySelector("[name=picker-pack]"),
    };

    this.refs.title.textContent = game.i18n.format(
      "PF2E_CINEMATIC_MERCHANT.picker.title",
      { actor: this.actor.name }
    );
    this.refs.closeBtn.addEventListener("click", () => this.close());

    const debounced = this._debounce(() => this._refreshList(), 120);
    this.refs.search.addEventListener("input", () => { this.filters.search = this.refs.search.value.trim().toLowerCase(); debounced(); });
    this.refs.raritySel.addEventListener("change", () => { this.filters.rarity = this.refs.raritySel.value; this._refreshList(); });

    // Category chip toggles
    for (const chip of this.refs.catChips) {
      chip.addEventListener("click", () => this._toggleCategory(chip));
    }
    this.refs.catAllBtn.addEventListener("click", () => this._setAllCategories(true));
    this.refs.catNoneBtn.addEventListener("click", () => this._setAllCategories(false));
    this.refs.levelMin.addEventListener("input", () => { const v = this.refs.levelMin.value; this.filters.levelMin = v === "" ? null : Number(v); debounced(); });
    this.refs.levelMax.addEventListener("input", () => { const v = this.refs.levelMax.value; this.filters.levelMax = v === "" ? null : Number(v); debounced(); });
    this.refs.packSel.addEventListener("change", () => { this.filters.pack = this.refs.packSel.value; this._refreshList(); });

    this.refs.selAllBtn.addEventListener("click", () => this._selectAllVisible());
    this.refs.selNoneBtn.addEventListener("click", () => { this.selected.clear(); this._refreshList(); });
    this.refs.importBtn.addEventListener("click", () => this._importSelected());

    root.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }

  _toggleCategory(chip) {
    const cat = chip.dataset.cat;
    if (this.filters.categories.has(cat)) {
      this.filters.categories.delete(cat);
      chip.classList.remove("is-active");
    } else {
      this.filters.categories.add(cat);
      chip.classList.add("is-active");
    }
    this._refreshList();
  }

  _setAllCategories(on) {
    if (on) {
      for (const c of CATEGORY_CHIPS) this.filters.categories.add(c.value);
    } else {
      this.filters.categories.clear();
    }
    for (const chip of this.refs.catChips) {
      chip.classList.toggle("is-active", on);
    }
    this._refreshList();
  }

  _selectAllVisible() {
    for (const it of this.filtered) {
      const key = `${it.packId}.${it._id ?? it.id}`;
      this.selected.add(key);
    }
    this._refreshList();
  }

  async _importSelected() {
    if (this.selected.size === 0) return;
    this.refs.importBtn.disabled = true;
    const originalLabel = this.refs.importBtn.querySelector(".label").textContent;
    this.refs.importBtn.querySelector(".label").textContent = t("PF2E_CINEMATIC_MERCHANT.picker.importing");

    try {
      // Group selected by pack so we can fetch in batches
      const byPack = new Map();
      for (const key of this.selected) {
        const dot = key.indexOf(".");
        const dot2 = key.indexOf(".", dot + 1);
        const packId = key.slice(0, dot2);
        const itemId = key.slice(dot2 + 1);
        if (!byPack.has(packId)) byPack.set(packId, []);
        byPack.get(packId).push(itemId);
      }

      const allItemData = [];
      for (const [packId, itemIds] of byPack.entries()) {
        const pack = game.packs.get(packId);
        if (!pack) continue;
        const docs = await pack.getDocuments({ _id__in: itemIds }).catch(async () => {
          // Fallback if filter not supported: load each individually
          const out = [];
          for (const id of itemIds) {
            const d = await pack.getDocument(id).catch(() => null);
            if (d) out.push(d);
          }
          return out;
        });
        for (const d of docs) {
          if (!d) continue;
          allItemData.push(d.toObject());
        }
      }

      if (allItemData.length === 0) {
        ui.notifications?.warn(t("PF2E_CINEMATIC_MERCHANT.picker.noneResolved"));
        return;
      }

      // Bulk insert in chunks of 100 to be safe with large operations
      const CHUNK = 100;
      let created = 0;
      for (let i = 0; i < allItemData.length; i += CHUNK) {
        const slice = allItemData.slice(i, i + CHUNK);
        const result = await this.actor.createEmbeddedDocuments("Item", slice);
        created += result?.length ?? 0;
      }
      ui.notifications?.info(game.i18n.format("PF2E_CINEMATIC_MERCHANT.picker.imported", { count: created, actor: this.actor.name }));
      this.selected.clear();
      if (typeof this.onImported === "function") this.onImported();
      this.close();
    } catch (err) {
      console.warn(`${MODULE_ID} | import failed:`, err);
      ui.notifications?.error(t("PF2E_CINEMATIC_MERCHANT.picker.importFailed"));
    } finally {
      this.refs.importBtn.disabled = false;
      this.refs.importBtn.querySelector(".label").textContent = originalLabel;
    }
  }

  _debounce(fn, ms) {
    let h;
    return (...args) => { clearTimeout(h); h = setTimeout(() => fn.apply(this, args), ms); };
  }

  _html() {
    const rarOpts = `<option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.rarity.all"))}</option>` +
      RARITIES.map(r => `<option value="${r}">${escapeHTML(localizeRarity(r))}</option>`).join("");
    const catChips = CATEGORY_CHIPS.map(c => `
      <button type="button" class="pf2e-cd-mer-cat-chip is-active" data-cat="${c.value}">
        <i class="fa-solid ${c.icon}"></i>
        <span>${escapeHTML(t(c.labelKey))}</span>
      </button>
    `).join("");

    return `
      <div class="pf2e-cd-mer-picker-vignette"></div>
      <div class="pf2e-cd-mer-picker-frame">
        <button type="button" class="pf2e-cd-mer-picker-close" data-action="picker-close" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-picker-title"></div>
        <div class="pf2e-cd-mer-picker-cat-chips">
          ${catChips}
          <button type="button" class="pf2e-cd-mer-cat-chip-toggle" data-action="picker-cat-all"><i class="fa-solid fa-check-double"></i> ${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.allCats"))}</button>
          <button type="button" class="pf2e-cd-mer-cat-chip-toggle" data-action="picker-cat-none"><i class="fa-solid fa-eraser"></i> ${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.noCats"))}</button>
        </div>
        <div class="pf2e-cd-mer-picker-filters">
          <input type="text" name="picker-search" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
          <select name="picker-rarity">${rarOpts}</select>
          <input type="number" name="picker-level-min" min="0" max="25" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMin"))}" />
          <input type="number" name="picker-level-max" min="0" max="25" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMax"))}" />
          <select name="picker-pack"><option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.allPacks"))}</option></select>
        </div>
        <div class="pf2e-cd-mer-picker-actions">
          <button type="button" data-action="picker-select-all"><i class="fa-solid fa-check-double"></i> ${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.selectAll"))}</button>
          <button type="button" data-action="picker-select-none"><i class="fa-solid fa-eraser"></i> ${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.selectNone"))}</button>
        </div>
        <div class="pf2e-cd-mer-picker-list"></div>
        <div class="pf2e-cd-mer-picker-footer">
          <span class="pf2e-cd-mer-picker-count"></span>
          <button type="button" class="pf2e-cd-mer-picker-import" data-action="picker-import" disabled>
            <i class="fa-solid fa-circle-down"></i>
            <span class="label">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.importBtn"))}</span>
            (<span class="count">0</span>)
          </button>
        </div>
      </div>
    `;
  }
}
