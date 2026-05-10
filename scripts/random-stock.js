// Random-Stock-Generator: bulk-fills a merchant with weighted-random items
// from PF2E compendium packs, filtered by level + categories + rarity weights.

import { MODULE_ID, normalizeMerchantType } from "./merchant-store.js";

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

const normalizeItemType = normalizeMerchantType;
const RARITIES = ["common", "uncommon", "rare", "unique"];
const DEFAULT_WEIGHTS = { common: 70, uncommon: 25, rare: 4, unique: 1 };

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function t(key) {
  const v = game.i18n.localize(key);
  return v && v !== key ? v : key.split(".").pop();
}

function pickWeighted(weights) {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (total <= 0) return "common";
  let r = Math.random() * total;
  for (const [k, v] of Object.entries(weights)) {
    r -= v;
    if (r <= 0) return k;
  }
  return "common";
}

let _activeDialog = null;

export async function openRandomStockDialog(actor, onDone) {
  if (!game.user.isGM || !actor) return;
  if (_activeDialog) _activeDialog.close();
  _activeDialog = new RandomStockDialog(actor, onDone);
  await _activeDialog.open();
}

class RandomStockDialog {
  constructor(actor, onDone) {
    this.actor = actor;
    this.onDone = onDone;
    this.root = null;
    this.refs = null;
    this.candidates = []; // pre-indexed across packs
    this.byRarity = { common: [], uncommon: [], rare: [], unique: [] };
    this._loading = false;
    this._busy = false;
  }

  async open() {
    this._build();
    this.root.classList.add("is-active");
    await this._loadIndexes();
    this._refreshPreview();
  }

  close() {
    if (this.root) {
      this.root.classList.remove("is-active");
      setTimeout(() => { try { this.root.remove(); } catch {} }, 220);
    }
    if (_activeDialog === this) _activeDialog = null;
  }

