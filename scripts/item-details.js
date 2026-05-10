// Custom item details modal — PF2E parchment styling, key stats, description, buy button.

import { MODULE_ID, effectiveItemPriceCp, formatCopper, formatCopperHtml } from "./merchant-store.js";

const RARITY_LABELS = { common: "common", uncommon: "uncommon", rare: "rare", unique: "unique" };

let _activeModal = null;

export function openItemDetails(item, options = {}) {
  if (_activeModal) _activeModal.close();
  _activeModal = new ItemDetailsModal(item, options);
  _activeModal.open();
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function t(key) {
  const v = game.i18n.localize(key);
  return v && v !== key && !v.startsWith("PF2E_CINEMATIC_MERCHANT.") ? v : key.split(".").pop();
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

function getTraitInfo(slug) {
  const cfg = CONFIG?.PF2E ?? {};
  const sources = [
    cfg.weaponTraits, cfg.armorTraits, cfg.shieldTraits, cfg.consumableTraits,
    cfg.equipmentTraits, cfg.featTraits, cfg.actionTraits, cfg.spellTraits,
    cfg.creatureTraits, cfg.npcAttackTraits, cfg.preciousMaterialTraits,
    cfg.runeTraits, cfg.kingmakerTraits, cfg.traits,
  ];
  let label = slug;
  for (const src of sources) {
    if (src && src[slug]) {
      const localized = game.i18n.localize(src[slug]);
      if (localized) { label = localized; break; }
    }
  }
  let description = null;
  const descMap = cfg.traitsDescriptions;
  if (descMap && descMap[slug]) {
    const v = game.i18n.localize(descMap[slug]);
    if (v && v !== descMap[slug]) description = v;
  }
  return { slug, label, description };
}

class ItemDetailsModal {
  constructor(item, options = {}) {
    this.item = item;
    this.onBuy = options.onBuy ?? null;
    this.canBuy = options.canBuy ?? false;
    this.root = null;
    this._enriched = "";
    this._traitPopover = null;
    this._onPopoverOutside = null;
    this._onEsc = null;
  }

  async open() {
    // Enrich description so PF2E inline links (@Compendium, @UUID, etc.) resolve.
    const raw = this.item.system?.description?.value ?? "";
    try {
      const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor ?? null;
      if (TE?.enrichHTML) {
        this._enriched = await TE.enrichHTML(raw, { async: true });
      } else {
        this._enriched = raw;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | enrichHTML failed:`, err);
      this._enriched = raw;
    }

    this._build();
    this.root.classList.add("is-active");
  }

  close() {
    if (!this.root) return;
    this._closeTraitPopover();
    if (this._onEsc) {
      document.removeEventListener("keydown", this._onEsc);
      this._onEsc = null;
    }
    this.root.classList.remove("is-active");
    setTimeout(() => { try { this.root.remove(); } catch {} }, 240);
    if (_activeModal === this) _activeModal = null;
  }

  _build() {
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-detail-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;

    root.querySelector("[data-action=close]")?.addEventListener("click", () => this.close());
    root.querySelector(".pf2e-cd-mer-detail-vignette")?.addEventListener("click", () => this.close());
    const buyBtn = root.querySelector("[data-action=buy]");
    buyBtn?.addEventListener("click", () => {
      if (this.onBuy) this.onBuy(this.item);
      this.close();
    });
    document.addEventListener("keydown", this._onEsc = (e) => { if (e.key === "Escape") { this._closeTraitPopover(); this.close(); } });

    // Trait click → popover with name + description
    for (const tr of root.querySelectorAll(".pf2e-cd-mer-detail-traits .trait")) {
      tr.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showTraitPopover(tr.dataset.trait, tr);
      });
    }
  }

  _showTraitPopover(slug, anchor) {
    this._closeTraitPopover();
    const info = getTraitInfo(slug);
    const popover = document.createElement("div");
    popover.className = "pf2e-cd-mer-trait-popover";
    popover.innerHTML = `
      <div class="pf2e-cd-mer-trait-popover-name">${escapeHTML(info.label)}</div>
      ${info.description
        ? `<div class="pf2e-cd-mer-trait-popover-desc">${info.description}</div>`
        : `<div class="pf2e-cd-mer-trait-popover-desc no-desc">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.detail.traitNoDesc"))}</div>`}
    `;
    document.body.appendChild(popover);
    this._traitPopover = popover;

    // Position below the trait pill (flip above if it would overflow)
    const aRect = anchor.getBoundingClientRect();
    const pRect = popover.getBoundingClientRect();
    let top = aRect.bottom + 6;
    let left = aRect.left + aRect.width / 2 - pRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pRect.width - 8));
    if (top + pRect.height > window.innerHeight - 8) top = aRect.top - pRect.height - 6;
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;

    // Close on outside click
    setTimeout(() => {
      this._onPopoverOutside = (ev) => {
        if (popover.contains(ev.target) || anchor.contains(ev.target)) return;
        this._closeTraitPopover();
      };
      document.addEventListener("mousedown", this._onPopoverOutside, true);
    }, 0);
  }

  _closeTraitPopover() {
    if (this._traitPopover) {
      try { this._traitPopover.remove(); } catch {}
      this._traitPopover = null;
    }
    if (this._onPopoverOutside) {
      document.removeEventListener("mousedown", this._onPopoverOutside, true);
      this._onPopoverOutside = null;
    }
  }

  _html() {
    const item = this.item;
    const rarity = item.system?.traits?.rarity ?? "common";
    const lvl = Number(item.system?.level?.value ?? 0);
    const cat = item.type;
    const cp = effectiveItemPriceCp(item);
    const qty = Number(item.system?.quantity ?? 1);

    const traits = (item.system?.traits?.value ?? []).filter(x => typeof x === "string");
    const traitsHTML = traits.length > 0
      ? `<div class="pf2e-cd-mer-detail-traits">${traits.map(tr => {
          const info = getTraitInfo(tr);
          const hasDesc = info.description ? "has-desc" : "no-desc";
          return `<span class="trait ${hasDesc}" data-trait="${escapeHTML(tr)}">${escapeHTML(info.label)}</span>`;
        }).join("")}</div>`
      : "";

    const stats = this._renderStats(item);
    const description = this._enriched
      ? `<div class="pf2e-cd-mer-detail-description">${this._enriched}</div>`
      : `<div class="pf2e-cd-mer-detail-description pf2e-cd-mer-detail-no-desc">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.detail.noDescription"))}</div>`;

    const buyBtn = this.canBuy
      ? `<button type="button" class="pf2e-cd-mer-detail-buy" data-action="buy">
           <i class="fa-solid fa-coins"></i>
           <span>${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.detail.buyFor"))} ${formatCopperHtml(cp)}</span>
         </button>`
      : "";

    return `
      <div class="pf2e-cd-mer-detail-vignette"></div>
      <div class="pf2e-cd-mer-detail-frame">
        <button type="button" class="pf2e-cd-mer-detail-close" data-action="close" title="${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.window.close"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-detail-header">
          <img class="pf2e-cd-mer-detail-img" src="${escapeHTML(item.img ?? "icons/svg/item-bag.svg")}" alt="" />
          <div class="pf2e-cd-mer-detail-headerinfo">
            <div class="pf2e-cd-mer-detail-name">${escapeHTML(item.name)}</div>
            <div class="pf2e-cd-mer-detail-meta">
              <span class="meta-tag rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
              <span class="meta-tag meta-cat">${escapeHTML(localizeCategory(cat))}</span>
              <span class="meta-tag meta-level">${escapeHTML(t("PF2E_CINEMATIC_MERCHANT.detail.level"))} ${lvl}</span>
              ${qty > 1 ? `<span class="meta-tag meta-qty">×${qty}</span>` : ""}
            </div>
            <div class="pf2e-cd-mer-detail-price">${formatCopperHtml(cp)}</div>
          </div>
        </div>
        ${stats}
        ${traitsHTML}
        ${description}
        ${buyBtn ? `<div class="pf2e-cd-mer-detail-actions">${buyBtn}</div>` : ""}
      </div>
    `;
  }

  _renderStats(item) {
    const sys = item.system ?? {};
    const rows = [];
    const t_ = (k) => t(`PF2E_CINEMATIC_MERCHANT.detail.${k}`);

    if (sys.bulk?.value != null && sys.bulk.value !== 0) rows.push([t_("bulk"), String(sys.bulk.value)]);
    if (typeof sys.bulk?.value === "string" && sys.bulk.value === "L") rows.push([t_("bulk"), "L"]);
    if (sys.usage?.value && sys.usage.value !== "held-in-one-hand" && sys.usage.value !== "worn") {
      rows.push([t_("usage"), String(sys.usage.value)]);
    }

    if (item.type === "weapon") {
      const dice = sys.damage?.dice;
      const die  = sys.damage?.die;
      const dmgType = sys.damage?.damageType;
      if (dice && die) rows.push([t_("damage"), `${dice}${die} ${dmgType ?? ""}`.trim()]);
      if (sys.range?.increment != null) rows.push([t_("range"), `${sys.range.increment} ft`]);
      if (sys.group) rows.push([t_("group"), String(sys.group)]);
      if (sys.hands) rows.push([t_("hands"), String(sys.hands)]);
      if (sys.reload?.value) rows.push([t_("reload"), String(sys.reload.value)]);
    }
    if (item.type === "armor") {
      if (sys.acBonus != null) rows.push([t_("acBonus"), `+${sys.acBonus}`]);
      if (sys.dexCap != null) rows.push([t_("dexCap"), `+${sys.dexCap}`]);
      if (sys.checkPenalty != null && sys.checkPenalty !== 0) rows.push([t_("checkPenalty"), String(sys.checkPenalty)]);
      if (sys.speedPenalty != null && sys.speedPenalty !== 0) rows.push([t_("speedPenalty"), `${sys.speedPenalty} ft`]);
      if (sys.strength != null) rows.push([t_("strength"), String(sys.strength)]);
      if (sys.group) rows.push([t_("group"), String(sys.group)]);
    }
    if (item.type === "shield") {
      if (sys.acBonus != null) rows.push([t_("acBonus"), `+${sys.acBonus}`]);
      if (sys.hardness != null) rows.push([t_("hardness"), String(sys.hardness)]);
      if (sys.hp?.max != null) rows.push([t_("hp"), String(sys.hp.max)]);
      if (sys.speedPenalty != null && sys.speedPenalty !== 0) rows.push([t_("speedPenalty"), `${sys.speedPenalty} ft`]);
    }
    if (item.type === "consumable") {
      if (sys.uses?.max != null) rows.push([t_("uses"), `${sys.uses.value ?? sys.uses.max}/${sys.uses.max}`]);
      if (sys.consumableType?.value) rows.push([t_("consumableType"), String(sys.consumableType.value)]);
    }

    if (rows.length === 0) return "";
    return `
      <div class="pf2e-cd-mer-detail-stats">
        ${rows.map(([k, v]) => `
          <div class="stat">
            <span class="stat-label">${escapeHTML(k)}</span>
            <span class="stat-value">${escapeHTML(v)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }
}
