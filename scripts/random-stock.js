// Random-Stock-Generator: bulk-fills a merchant with weighted-random items
// from PF2E compendium packs, filtered by level + categories + rarity weights.

import { MODULE_ID, normalizeMerchantType } from "./merchant-store.js";
import { makeDraggable } from "./draggable.js";

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
      autoPick: r.autoPick?.checked ?? true,
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
    this._autoPick = opts.autoPick;
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

    this._showLoader();
    this._setLoaderStage("fetching", 0, opts.count);

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
      let fetched = 0;
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
          fetched += 1;
        }
        this._setLoaderStage("fetching", fetched, picks.length);
      }

      if (opts.replace) {
        this._setLoaderStage("clearing");
        const existingIds = [...this.actor.items].map(i => i.id);
        if (existingIds.length) await this.actor.deleteEmbeddedDocuments("Item", existingIds);
      }

      // Create in chunks of 100
      const CHUNK = 100;
      let created = 0;
      this._setLoaderStage("creating", 0, itemDataList.length);
      for (let i = 0; i < itemDataList.length; i += CHUNK) {
        const slice = itemDataList.slice(i, i + CHUNK);
        const result = await this.actor.createEmbeddedDocuments("Item", slice);
        created += result?.length ?? 0;
        this._setLoaderStage("creating", created, itemDataList.length);
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
      this._hideLoader();
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

  _showLoader() {
    if (this._loaderEl) return;
    const el = document.createElement("div");
    el.id = "pf2e-cd-mer-random-loader";
    el.innerHTML = `
      <div class="pf2e-cd-mer-rl-vignette"></div>
      <div class="pf2e-cd-mer-rl-card" role="status" aria-live="polite">
        <div class="pf2e-cd-mer-rl-coin">
          <i class="fa-solid fa-coins"></i>
        </div>
        <div class="pf2e-cd-mer-rl-title">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.loadTitle"))}</div>
        <div class="pf2e-cd-mer-rl-status" data-role="status">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.loadIndexing"))}</div>
        <div class="pf2e-cd-mer-rl-bar"><div class="pf2e-cd-mer-rl-bar-fill" data-role="bar"></div></div>
        <div class="pf2e-cd-mer-rl-hint">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.loadHint"))}</div>
      </div>
    `;
    document.body.appendChild(el);
    // Trigger fade-in on next frame
    requestAnimationFrame(() => el.classList.add("is-active"));
    this._loaderEl = el;
    this._loaderRefs = {
      status: el.querySelector("[data-role=status]"),
      bar: el.querySelector("[data-role=bar]"),
    };
    // PF2E may raise sub-dialogs (e.g. ammunition / damage-type pickers) while
    // creating items. Our loader sits at a high z-index and would cover them,
    // so we step aside while any foreign Foundry Application is open and
    // restore visibility once the last one closes.
    this._foreignAppDepth = 0;
    this._onForeignAppRender = (app) => {
      // Both our random dialog and the merchant window are plain DOM, not
      // Foundry Applications, so every render hook here is a foreign dialog.
      if (!this._loaderEl) return;
      this._foreignAppDepth++;
      this._loaderEl.classList.add("is-eclipsed");
      if (this._autoPick && this._looksLikeChoicePrompt(app)) {
        // Defer so PF2E finishes wiring up its DOM/form state first.
        setTimeout(() => this._autoPickChoiceDialog(app), 60);
      }
    };
    this._onForeignAppClose = (app) => {
      if (!this._loaderEl) return;
      this._foreignAppDepth = Math.max(0, this._foreignAppDepth - 1);
      if (this._foreignAppDepth === 0) {
        this._loaderEl.classList.remove("is-eclipsed");
      }
    };
    Hooks.on("renderApplication", this._onForeignAppRender);
    Hooks.on("closeApplication", this._onForeignAppClose);
    Hooks.on("renderApplicationV2", this._onForeignAppRender);
    Hooks.on("closeApplicationV2", this._onForeignAppClose);
  }

  _setLoaderStage(stage, done, total) {
    if (!this._loaderRefs) return;
    let key, pct;
    if (stage === "clearing") {
      key = "PF2E_CINEMATIC_MERCHANT.random.loadClearing";
      pct = null; // indeterminate
    } else if (stage === "creating") {
      key = "PF2E_CINEMATIC_MERCHANT.random.loadCreating";
      pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    } else {
      key = "PF2E_CINEMATIC_MERCHANT.random.loadFetching";
      pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    }
    const txt = (stage === "clearing")
      ? t(key)
      : game.i18n.format(key, { done: done ?? 0, total: total ?? 0 });
    this._loaderRefs.status.textContent = txt;
    if (pct == null) {
      this._loaderRefs.bar.classList.add("is-indeterminate");
      this._loaderRefs.bar.style.width = "100%";
    } else {
      this._loaderRefs.bar.classList.remove("is-indeterminate");
      this._loaderRefs.bar.style.width = `${pct}%`;
    }
  }

  _hideLoader() {
    const el = this._loaderEl;
    if (!el) return;
    el.classList.remove("is-active");
    setTimeout(() => { try { el.remove(); } catch {} }, 220);
    this._loaderEl = null;
    this._loaderRefs = null;
    if (this._onForeignAppRender) {
      Hooks.off("renderApplication", this._onForeignAppRender);
      Hooks.off("renderApplicationV2", this._onForeignAppRender);
    }
    if (this._onForeignAppClose) {
      Hooks.off("closeApplication", this._onForeignAppClose);
      Hooks.off("closeApplicationV2", this._onForeignAppClose);
    }
    this._onForeignAppRender = null;
    this._onForeignAppClose = null;
    this._foreignAppDepth = 0;
  }

  _getAppEl(app) {
    if (!app) return null;
    if (app.element instanceof HTMLElement) return app.element;
    if (app.element?.[0] instanceof HTMLElement) return app.element[0];
    return null;
  }

  _looksLikeChoicePrompt(app) {
    if (!app) return false;
    const name = app?.constructor?.name ?? "";
    if (/Choice|Prompt|Picker|Selection|RuleElement|Ammo|Ammunition/i.test(name)) return true;
    const el = this._getAppEl(app);
    if (!el) return false;
    if (el.matches?.(".choice-set-prompt, .dialog.choice-set-prompt, [class*='choice-set']")) return true;
    if (el.querySelector?.(".choice-set-prompt, [data-choices], [name='selection'], [name='choice']")) return true;
    // Generic small modal with a single select + submit button is a strong signal.
    const select = el.querySelector?.("select");
    const submit = el.querySelector?.(
      "button[type='submit'], button[data-button='ok'], button[data-button='save'], " +
      "button[data-action='submit'], button[data-action='save'], .dialog-button.ok"
    );
    if (select && submit) return true;
    return false;
  }

  _findOkButton(el) {
    if (!el) return null;
    // Specific known submit patterns
    const specific = el.querySelector(
      ".dialog-button.ok, .dialog-button.yes, " +
      "button[data-button='ok'], button[data-button='yes'], button[data-button='save'], button[data-button='confirm'], " +
      "button[data-action='ok'], button[data-action='save'], button[data-action='confirm'], button[data-action='submit']"
    );
    if (specific) return specific;
    // Generic submit
    const submit = el.querySelector("button[type='submit']");
    if (submit) return submit;
    // Label-matching fallback (Save / OK / Submit / Confirm in EN+DE)
    const re = /^(save|ok|submit|confirm|speichern|bestätigen|ja|yes)$/i;
    const candidates = [...el.querySelectorAll("button, .dialog-button")];
    return candidates.find(b => re.test((b.textContent ?? "").trim())) ?? null;
  }

  _pickSelectOption(el) {
    const select = el.querySelector("select");
    if (!select || !select.options || select.options.length === 0) return false;
    const pickable = [...select.options].filter(o => !o.disabled && o.value !== "" && o.value != null);
    if (pickable.length === 0) return false;
    const choice = pickable[Math.floor(Math.random() * pickable.length)];
    select.value = choice.value;
    select.selectedIndex = choice.index;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  _pickRadioOption(el) {
    const radios = [...el.querySelectorAll("input[type='radio']")].filter(r => !r.disabled);
    if (radios.length === 0) return false;
    const choice = radios[Math.floor(Math.random() * radios.length)];
    choice.checked = true;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    choice.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  async _autoPickChoiceDialog(app) {
    if (!app) return;
    // PF2E may populate options asynchronously (e.g. compendium lookups), and
    // the submit button is often disabled until a valid choice exists. Retry
    // a few times to give the dialog a chance to finish wiring up.
    const MAX_ATTEMPTS = 12;
    const DELAY_MS = 120;
    let picked = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (app.rendered === false) return;
      const el = this._getAppEl(app);
      if (!el || !document.body.contains(el)) {
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      if (!picked) {
        try {
          picked = this._pickSelectOption(el) || this._pickRadioOption(el);
        } catch (err) {
          console.warn(`${MODULE_ID} | random-stock: auto-pick select failed:`, err);
        }
      }

      if (picked) {
        // Let the form revalidate before checking the submit button.
        await new Promise(r => setTimeout(r, 60));
        if (app.rendered === false) return;
        const currentEl = this._getAppEl(app);
        if (!currentEl || !document.body.contains(currentEl)) return;
        const ok = this._findOkButton(currentEl);
        if (ok && !ok.disabled && ok.offsetParent !== null) {
          try { ok.click(); return; } catch (err) {
            console.warn(`${MODULE_ID} | random-stock: auto-pick click failed:`, err);
          }
        }
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    // Last-ditch attempts if the button never enabled or we never found a select.
    const el = this._getAppEl(app);
    if (!el || !document.body.contains(el)) return;
    if (!picked && typeof app.submit === "function") {
      try { await app.submit(); return; } catch {}
    }
    const ok = this._findOkButton(el);
    if (ok && !ok.disabled) {
      try { ok.click(); } catch {}
    } else {
      console.warn(`${MODULE_ID} | random-stock: auto-pick gave up on`, app?.constructor?.name);
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
      autoPick:  root.querySelector("[name=rs-auto-pick]"),
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

    makeDraggable(this.refs.frame, this.refs.title, "random-stock");

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

        <label class="pf2e-cd-mer-random-replace" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.autoPickHint"))}">
          <input type="checkbox" name="rs-auto-pick" checked />
          <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.random.autoPick"))}</span>
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
