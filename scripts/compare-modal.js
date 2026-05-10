// Side-by-side comparison modal for 2-3 items.

import { MODULE_ID, effectiveItemPriceCp, formatCopper } from "./merchant-store.js";

let _activeModal = null;

export function openCompareModal(items, opts = {}) {
  if (_activeModal) _activeModal.close();
  _activeModal = new CompareModal(items, opts);
  _activeModal.open();
}

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

function pick(item, ...paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = item;
    let ok = true;
    for (const k of parts) {
      if (cur == null) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function damageString(item) {
  const dmg = item.system?.damage;
  if (!dmg) return null;
  const dice = dmg.dice ?? null;
  const die = dmg.die ?? null;
  const type = dmg.damageType ?? "";
  if (dice && die) return `${dice}${die}${type ? " " + type : ""}`;
  return dmg.formula ?? null;
}

function rangeString(item) {
  const r = item.system?.range;
  if (!r) return null;
  if (typeof r === "number") return `${r} ft`;
  if (typeof r === "object") return r.value != null ? `${r.value} ft` : null;
  return null;
}

// Rows displayed across all items, in order. Each: { key, label, get(item) -> string|null }
function buildRows(items) {
  return [
    { key: "price",  label: "PF2E_CINEMATIC_MERCHANT.compare.price",  get: (it) => formatCopper(effectiveItemPriceCp(it)) },
    { key: "level",  label: "PF2E_CINEMATIC_MERCHANT.compare.level",  get: (it) => String(Number(it.system?.level?.value ?? 0)) },
    { key: "rarity", label: "PF2E_CINEMATIC_MERCHANT.compare.rarity", get: (it) => localizeRarity(it.system?.traits?.rarity ?? "common") },
    { key: "bulk",   label: "PF2E_CINEMATIC_MERCHANT.detail.bulk",    get: (it) => {
      const b = it.system?.bulk?.value;
      if (b == null) return null;
      if (b === 0) return "L";
      return String(b);
    }},
    { key: "qty",    label: "PF2E_CINEMATIC_MERCHANT.compare.stock",  get: (it) => String(Number(it.system?.quantity ?? 1)) },
    { key: "dmg",    label: "PF2E_CINEMATIC_MERCHANT.detail.damage",  get: damageString },
    { key: "range",  label: "PF2E_CINEMATIC_MERCHANT.detail.range",   get: rangeString },
    { key: "group",  label: "PF2E_CINEMATIC_MERCHANT.detail.group",   get: (it) => pick(it, "system.group") },
    { key: "hands",  label: "PF2E_CINEMATIC_MERCHANT.detail.hands",   get: (it) => pick(it, "system.hands") },
    { key: "ac",     label: "PF2E_CINEMATIC_MERCHANT.detail.acBonus", get: (it) => {
      const v = it.system?.acBonus;
      return v != null ? `+${v}` : null;
    }},
    { key: "dexCap", label: "PF2E_CINEMATIC_MERCHANT.detail.dexCap",  get: (it) => {
      const v = it.system?.dexCap;
      return v != null ? `+${v}` : null;
    }},
    { key: "checkPenalty", label: "PF2E_CINEMATIC_MERCHANT.detail.checkPenalty", get: (it) => {
      const v = it.system?.checkPenalty;
      return v != null && v !== 0 ? String(v) : null;
    }},
    { key: "speedPenalty", label: "PF2E_CINEMATIC_MERCHANT.detail.speedPenalty", get: (it) => {
      const v = it.system?.speedPenalty;
      return v != null && v !== 0 ? String(v) : null;
    }},
    { key: "strength", label: "PF2E_CINEMATIC_MERCHANT.detail.strength", get: (it) => {
      const v = it.system?.strength;
      return v != null ? String(v) : null;
    }},
    { key: "hardness", label: "PF2E_CINEMATIC_MERCHANT.detail.hardness", get: (it) => {
      const v = it.system?.hardness;
      return v != null ? String(v) : null;
    }},
    { key: "hp", label: "PF2E_CINEMATIC_MERCHANT.detail.hp", get: (it) => {
      const v = it.system?.hp?.max ?? it.system?.hp?.value;
      return v != null ? String(v) : null;
    }},
    { key: "traits", label: "PF2E_CINEMATIC_MERCHANT.compare.traits", get: (it) => {
      const t = it.system?.traits?.value;
      if (!Array.isArray(t) || t.length === 0) return null;
      return t.join(", ");
    }},
  ];
}

class CompareModal {
  constructor(items, opts = {}) {
    this.items = items.slice(0, 3);
    this.onRemove = opts.onRemove ?? null;
    this.onClear = opts.onClear ?? null;
    this.root = null;
    this._onEsc = null;
  }

  open() {
    this._build();
    this.root.classList.add("is-active");
  }

  close() {
    if (!this.root) return;
    this.root.classList.remove("is-active");
    setTimeout(() => { try { this.root.remove(); } catch {} }, 220);
    if (this._onEsc) document.removeEventListener("keydown", this._onEsc);
    if (_activeModal === this) _activeModal = null;
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-compare-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;
    root.querySelector("[data-action=close]").addEventListener("click", () => this.close());
    root.querySelector(".pf2e-cd-mer-compare-vignette").addEventListener("click", () => this.close());
    for (const btn of root.querySelectorAll("[data-action=remove]")) {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId;
        if (this.onRemove) this.onRemove(id);
        this.close();
      });
    }
    const clearBtn = root.querySelector("[data-action=clear]");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (this.onClear) this.onClear();
      this.close();
    });
    document.addEventListener("keydown", this._onEsc = (e) => { if (e.key === "Escape") this.close(); });
  }

  _html() {
    const items = this.items;
    const rows = buildRows(items);
    const headers = items.map(it => {
      const rarity = it.system?.traits?.rarity ?? "common";
      return `
        <th class="pf2e-cd-mer-compare-th rarity-${rarity}">
          <button type="button" class="pf2e-cd-mer-compare-remove" data-action="remove" data-item-id="${it.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.compare.removeItem"))}">
            <i class="fa-solid fa-xmark"></i>
          </button>
          <img class="pf2e-cd-mer-compare-img" src="${escapeHTML(it.img ?? "icons/svg/item-bag.svg")}" alt="" />
          <div class="pf2e-cd-mer-compare-name">${escapeHTML(it.name)}</div>
        </th>
      `;
    }).join("");

    const bestPriceCp = Math.min(...items.map(it => effectiveItemPriceCp(it)));
    const bestLevel = Math.max(...items.map(it => Number(it.system?.level?.value ?? 0)));

    const bodyRows = rows.map(r => {
      const cells = items.map(it => {
        let v = null;
        try { v = r.get(it); } catch { v = null; }
        const display = v == null ? "—" : v;
        let cls = "pf2e-cd-mer-compare-td";
        if (r.key === "price" && v != null && effectiveItemPriceCp(it) === bestPriceCp && items.length > 1) cls += " is-best";
        if (r.key === "level" && Number(it.system?.level?.value ?? 0) === bestLevel && items.length > 1) cls += " is-highest";
        return `<td class="${cls}">${escapeHTML(display)}</td>`;
      }).join("");
      // Skip rows where all values are missing
      const allEmpty = items.every(it => {
        try { return r.get(it) == null; } catch { return true; }
      });
      if (allEmpty && !["price","level","rarity","stock","traits"].some(k => r.key.startsWith(k))) return "";
      return `
        <tr>
          <th class="pf2e-cd-mer-compare-rowlabel">${escapeHTML(game.i18n.localize(r.label))}</th>
          ${cells}
        </tr>
      `;
    }).join("");

    return `
      <div class="pf2e-cd-mer-compare-vignette"></div>
      <div class="pf2e-cd-mer-compare-frame">
        <button type="button" class="pf2e-cd-mer-compare-close" data-action="close" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-compare-header">
          <div class="pf2e-cd-mer-compare-title">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.compare.title"))}</div>
          <button type="button" class="pf2e-cd-mer-compare-clearbtn" data-action="clear">
            <i class="fa-solid fa-broom"></i>
            ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.compare.clearAll"))}
          </button>
        </div>
        <div class="pf2e-cd-mer-compare-scroll">
          <table class="pf2e-cd-mer-compare-table">
            <thead>
              <tr>
                <th class="pf2e-cd-mer-compare-corner"></th>
                ${headers}
              </tr>
            </thead>
            <tbody>
              ${bodyRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}
