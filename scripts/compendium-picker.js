// Bulk-import items from any Item compendium pack into a merchant (Loot actor).
// GM-only. Filters by name, category, rarity, level, source pack.

import { MODULE_ID, formatCopper, priceToCopper, normalizeMerchantType } from "./merchant-store.js";
import { makeDraggable } from "./draggable.js";

function prettifySlug(slug) {
  if (!slug) return "";
  return String(slug)
    .replace(/-/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

const ALLOWED_TYPES = new Set([
  "weapon", "armor", "shield", "consumable", "equipment", "treasure", "backpack",
  "ammunition", "ammo", "kit",
]);
const CATEGORY_CHIPS = [
  { value: "weapon",     icon: "fa-hammer",              labelKey: "PF2E_CINEMATIC_MERCHANT.cat.weapon" },
  { value: "armor",      icon: "fa-vest",                labelKey: "PF2E_CINEMATIC_MERCHANT.cat.armor" },
  { value: "shield",     icon: "fa-shield-halved",       labelKey: "PF2E_CINEMATIC_MERCHANT.cat.shield" },
  { value: "consumable", icon: "fa-flask",               labelKey: "PF2E_CINEMATIC_MERCHANT.cat.consumable" },
  { value: "ammunition", icon: "fa-feather-pointed",     labelKey: "PF2E_CINEMATIC_MERCHANT.cat.ammunition" },
  { value: "equipment",  icon: "fa-cubes-stacked",       labelKey: "PF2E_CINEMATIC_MERCHANT.cat.equipment" },
  { value: "treasure",   icon: "fa-gem",                 labelKey: "PF2E_CINEMATIC_MERCHANT.cat.treasure" },
  { value: "backpack",   icon: "fa-box-archive",         labelKey: "PF2E_CINEMATIC_MERCHANT.cat.container" },
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
    this.qtyByKey = new Map(); // key -> {min, max}
    this.filters = {
      search: "",
      categories: new Set(CATEGORY_CHIPS.map(c => c.value)), // all enabled by default
      rarity: "all",
      levelMin: null,
      levelMax: null,
      pack: "all",
      usage: "all",
      group: "all",
      bulk: "all",
      magical: "all",
      traits: "",     // comma-separated trait list (any-of match)
      priceMaxGp: "", // empty = unbounded
      stackGroup: "all", // ammo stack group: arrows, bolts, etc.
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
          "system.price", "system.level", "system.traits",
          "system.category", "system.consumableType", "system.stackGroup",
          "system.usage", "system.group", "system.bulk",
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

    // Populate usage + group filters from the union of all indexed items.
    const usages = new Set();
    const groups = new Set();
    for (const it of this.allItems) {
      const u = it.system?.usage?.value;
      if (u) usages.add(u);
      const g = it.system?.group;
      if (g) groups.add(g);
    }
    const fillSel = (sel, values, anyLabel) => {
      if (!sel) return;
      const opts = [`<option value="all">${escapeHTML(anyLabel)}</option>`];
      for (const v of [...values].sort((a, b) => a.localeCompare(b))) {
        opts.push(`<option value="${escapeHTML(v)}">${escapeHTML(prettifySlug(v))}</option>`);
      }
      sel.innerHTML = opts.join("");
    };
    fillSel(this.refs.usageSel, usages, t("PF2E_CINEMATIC_MERCHANT.filter.usageAny"));
    fillSel(this.refs.groupSel, groups, t("PF2E_CINEMATIC_MERCHANT.filter.groupAny"));

    this._loading = false;
  }

  _filterItems() {
    const f = this.filters;
    // Pre-parse the comma trait list once per filter pass.
    const wantedTraits = f.traits
      ? f.traits.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
      : null;
    const priceMaxCp = f.priceMaxGp === "" || f.priceMaxGp == null
      ? null
      : Math.max(0, Number(f.priceMaxGp) * 100);
    this.filtered = this.allItems.filter(it => {
      if (f.pack !== "all" && it.packId !== f.pack) return false;
      if (f.search && !it.name.toLowerCase().includes(f.search)) return false;
      if (!f.categories.has(it.type)) return false;
      const r = it.system?.traits?.rarity ?? "common";
      if (f.rarity !== "all" && r !== f.rarity) return false;
      const lvl = Number(it.system?.level?.value ?? 0);
      if (f.levelMin != null && lvl < f.levelMin) return false;
      if (f.levelMax != null && lvl > f.levelMax) return false;
      if (f.usage !== "all" && (it.system?.usage?.value ?? "") !== f.usage) return false;
      if (f.group !== "all" && (it.system?.group ?? "") !== f.group) return false;
      if (f.bulk !== "all") {
        const bv = Number(it.system?.bulk?.value ?? 0);
        let ok = false;
        switch (f.bulk) {
          case "0":     ok = bv === 0; break;
          case "L":     ok = bv > 0 && bv < 1; break;
          case "1":     ok = bv >= 1 && bv < 2; break;
          case "2":     ok = bv >= 2 && bv < 3; break;
          case "3":     ok = bv >= 3 && bv < 4; break;
          case "4plus": ok = bv >= 4; break;
        }
        if (!ok) return false;
      }
      if (f.magical !== "all") {
        const traits = it.system?.traits?.value ?? [];
        const isMagical = Array.isArray(traits) && traits.includes("magical");
        if (f.magical === "yes" && !isMagical) return false;
        if (f.magical === "no" && isMagical) return false;
      }
      if (wantedTraits?.length) {
        const traits = (it.system?.traits?.value ?? []).map(s => String(s).toLowerCase());
        if (!wantedTraits.every(t => traits.includes(t))) return false;
      }
      if (priceMaxCp != null) {
        const cp = priceToCopper(it.system?.price);
        if (cp > priceMaxCp) return false;
      }
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
      // Wire qty inputs — write back into qtyByKey + auto-select the row when
      // the user changes a qty (clear sign they want to import this one).
      for (const inp of this.refs.list.querySelectorAll("[data-role=qty-min], [data-role=qty-max]")) {
        inp.addEventListener("click", (e) => e.stopPropagation());
        inp.addEventListener("input", (e) => {
          const key = inp.dataset.key;
          const cur = this.qtyByKey.get(key) ?? { min: 1, max: 1 };
          const v = Math.max(1, Math.min(999, Number(inp.value) || 1));
          if (inp.dataset.role === "qty-min") {
            cur.min = v;
            if (cur.max < cur.min) cur.max = cur.min;
          } else {
            cur.max = v;
            if (cur.min > cur.max) cur.min = cur.max;
          }
          this.qtyByKey.set(key, cur);
          // Auto-select the row so they don't have to also check the box.
          if (!this.selected.has(key)) {
            this.selected.add(key);
            const cb = inp.closest(".pf2e-cd-mer-picker-row")?.querySelector(".pf2e-cd-mer-picker-row-cb");
            if (cb) cb.checked = true;
            this._refreshFooter();
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
    const qty = this.qtyByKey.get(key) ?? { min: 1, max: 1 };
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
        <div class="pf2e-cd-mer-picker-row-qty" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.qtyRangeHint"))}">
          <input type="number" data-role="qty-min" data-key="${escapeHTML(key)}" min="1" max="999" value="${qty.min}" />
          <span>–</span>
          <input type="number" data-role="qty-max" data-key="${escapeHTML(key)}" min="1" max="999" value="${qty.max}" />
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
      usageSel:    root.querySelector("[name=picker-usage]"),
      groupSel:    root.querySelector("[name=picker-group]"),
      bulkSel:     root.querySelector("[name=picker-bulk]"),
      magicalSel:  root.querySelector("[name=picker-magical]"),
      traitsIn:    root.querySelector("[name=picker-traits]"),
      priceMaxIn:  root.querySelector("[name=picker-price-max]"),
      filtersWrap: root.querySelector("[data-role=picker-filters]"),
      filtersAdv:  root.querySelector("[data-role=picker-filters-advanced]"),
      filtersToggle: root.querySelector("[data-action=picker-filters-toggle]"),
      qtyDefMinIn: root.querySelector("[name=picker-qty-default-min]"),
      qtyDefMaxIn: root.querySelector("[name=picker-qty-default-max]"),
      qtyApplyBtn: root.querySelector("[data-action=picker-qty-apply-all]"),
    };

    this.refs.title.textContent = game.i18n.format(
      "PF2E_CINEMATIC_MERCHANT.picker.title",
      { actor: this.actor.name }
    );
    this.refs.closeBtn.addEventListener("click", () => this.close());

    makeDraggable(this.refs.frame, this.refs.title, "compendium-picker");

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

    // Advanced filters
    this.refs.usageSel?.addEventListener("change", () => { this.filters.usage = this.refs.usageSel.value; this._refreshList(); });
    this.refs.groupSel?.addEventListener("change", () => { this.filters.group = this.refs.groupSel.value; this._refreshList(); });
    this.refs.bulkSel?.addEventListener("change", () => { this.filters.bulk = this.refs.bulkSel.value; this._refreshList(); });
    this.refs.magicalSel?.addEventListener("change", () => { this.filters.magical = this.refs.magicalSel.value; this._refreshList(); });
    this.refs.traitsIn?.addEventListener("input", () => { this.filters.traits = this.refs.traitsIn.value.trim(); debounced(); });
    this.refs.priceMaxIn?.addEventListener("input", () => { this.filters.priceMaxGp = this.refs.priceMaxIn.value; debounced(); });
    this.refs.filtersToggle?.addEventListener("click", () => {
      const collapsed = this.refs.filtersWrap.classList.toggle("is-collapsed");
      this.refs.filtersAdv.hidden = collapsed;
      const chev = this.refs.filtersToggle.querySelector("i");
      if (chev) chev.className = collapsed ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-up";
    });
    this.refs.qtyApplyBtn?.addEventListener("click", () => {
      const dMin = Math.max(1, Math.min(999, Number(this.refs.qtyDefMinIn?.value) || 1));
      const dMaxRaw = Math.max(1, Math.min(999, Number(this.refs.qtyDefMaxIn?.value) || 1));
      const dMax = Math.max(dMin, dMaxRaw);
      // Apply to every currently visible (filtered) row.
      for (const it of this.filtered) {
        const key = `${it.packId}.${it._id ?? it.id}`;
        this.qtyByKey.set(key, { min: dMin, max: dMax });
      }
      this._refreshList();
    });

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
        const docMap = new Map(docs.map(d => [d.id, d]));
        for (const itemId of itemIds) {
          const d = docMap.get(itemId);
          if (!d) continue;
          const data = d.toObject();
          // Apply per-row quantity range: random integer in [min, max] inclusive.
          const range = this.qtyByKey.get(`${packId}.${itemId}`);
          if (range && data.system?.quantity != null) {
            const min = Math.max(1, range.min);
            const max = Math.max(min, range.max);
            data.system.quantity = min + Math.floor(Math.random() * (max - min + 1));
          }
          allItemData.push(data);
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
        <div class="pf2e-cd-mer-picker-filters is-collapsed" data-role="picker-filters">
          <div class="pf2e-cd-mer-picker-filters-row">
            <input type="text" name="picker-search" class="pf2e-cd-mer-grow" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
            <button type="button" class="pf2e-cd-mer-picker-filters-toggle" data-action="picker-filters-toggle">
              <i class="fa-solid fa-chevron-down"></i>
              <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.filtersToggle"))}</span>
            </button>
          </div>
          <div class="pf2e-cd-mer-picker-filters-row">
            <select name="picker-rarity">${rarOpts}</select>
            <input type="number" name="picker-level-min" min="0" max="25" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMin"))}" />
            <input type="number" name="picker-level-max" min="0" max="25" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMax"))}" />
            <select name="picker-pack" class="pf2e-cd-mer-grow"><option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.allPacks"))}</option></select>
          </div>
          <div class="pf2e-cd-mer-picker-filters-advanced" data-role="picker-filters-advanced" hidden>
            <div class="pf2e-cd-mer-picker-filters-row">
              <select name="picker-usage" data-empty-label="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.usageAny"))}"></select>
              <select name="picker-group" data-empty-label="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.groupAny"))}"></select>
              <select name="picker-bulk">
                <option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.bulkAny"))}</option>
                <option value="0">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.bulk0"))}</option>
                <option value="L">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.bulkLight"))}</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4plus">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.bulk4plus"))}</option>
              </select>
              <select name="picker-magical">
                <option value="all">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.magicalAny"))}</option>
                <option value="yes">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.magicalYes"))}</option>
                <option value="no">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.magicalNo"))}</option>
              </select>
            </div>
            <div class="pf2e-cd-mer-picker-filters-row">
              <input type="text" name="picker-traits" class="pf2e-cd-mer-grow" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.traitsPlaceholder"))}" />
              <input type="number" name="picker-price-max" min="0" step="0.1" placeholder="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.priceMaxGp"))}" />
              <label class="pf2e-cd-mer-picker-qty-default" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.qtyDefaultHint"))}">
                <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.qtyDefault"))}</span>
                <input type="number" name="picker-qty-default-min" min="1" max="999" value="1" />
                <span>–</span>
                <input type="number" name="picker-qty-default-max" min="1" max="999" value="1" />
                <button type="button" data-action="picker-qty-apply-all" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.picker.qtyApplyAll"))}">
                  <i class="fa-solid fa-arrows-up-to-line"></i>
                </button>
              </label>
            </div>
          </div>
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