  async _loadIndexes() {
    this._loading = true;
    if (this.refs.preview) this.refs.preview.textContent = t("PF2E_CINEMATIC_MERCHANT.picker.loading");
    const packs = (game.packs ?? []).filter(p => p.metadata?.type === "Item" && p.visible !== false);
    const all = [];
    for (const pack of packs) {
      try {
        const idx = await pack.getIndex({ fields: [
          "system.level", "system.traits", "system.category",
          "system.consumableType", "system.stackGroup", "type",
        ] });
        for (const it of idx) {
          const normType = normalizeItemType(it);
          if (!ALLOWED_TYPES.has(normType)) continue;
          all.push({
            packId: pack.collection,
            _id: it._id ?? it.id,
            type: normType,
            level: Number(it.system?.level?.value ?? 0),
            rarity: it.system?.traits?.rarity ?? "common",
          });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | random-stock: failed to index ${pack.collection}:`, err);
      }
    }
    this.candidates = all;
    this._loading = false;
  }

  _readForm() {
    const r = this.refs;
    return {
      count: Math.max(1, Math.min(500, Number(r.count.value) || 30)),
      levelMin: Number(r.levelMin.value),
      levelMax: Number(r.levelMax.value),
      categories: new Set([...r.cats.querySelectorAll(".pf2e-cd-mer-cat-chip.is-active")].map(c => c.dataset.cat)),
      weights: {
        common: Math.max(0, Number(r.wCommon.value) || 0),
        uncommon: Math.max(0, Number(r.wUncommon.value) || 0),
        rare: Math.max(0, Number(r.wRare.value) || 0),
        unique: Math.max(0, Number(r.wUnique.value) || 0),
      },
      replace: r.replace.checked,
      qtyMin: Math.max(1, Number(r.qtyMin.value) || 1),
      qtyMax: Math.max(1, Number(r.qtyMax.value) || 1),
    };
  }

  _filterPool(opts) {
    return this.candidates.filter(c => {
      if (!opts.categories.has(c.type)) return false;
      if (Number.isFinite(opts.levelMin) && c.level < opts.levelMin) return false;
      if (Number.isFinite(opts.levelMax) && c.level > opts.levelMax) return false;
      if (opts.weights[c.rarity] == null) return false;
      return true;
    });
  }

  _refreshPreview() {
    if (this._loading || !this.refs.preview) return;
    const opts = this._readForm();
    const pool = this._filterPool(opts);
    const buckets = { common: 0, uncommon: 0, rare: 0, unique: 0 };
    for (const c of pool) buckets[c.rarity] = (buckets[c.rarity] ?? 0) + 1;
    const total = pool.length;
    if (total === 0) {
      this.refs.preview.textContent = t("PF2E_CINEMATIC_MERCHANT.random.poolEmpty");
      this.refs.runBtn.disabled = true;
      return;
    }
    this.refs.runBtn.disabled = this._busy;
    this.refs.preview.innerHTML = `
      <strong>${total}</strong> ${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.poolMatching"))}
      <span class="pf2e-cd-mer-random-buckets">
        ${RARITIES.map(r => `<span class="rarity-${r}">${r}: ${buckets[r] ?? 0}</span>`).join(" · ")}
      </span>
    `;
  }

  async _generate() {
    if (this._busy) return;
    const opts = this._readForm();
    const pool = this._filterPool(opts);
    if (pool.length === 0) return;
    if (opts.qtyMax < opts.qtyMin) opts.qtyMax = opts.qtyMin;

    // Weighted sampling: only weight buckets that actually have candidates
    const liveWeights = {};
    const poolByRarity = { common: [], uncommon: [], rare: [], unique: [] };
    for (const c of pool) poolByRarity[c.rarity].push(c);
    for (const r of RARITIES) {
      if (poolByRarity[r].length > 0) liveWeights[r] = opts.weights[r] ?? 0;
    }
    if (Object.values(liveWeights).every(v => v <= 0)) {
      ui.notifications?.warn(t("PF2E_CINEMATIC_MERCHANT.random.weightsZero"));
      return;
    }

    this._busy = true;
    this.refs.runBtn.disabled = true;
    const origLabel = this.refs.runBtn.querySelector(".label").textContent;
    this.refs.runBtn.querySelector(".label").textContent = t("PF2E_CINEMATIC_MERCHANT.random.generating");
    // Hide this dialog (and the merchant frame behind it) so PF2E system
    // sub-dialogs raised during item creation — e.g. ammunition / damage
    // type pickers — aren't trapped behind our z-index stack.
    if (this.root) this.root.style.visibility = "hidden";
    const merchantRoot = document.getElementById("pf2e-cd-mer-root");
    const prevMerchantVis = merchantRoot?.style.visibility;
    if (merchantRoot) merchantRoot.style.visibility = "hidden";

    try {
      // Pick N items (with replacement allowed; PF2E often has duplicate flavor stock)
      const picks = [];
      for (let i = 0; i < opts.count; i++) {
        const rarity = pickWeighted(liveWeights);
        const bucket = poolByRarity[rarity];
        if (bucket.length === 0) continue;
        picks.push(bucket[Math.floor(Math.random() * bucket.length)]);
      }
      if (picks.length === 0) {
        ui.notifications?.warn(t("PF2E_CINEMATIC_MERCHANT.random.noPicks"));
        return;
      }

      // Group by pack, fetch in batches
      const byPack = new Map();
      for (const p of picks) {
        if (!byPack.has(p.packId)) byPack.set(p.packId, []);
        byPack.get(p.packId).push(p._id);
      }
      const itemDataList = [];
      for (const [packId, ids] of byPack.entries()) {
        const pack = game.packs.get(packId);
        if (!pack) continue;
        const docs = await pack.getDocuments({ _id__in: ids }).catch(async () => {
          const out = [];
          for (const id of ids) {
            const d = await pack.getDocument(id).catch(() => null);
            if (d) out.push(d);
          }
          return out;
        });
        // ids array can repeat (we sampled with replacement) — fetch only unique then duplicate
        const docMap = new Map();
        for (const d of docs) docMap.set(d.id, d);
        for (const wantedId of ids) {
          const d = docMap.get(wantedId);
          if (!d) continue;
          const data = d.toObject();
          if (data.system?.quantity != null) {
            const q = opts.qtyMin + Math.floor(Math.random() * (opts.qtyMax - opts.qtyMin + 1));
            data.system.quantity = q;
          }
          itemDataList.push(data);
        }
      }

      if (opts.replace) {
        const existingIds = [...this.actor.items].map(i => i.id);
        if (existingIds.length) await this.actor.deleteEmbeddedDocuments("Item", existingIds);
      }

      // Create in chunks of 100
      const CHUNK = 100;
      let created = 0;
      for (let i = 0; i < itemDataList.length; i += CHUNK) {
        const slice = itemDataList.slice(i, i + CHUNK);
        const result = await this.actor.createEmbeddedDocuments("Item", slice);
        created += result?.length ?? 0;
      }
      ui.notifications?.info(game.i18n.format("PF2E_CINEMATIC_MERCHANT.random.success", {
        count: created,
        actor: this.actor.name,
      }));
      if (typeof this.onDone === "function") this.onDone();
      this.close();
    } catch (err) {
      console.warn(`${MODULE_ID} | random-stock: generation failed:`, err);
      ui.notifications?.error(t("PF2E_CINEMATIC_MERCHANT.random.failed"));
    } finally {
      this._busy = false;
      // Restore the merchant frame visibility (we don't necessarily own it).
      if (merchantRoot) merchantRoot.style.visibility = prevMerchantVis ?? "";
      // Restore our own modal in case we didn't close (error path).
      if (this.root) this.root.style.visibility = "";
      if (this.refs?.runBtn) {
        this.refs.runBtn.disabled = false;
        const lbl = this.refs.runBtn.querySelector(".label");
        if (lbl) lbl.textContent = origLabel;
      }
    }
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-random-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;
    this.refs = {
      frame:     root.querySelector(".pf2e-cd-mer-random-frame"),
      title:     root.querySelector(".pf2e-cd-mer-random-title"),
      count:     root.querySelector("[name=rs-count]"),
      levelMin:  root.querySelector("[name=rs-level-min]"),
      levelMax:  root.querySelector("[name=rs-level-max]"),
      qtyMin:    root.querySelector("[name=rs-qty-min]"),
      qtyMax:    root.querySelector("[name=rs-qty-max]"),
      replace:   root.querySelector("[name=rs-replace]"),
      cats:      root.querySelector(".pf2e-cd-mer-random-cats"),
      wCommon:   root.querySelector("[name=rs-w-common]"),
      wUncommon: root.querySelector("[name=rs-w-uncommon]"),
      wRare:     root.querySelector("[name=rs-w-rare]"),
      wUnique:   root.querySelector("[name=rs-w-unique]"),
      preview:   root.querySelector(".pf2e-cd-mer-random-preview"),
      runBtn:    root.querySelector("[data-action=run]"),
      closeBtn:  root.querySelector("[data-action=close]"),
      vignette:  root.querySelector(".pf2e-cd-mer-random-vignette"),
    };

    this.refs.title.textContent = game.i18n.format("PF2E_CINEMATIC_MERCHANT.random.title", { actor: this.actor.name });
    this.refs.closeBtn.addEventListener("click", () => this.close());
    this.refs.vignette.addEventListener("click", () => this.close());
    this.refs.runBtn.addEventListener("click", () => this._generate());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.root?.classList.contains("is-active")) this.close(); });

    for (const chip of root.querySelectorAll(".pf2e-cd-mer-cat-chip")) {
      chip.addEventListener("click", () => {
        chip.classList.toggle("is-active");
        this._refreshPreview();
      });
    }

    const refresh = () => this._refreshPreview();
    [this.refs.count, this.refs.levelMin, this.refs.levelMax, this.refs.qtyMin, this.refs.qtyMax,
     this.refs.wCommon, this.refs.wUncommon, this.refs.wRare, this.refs.wUnique].forEach(el => {
      el.addEventListener("input", refresh);
    });
  }

  _html() {
    const catChips = CATEGORY_CHIPS.map(c => `
      <button type="button" class="pf2e-cd-mer-cat-chip is-active" data-cat="${c.value}">
        <i class="fa-solid ${c.icon}"></i>
        <span>${escapeHTML(t(c.labelKey))}</span>
      </button>
    `).join("");
    const w = DEFAULT_WEIGHTS;
    return `
      <div class="pf2e-cd-mer-random-vignette"></div>
      <div class="pf2e-cd-mer-random-frame">
        <button type="button" class="pf2e-cd-mer-random-close" data-action="close" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-random-title"></div>

        <div class="pf2e-cd-mer-random-row">
          <label>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.count"))}
            <input type="number" name="rs-count" min="1" max="500" value="30" />
          </label>
          <label>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMin"))}
            <input type="number" name="rs-level-min" min="0" max="25" value="0" />
          </label>
          <label>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.filter.levelMax"))}
            <input type="number" name="rs-level-max" min="0" max="25" value="5" />
          </label>
          <label>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.qtyMin"))}
            <input type="number" name="rs-qty-min" min="1" max="50" value="1" />
          </label>
          <label>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.qtyMax"))}
            <input type="number" name="rs-qty-max" min="1" max="50" value="3" />
          </label>
        </div>

        <div class="pf2e-cd-mer-random-section">
          <div class="pf2e-cd-mer-random-section-title">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.categories"))}</div>
          <div class="pf2e-cd-mer-random-cats">${catChips}</div>
        </div>

        <div class="pf2e-cd-mer-random-section">
          <div class="pf2e-cd-mer-random-section-title">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.weights"))}</div>
          <div class="pf2e-cd-mer-random-weights">
            <label class="rarity-common"><span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.rarity.common"))}</span><input type="number" name="rs-w-common" min="0" max="100" step="1" value="${w.common}" /></label>
            <label class="rarity-uncommon"><span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.rarity.uncommon"))}</span><input type="number" name="rs-w-uncommon" min="0" max="100" step="1" value="${w.uncommon}" /></label>
            <label class="rarity-rare"><span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.rarity.rare"))}</span><input type="number" name="rs-w-rare" min="0" max="100" step="1" value="${w.rare}" /></label>
            <label class="rarity-unique"><span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.rarity.unique"))}</span><input type="number" name="rs-w-unique" min="0" max="100" step="1" value="${w.unique}" /></label>
          </div>
          <div class="pf2e-cd-mer-random-hint">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.weightsHint"))}</div>
        </div>

        <label class="pf2e-cd-mer-random-replace">
          <input type="checkbox" name="rs-replace" />
          <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.replace"))}</span>
        </label>

        <div class="pf2e-cd-mer-random-preview">—</div>

        <div class="pf2e-cd-mer-random-footer">
          <button type="button" class="pf2e-cd-mer-random-run" data-action="run">
            <i class="fa-solid fa-dice"></i>
            <span class="label">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.runBtn"))}</span>
          </button>
        </div>
      </div>
    `;
  }
}
