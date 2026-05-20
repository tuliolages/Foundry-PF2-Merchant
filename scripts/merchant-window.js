import {
  MODULE_ID,
  effectiveItemPriceCp,
  formatCopper,
  priceToCopper,
  copperToCoins,
  getMerchantSellRate,
  setMerchantSellRate,
  getMerchantMarkup,
  setMerchantMarkup,
  getMerchantRarityDiscounts,
  setMerchantRarityDiscounts,
  getMerchantGreetingSounds,
  setMerchantGreetingSounds,
  getMerchantPortraitMirrored,
  setMerchantPortraitMirrored,
  readMerchantCoins,
  setMerchantCoins,
  ensureMerchantOwnership,
  setItemPriceOverrideCp,
  getItemPriceOverrideCp,
  isCoinItem,
  getItemIdentityKey,
  getItemDailyOfferPct,
  setItemDailyOfferPct,
  getMerchantDailyOffers,
  recordMerchantTransaction,
  recordMerchantTransactions,
  getMerchantTransactionLog,
  clearMerchantTransactionLog,
  getMerchantCharacterDiscounts,
  setMerchantCharacterDiscounts,
  effectiveSellRate,
  normalizeMerchantType,
  getMerchantServices,
  addMerchantService,
  updateMerchantService,
  removeMerchantService,
} from "./merchant-store.js";
import { openCompendiumPicker } from "./compendium-picker.js";
import { SERVICE_PRESETS } from "./service-presets.js";
import { openItemDetails } from "./item-details.js";
import { openSellList } from "./sell-list.js";
import { openCompareModal } from "./compare-modal.js";
import { openRandomStockDialog } from "./random-stock.js";
import { isWishlisted, toggleWishlist, getAllWishlistKeys, getItemKey } from "./wishlist.js";
import { Cart, openCartDrawer } from "./cart.js";
import { playOpen, playBuy, playSell, playClick, playGreetingSounds, previewSound } from "./sound-fx.js";
import { openVault, vaultCount } from "./vault.js";
import { callGM } from "./socket-bridge.js";

const RARITIES = ["common", "uncommon", "rare", "unique"];
const CATEGORIES = [
  { value: "weapon",     labelKey: "PF2E_CINEMATIC_MERCHANT.cat.weapon",     icon: "fa-hammer" },
  { value: "armor",      labelKey: "PF2E_CINEMATIC_MERCHANT.cat.armor",      icon: "fa-shirt" },
  { value: "shield",     labelKey: "PF2E_CINEMATIC_MERCHANT.cat.shield",     icon: "fa-shield-halved" },
  { value: "consumable", labelKey: "PF2E_CINEMATIC_MERCHANT.cat.consumable", icon: "fa-flask" },
  { value: "ammunition", labelKey: "PF2E_CINEMATIC_MERCHANT.cat.ammunition", icon: "fa-bolt-lightning" },
  { value: "equipment",  labelKey: "PF2E_CINEMATIC_MERCHANT.cat.equipment",  icon: "fa-screwdriver-wrench" },
  { value: "treasure",   labelKey: "PF2E_CINEMATIC_MERCHANT.cat.treasure",   icon: "fa-gem" },
  { value: "backpack",   labelKey: "PF2E_CINEMATIC_MERCHANT.cat.container",  icon: "fa-suitcase" },
  { value: "kit",        labelKey: "PF2E_CINEMATIC_MERCHANT.cat.kit",        icon: "fa-toolbox" },
];

// Use the shared normalizer — also matches stackGroup + traits + name
// heuristics so arrows/bolts/etc. land in the ammunition bucket.
const effectiveItemType = normalizeMerchantType;

function localizeRarity(rarity) {
  const v = game.i18n.localize(`PF2E_CINEMATIC_MERCHANT.rarity.${rarity}`);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return rarity.charAt(0).toUpperCase() + rarity.slice(1);
}

function localizeCategory(slug) {
  const map = {
    weapon: "weapon", armor: "armor", shield: "shield",
    consumable: "consumable", equipment: "equipment", treasure: "treasure",
    backpack: "container", ammunition: "ammunition", ammo: "ammunition", kit: "kit",
  };
  const key = `PF2E_CINEMATIC_MERCHANT.cat.${map[slug] ?? slug}`;
  const v = game.i18n.localize(key);
  if (v && !v.startsWith("PF2E_CINEMATIC_MERCHANT.")) return v;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// Pretty-print usage / group slugs from PF2E. "held-in-two-hands" → "Held in
// two hands". If a localization key exists for the slug, prefer it.
function localizeUsageOrGroup(slug) {
  if (!slug) return "";
  const key = `PF2E.${slug}`;
  const localized = game.i18n.localize(key);
  if (localized && localized !== key) return localized;
  return String(slug)
    .replace(/-/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function readActorCoins(actor) {
  if (!actor) return { pp: 0, gp: 0, sp: 0, cp: 0 };
  // Try PF2E v14 inventory.coins (CoinAmount object)
  const inv = actor.inventory?.coins;
  if (inv && (inv.pp != null || inv.gp != null || inv.sp != null || inv.cp != null)) {
    return { pp: inv.pp ?? 0, gp: inv.gp ?? 0, sp: inv.sp ?? 0, cp: inv.cp ?? 0 };
  }
  // Legacy paths
  const sys = actor.system?.coins
           ?? actor.system?.currency
           ?? actor.system?.attributes?.currency
           ?? {};
  return { pp: sys.pp ?? 0, gp: sys.gp ?? 0, sp: sys.sp ?? 0, cp: sys.cp ?? 0 };
}

export class MerchantWindow {
  constructor() {
    this.root = null;
    this.actor = null;       // current loot actor
    this.viewer = null;      // player actor (for buying)
    this.viewMode = "categories"; // "categories" | "items"
    this.filters = {
      search: "",
      category: "all",
      rarity: "all",
      levelMin: null,
      levelMax: null,
      affordableOnly: false,
      sort: "default", // default | priceAsc | priceDesc | levelAsc | levelDesc | nameAsc | nameDesc
      usage: "all",       // e.g. held-in-one-hand, worn-armor, …
      group: "all",       // e.g. axe, sword, bow, leather, plate
      bulk: "all",        // all | 0 | L | 1 | 2 | 3 | 4plus
      magical: "all",     // all | yes | no
    };
    this._actorHookId = null;
    this.compareSet = new Set(); // item ids selected for comparison
    this.transactions = [];      // session log: { kind: "buy"|"sell", name, qty, cp, when }
    this.cart = new Cart();
    this.filters.wishlistOnly = false;
  }

  mount() {
    if (this.root) return;
    const root = document.createElement("div");
    root.id = "pf2e-cd-mer-root";
    root.innerHTML = this._html();
    document.body.appendChild(root);
    this.root = root;

    this.refs = {
      frame:        root.querySelector(".pf2e-cd-mer-frame"),
      title:        root.querySelector(".pf2e-cd-mer-title"),
      subtitle:     root.querySelector(".pf2e-cd-mer-subtitle"),
      closeBtn:     root.querySelector(".pf2e-cd-mer-close"),
      popoutBtn:    root.querySelector(".pf2e-cd-mer-popout"),
      search:       root.querySelector("[name=mer-search]"),
      raritySel:    root.querySelector("[name=mer-rarity]"),
      levelMin:     root.querySelector("[name=mer-level-min]"),
      levelMax:     root.querySelector("[name=mer-level-max]"),
      usageSel:     root.querySelector("[name=mer-usage]"),
      groupSel:     root.querySelector("[name=mer-group]"),
      bulkSel:      root.querySelector("[name=mer-bulk]"),
      magicalSel:   root.querySelector("[name=mer-magical]"),
      filtersAdv:   root.querySelector("[data-role=merchant-filters-advanced]"),
      filtersToggleBtn: root.querySelector("[data-action=filters-toggle]"),
      filtersBar:   root.querySelector(".pf2e-cd-mer-filters"),
      backBar:      root.querySelector(".pf2e-cd-mer-back-bar"),
      backBtn:      root.querySelector("[data-action=back]"),
      currentCat:   root.querySelector(".pf2e-cd-mer-current-cat"),
      itemList:     root.querySelector(".pf2e-cd-mer-items"),
      empty:        root.querySelector(".pf2e-cd-mer-empty"),
      sellBar:      root.querySelector(".pf2e-cd-mer-sell-bar"),
      sellOpenBtn:  root.querySelector("[data-action=open-sell]"),
      gmToolbar:    root.querySelector(".pf2e-cd-mer-gm-toolbar"),
      gmImportBtn:  root.querySelector("[data-action=gm-import]"),
      gmClearBtn:   root.querySelector("[data-action=gm-clear]"),
      gmSettingsBtn:root.querySelector("[data-action=gm-settings]"),
      gmHistoryBtn: root.querySelector("[data-action=gm-history]"),
      portraitImg:  root.querySelector(".pf2e-cd-mer-portrait-img"),
      portraitFrame:root.querySelector(".pf2e-cd-mer-portrait-frame"),
      portraitFlip: root.querySelector(".pf2e-cd-mer-portrait-flip"),
      sortSel:      root.querySelector("[name=mer-sort]"),
      affordableCb: root.querySelector("[name=mer-affordable]"),
      compareBar:   root.querySelector(".pf2e-cd-mer-compare-bar"),
      compareCount: root.querySelector(".pf2e-cd-mer-compare-count"),
      compareOpenBtn: root.querySelector("[data-action=compare-open]"),
      compareClearBtn:root.querySelector("[data-action=compare-clear]"),
      cartBtn:      root.querySelector(".pf2e-cd-mer-cart-floating"),
      cartCount:    root.querySelector(".pf2e-cd-mer-cart-count"),
      wishlistCb:   root.querySelector("[name=mer-wishlist]"),
      gmRandomBtn:  root.querySelector("[data-action=gm-random]"),
      vaultBtn:     root.querySelector("[data-action=open-vault]"),
      vaultCount:   root.querySelector(".pf2e-cd-mer-vault-count"),
      header:       root.querySelector(".pf2e-cd-mer-header"),
      dailyOffers:  root.querySelector(".pf2e-cd-mer-daily-offers"),
    };

    this._wireUI();
    this._wireDrag();
    this._wireResize();
    this._restoreWindowPosition();
    this._restoreWindowSize();
  }

  _wireDrag() {
    const handle = this.refs.header;
    const frame = this.refs.frame;
    if (!handle || !frame) return;
    handle.classList.add("is-drag-handle");

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let activePointerId = null;

    const isInteractive = (target) =>
      !!target.closest?.("button, a, input, select, textarea, [data-role]");

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      if (isInteractive(e.target)) return;
      const rect = frame.getBoundingClientRect();
      // Switch to absolute pixel positioning so deltas work intuitively.
      frame.style.left = `${rect.left}px`;
      frame.style.top = `${rect.top}px`;
      frame.style.transform = "none";
      frame.classList.add("is-dragged", "is-dragging");
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      activePointerId = e.pointerId;
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (activePointerId !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Clamp so the header always stays grab-able (>=40px visible on each edge).
      const margin = 40;
      const maxLeft = window.innerWidth - margin;
      const maxTop = window.innerHeight - margin;
      const minLeft = margin - frame.offsetWidth;
      const minTop = 0;
      const left = Math.min(maxLeft, Math.max(minLeft, startLeft + dx));
      const top  = Math.min(maxTop,  Math.max(minTop,  startTop  + dy));
      frame.style.left = `${left}px`;
      frame.style.top  = `${top}px`;
    };

    const onPointerUp = (e) => {
      if (activePointerId !== e.pointerId) return;
      activePointerId = null;
      handle.releasePointerCapture?.(e.pointerId);
      frame.classList.remove("is-dragging");
      this._saveWindowPosition();
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    // Double-click on the header resets back to centered.
    handle.addEventListener("dblclick", (e) => {
      if (isInteractive(e.target)) return;
      this._resetWindowPosition();
    });
  }

  _saveWindowPosition() {
    const frame = this.refs.frame;
    if (!frame) return;
    const left = parseFloat(frame.style.left);
    const top  = parseFloat(frame.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    try {
      localStorage.setItem(`${MODULE_ID}:windowPos`, JSON.stringify({ left, top }));
    } catch {}
  }

  _restoreWindowPosition() {
    const frame = this.refs.frame;
    if (!frame) return;
    let saved = null;
    try {
      const raw = localStorage.getItem(`${MODULE_ID}:windowPos`);
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
    const margin = 40;
    const left = Math.min(window.innerWidth - margin, Math.max(margin - frame.offsetWidth || -600, saved.left));
    const top  = Math.min(window.innerHeight - margin, Math.max(0, saved.top));
    frame.style.left = `${left}px`;
    frame.style.top  = `${top}px`;
    frame.style.transform = "none";
    frame.classList.add("is-dragged");
  }

  _resetWindowPosition() {
    const frame = this.refs.frame;
    if (!frame) return;
    frame.classList.remove("is-dragged");
    frame.style.left = "";
    frame.style.top = "";
    frame.style.transform = "";
    try { localStorage.removeItem(`${MODULE_ID}:windowPos`); } catch {}
  }

  // === Resize via bottom-right grip handle ================================

  _wireResize() {
    const frame = this.refs.frame;
    const handle = frame?.querySelector("[data-role=resize-handle]");
    if (!frame || !handle) return;

    const MIN_W = 480;
    const MIN_H = 420;

    let startX = 0, startY = 0, startW = 0, startH = 0;
    let activePointerId = null;

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      // Skip when popped out — the OS window handles its own size.
      if (this.root?.classList.contains("is-popped-out")) return;
      const rect = frame.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      activePointerId = e.pointerId;
      handle.setPointerCapture?.(e.pointerId);
      // Drop the centering transform so explicit width/height take over.
      // If the frame hasn't been dragged yet, lock its current position so
      // resizing doesn't snap it back to center.
      if (!frame.classList.contains("is-dragged")) {
        frame.style.left = `${rect.left}px`;
        frame.style.top = `${rect.top}px`;
        frame.style.transform = "none";
        frame.classList.add("is-dragged");
      }
      frame.classList.add("is-resizing");
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e) => {
      if (activePointerId !== e.pointerId) return;
      const margin = 12;
      const maxW = window.innerWidth - margin * 2;
      const maxH = window.innerHeight - margin * 2;
      const w = Math.max(MIN_W, Math.min(maxW, startW + (e.clientX - startX)));
      const h = Math.max(MIN_H, Math.min(maxH, startH + (e.clientY - startY)));
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
      frame.style.maxHeight = `${h}px`;
    };

    const onPointerUp = (e) => {
      if (activePointerId !== e.pointerId) return;
      activePointerId = null;
      handle.releasePointerCapture?.(e.pointerId);
      frame.classList.remove("is-resizing");
      this._saveWindowSize();
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    // Double-click resets to default (clamp-based) sizing.
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this._resetWindowSize();
    });
  }

  _saveWindowSize() {
    const frame = this.refs.frame;
    if (!frame) return;
    const w = parseFloat(frame.style.width);
    const h = parseFloat(frame.style.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    try {
      localStorage.setItem(`${MODULE_ID}:windowSize`, JSON.stringify({ w, h }));
    } catch {}
  }

  _restoreWindowSize() {
    const frame = this.refs.frame;
    if (!frame) return;
    let saved = null;
    try {
      const raw = localStorage.getItem(`${MODULE_ID}:windowSize`);
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (!saved || !Number.isFinite(saved.w) || !Number.isFinite(saved.h)) return;
    const margin = 12;
    const w = Math.max(480, Math.min(window.innerWidth - margin * 2, saved.w));
    const h = Math.max(420, Math.min(window.innerHeight - margin * 2, saved.h));
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.style.maxHeight = `${h}px`;
  }

  _resetWindowSize() {
    const frame = this.refs.frame;
    if (!frame) return;
    frame.style.width = "";
    frame.style.height = "";
    frame.style.maxHeight = "";
    try { localStorage.removeItem(`${MODULE_ID}:windowSize`); } catch {}
  }

  // === Popout into a separate OS-level browser window =====================
  // Foundry V14 supports popout for ApplicationV2 natively, but our merchant
  // is a raw DOM tree. We achieve the same effect by physically moving the
  // root element into a new same-origin window — event handlers and Foundry
  // globals continue to work because we share the JS context (window.opener).
  // Sibling modals (cart, sell, compare, vault, picker, random) move along
  // so they remain reachable from the popped-out window.

  togglePopout() {
    if (this._popoutWin && !this._popoutWin.closed) {
      this._popoutWin.close();
      return;
    }
    this._openPopout();
  }

  async _openPopout() {
    if (!this.root) return;
    const frame = this.refs.frame;
    const w = Math.max(720, frame?.offsetWidth ?? 900);
    const h = Math.max(560, frame?.offsetHeight ?? 720);
    const features = `width=${w + 40},height=${h + 60},menubar=no,toolbar=no,location=no,status=no,resizable=yes`;
    const win = window.open("about:blank", `${MODULE_ID}-${this.actor?.id ?? "merchant"}`, features);
    if (!win) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.popoutBlocked"));
      return;
    }
    this._popoutWin = win;

    // Wait until the new document is ready.
    if (win.document.readyState !== "complete") {
      await new Promise(res => win.addEventListener("load", res, { once: true }));
    }

    // Mirror Foundry's stylesheets so the merchant looks identical in the
    // popped-out window. Same-origin: absolute hrefs (which Foundry uses) load
    // directly; relative ones are resolved against the main doc's baseURI.
    win.document.title = `${this.actor?.name ?? "Merchant"} — ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.subtitle")}`;
    const head = win.document.head;
    for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
      const clone = node.cloneNode(true);
      const href = node.getAttribute?.("href");
      if (href) clone.setAttribute("href", new URL(href, document.baseURI).href);
      head.appendChild(clone);
    }

    // Bare-bones body styling — the moved root takes care of the rest.
    win.document.body.style.cssText = `
      margin: 0; padding: 0;
      background: rgba(0,0,0,0.85);
      height: 100vh; overflow: hidden;
      font-family: inherit;
    `;

    // Move our own roots + any side-modals so the popout window is fully
    // self-contained for the typical interactions.
    this.root.classList.add("is-popped-out");
    this._popoutMovedNodes = [];
    const selectors = [
      "#pf2e-cd-mer-root",
      "#pf2e-cd-mer-cart-root",
      "#pf2e-cd-mer-sell-root",
      "#pf2e-cd-mer-compare-root",
      "#pf2e-cd-mer-vault-root",
      "#pf2e-cd-mer-picker-root",
      "#pf2e-cd-mer-random-root",
      "#pf2e-cd-mer-random-loader",
      "#pf2e-cd-mer-item-details-root",
    ];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      this._popoutMovedNodes.push({ node, parent: node.parentNode, next: node.nextSibling });
      win.document.body.appendChild(node);
    }

    // When the popout closes, dock everything back.
    const onUnload = () => this._restoreFromPopout();
    win.addEventListener("beforeunload", onUnload);
    win.addEventListener("unload", onUnload);
    // Also restore on viewer page navigation just in case.
    window.addEventListener("beforeunload", () => {
      try { win.close(); } catch {}
    }, { once: true });
  }

  _restoreFromPopout() {
    if (!this._popoutMovedNodes) return;
    for (const { node, parent, next } of this._popoutMovedNodes) {
      try {
        if (next && next.parentNode === parent) parent.insertBefore(node, next);
        else parent.appendChild(node);
      } catch (err) {
        // Parent might be gone (rare) — fall back to body.
        document.body.appendChild(node);
      }
    }
    this._popoutMovedNodes = null;
    this.root?.classList.remove("is-popped-out");
    this._popoutWin = null;
  }

  open(actor, tile = null) {
    if (!this.root) this.mount();
    if (!actor) return;
    this.actor = actor;
    this.tile = tile;
    this.viewer = this._pickViewer();
    // GM auto-heal: every time the GM opens a merchant, make sure players
    // have OWNER permission on that Loot actor so they can transact directly.
    if (game.user.isGM) ensureMerchantOwnership(actor);
    this.viewMode = "categories";
    this.filters.category = "all";
    this.compareSet = new Set();
    this.transactions = [];
    this.cart.clear();
    this.filters.wishlistOnly = false;
    if (this.refs.wishlistCb) this.refs.wishlistCb.checked = false;
    this._refreshHeader();
    this._refreshPortrait();
    this._refreshGold();
    this._refreshCompareBar();
    this._refreshCartBar();
    this._refreshVaultBar();
    this._renderItems();
    playOpen();
    playGreetingSounds(getMerchantGreetingSounds(this.actor));

    // Watch for inventory changes
    if (this._actorHookId) Hooks.off("updateActor", this._actorHookId);
    this._actorHookId = Hooks.on("updateActor", (a) => {
      if (a.id === this.actor?.id || a.id === this.viewer?.id) {
        this._refreshGold();
        this._renderItems();
      }
    });
    Hooks.on("createItem", (item) => {
      const parent = item.parent;
      if (parent?.id === this.actor?.id || parent?.id === this.viewer?.id) this._renderItems();
    });
    Hooks.on("deleteItem", (item) => {
      const parent = item.parent;
      if (parent?.id === this.actor?.id || parent?.id === this.viewer?.id) this._renderItems();
    });
    Hooks.on("updateItem", (item) => {
      const parent = item.parent;
      if (parent?.id === this.actor?.id || parent?.id === this.viewer?.id) this._renderItems();
    });
    Hooks.on("updateActor", (a) => {
      // Vault count lives on the viewer's flags — refresh the badge too.
      if (a.id === this.viewer?.id) this._refreshVaultBar();
    });

    this.root.classList.add("is-active");
    this.refs.frame.classList.remove("is-revealed");
    void this.refs.frame.offsetWidth;
    requestAnimationFrame(() => this.refs.frame.classList.add("is-revealed"));
  }

  close() {
    if (!this.root) return;
    this._postTransactionLog();
    // If popped out, fold the window back into the main doc before hiding.
    if (this._popoutWin && !this._popoutWin.closed) {
      try { this._popoutWin.close(); } catch {}
    }
    // Reset filters so the next open starts clean.
    this._resetAllFilters();
    this.viewMode = "categories";
    this.root.classList.remove("is-active");
    this.refs.frame.classList.remove("is-revealed");
    if (this._actorHookId) {
      Hooks.off("updateActor", this._actorHookId);
      this._actorHookId = null;
    }
  }

  _postTransactionLog() {
    if (!this.transactions || this.transactions.length === 0) return;
    const merchantName = escapeHTML(this.actor?.name ?? "—");
    const viewerName = escapeHTML(this.viewer?.name ?? "—");
    let totalBuy = 0;
    let totalSell = 0;
    const lines = this.transactions.map(t => {
      if (t.kind === "buy") totalBuy += t.cp;
      else totalSell += t.cp;
      const verb = game.i18n.localize(t.kind === "buy"
        ? "PF2E_CINEMATIC_MERCHANT.chat.bought"
        : "PF2E_CINEMATIC_MERCHANT.chat.sold");
      const qtyTag = t.qty > 1 ? `<span class="pf2e-cd-mer-log-qty">×${t.qty}</span>` : "";
      return `<li><span class="pf2e-cd-mer-log-verb pf2e-cd-mer-log-${t.kind}">${verb}</span> <strong>${escapeHTML(t.name)}</strong> ${qtyTag} <span class="pf2e-cd-mer-log-price">${formatCopper(t.cp)}</span></li>`;
    }).join("");
    const net = totalSell - totalBuy;
    const netCls = net >= 0 ? "pos" : "neg";
    const netLabel = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.log.net");
    const summaryLabel = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.log.summary");
    const sessionLabel = game.i18n.format("PF2E_CINEMATIC_MERCHANT.log.session", {
      viewer: viewerName,
      merchant: merchantName,
    });
    const content = `
      <div class="pf2e-cd-mer-log-card">
        <div class="pf2e-cd-mer-log-title">${summaryLabel}</div>
        <div class="pf2e-cd-mer-log-sub">${sessionLabel}</div>
        <ul class="pf2e-cd-mer-log-list">${lines}</ul>
        <div class="pf2e-cd-mer-log-net pf2e-cd-mer-log-net-${netCls}">
          ${netLabel}: ${net >= 0 ? "+" : "−"}${formatCopper(Math.abs(net))}
        </div>
      </div>
    `;
    try {
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.viewer ?? this.actor }),
        content,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | transaction log post failed:`, err);
    }
    this.transactions = [];
  }

  _logTransaction(kind, name, qty, cp, opts = {}) {
    const when = Date.now();
    this.transactions.push({ kind, name, qty, cp, when });
    // Best-effort persistent log on the merchant actor. Players who reached
    // this path have owner permission (granted by ensureMerchantOwnership),
    // so the actor.update inside recordMerchantTransaction will succeed for
    // them too. If permission is missing for some edge case, the GM-relay
    // path in gm-ops.js logs server-side instead.
    if (this.actor) {
      recordMerchantTransaction(this.actor, {
        kind,
        characterId: this.viewer?.id ?? "",
        characterName: this.viewer?.name ?? "—",
        userName: game.user?.name,
        itemName: name,
        itemImg: opts.img ?? null,
        qty,
        cp,
        when,
      });
    }
  }

  _pickViewer() {
    if (game.user.isGM) return null;
    const own = game.user.character;
    if (own?.type === "character") return own;
    return game.actors?.find?.(a => a.type === "character" && a.testUserPermission?.(game.user, "OWNER")) ?? null;
  }

  _refreshHeader() {
    this.refs.title.textContent = this.actor?.name ?? "—";
    this.refs.subtitle.textContent = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.subtitle");
    if (this.refs.gmToolbar) this.refs.gmToolbar.hidden = !game.user.isGM;
  }

  _refreshCompareBar() {
    if (!this.refs?.compareBar) return;
    const n = this.compareSet.size;
    const visible = n >= 1 && this.viewMode === "items";
    this.refs.compareBar.hidden = !visible;
    if (this.refs.compareCount) {
      this.refs.compareCount.textContent = String(n);
    }
    if (this.refs.compareOpenBtn) {
      this.refs.compareOpenBtn.disabled = n < 2;
    }
  }

  _refreshPortrait() {
    if (!this.refs.portraitImg) return;
    // Prefer the tile's texture (the GM picked it for the scene); fall back to actor.img.
    const tileSrc = this.tile?.document?.texture?.src;
    const src = tileSrc || this.actor?.img;
    if (src) {
      this.refs.portraitImg.src = src;
      this.refs.portraitImg.hidden = false;
    } else {
      this.refs.portraitImg.hidden = true;
    }
    // Apply mirror state and show/hide the GM flip button.
    const mirrored = getMerchantPortraitMirrored(this.actor);
    this.refs.portraitImg.classList.toggle("is-mirrored", mirrored);
    if (this.refs.portraitFlip) {
      this.refs.portraitFlip.hidden = !game.user.isGM;
      this.refs.portraitFlip.classList.toggle("is-active", mirrored);
    }
  }

  async _handleTogglePortraitMirror() {
    if (!game.user.isGM || !this.actor) return;
    const next = !getMerchantPortraitMirrored(this.actor);
    await setMerchantPortraitMirrored(this.actor, next);
    this._refreshPortrait();
  }

  _refreshGold() {
    // The header purse badge was removed — the player's gold is no longer
    // surfaced in the merchant header. Kept as a no-op so existing callers
    // don't have to change.
  }

  _wireUI() {
    this.refs.closeBtn.addEventListener("click", () => this.close());
    this.refs.popoutBtn?.addEventListener("click", () => this.togglePopout());
    this.refs.portraitFlip?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._handleTogglePortraitMirror();
    });

    if (this.refs.gmImportBtn)   this.refs.gmImportBtn.addEventListener("click", () => this._handleImport());
    if (this.refs.gmClearBtn)    this.refs.gmClearBtn.addEventListener("click",  () => this._handleClearAll());
    if (this.refs.gmSettingsBtn) this.refs.gmSettingsBtn.addEventListener("click", () => this._handleOpenSettings());
    if (this.refs.gmHistoryBtn)  this.refs.gmHistoryBtn.addEventListener("click",  () => this._handleOpenHistory());
    if (this.refs.sellOpenBtn)   this.refs.sellOpenBtn.addEventListener("click",  () => this._handleOpenSellList());

    const debounced = this._debounce(() => this._renderItems(), 120);
    this.refs.search.addEventListener("input", () => { this.filters.search = this.refs.search.value.trim().toLowerCase(); debounced(); });
    this.refs.raritySel.addEventListener("change", () => { this.filters.rarity = this.refs.raritySel.value; this._renderItems(); });
    this.refs.backBtn.addEventListener("click", () => this._goBackToCategories());
    this.refs.levelMin.addEventListener("input", () => {
      const v = this.refs.levelMin.value;
      this.filters.levelMin = v === "" ? null : Number(v);
      debounced();
    });
    this.refs.levelMax.addEventListener("input", () => {
      const v = this.refs.levelMax.value;
      this.filters.levelMax = v === "" ? null : Number(v);
      debounced();
    });
    this.refs.sortSel.addEventListener("change", () => { this.filters.sort = this.refs.sortSel.value; this._renderItems(); });
    this.refs.affordableCb.addEventListener("change", () => { this.filters.affordableOnly = this.refs.affordableCb.checked; this._renderItems(); });
    this.refs.usageSel?.addEventListener("change", () => { this.filters.usage = this.refs.usageSel.value; this._renderItems(); });
    this.refs.groupSel?.addEventListener("change", () => { this.filters.group = this.refs.groupSel.value; this._renderItems(); });
    this.refs.bulkSel?.addEventListener("change", () => { this.filters.bulk = this.refs.bulkSel.value; this._renderItems(); });
    this.refs.magicalSel?.addEventListener("change", () => { this.filters.magical = this.refs.magicalSel.value; this._renderItems(); });
    this.refs.filtersToggleBtn?.addEventListener("click", () => {
      const bar = this.refs.filtersBar;
      const collapsed = bar.classList.toggle("is-collapsed");
      if (this.refs.filtersAdv) this.refs.filtersAdv.hidden = collapsed;
      const chev = this.refs.filtersToggleBtn.querySelector("i");
      if (chev) chev.className = collapsed ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-up";
    });

    if (this.refs.compareOpenBtn) this.refs.compareOpenBtn.addEventListener("click", () => this._openCompareModal());
    if (this.refs.compareClearBtn) this.refs.compareClearBtn.addEventListener("click", () => this._clearCompare());
    if (this.refs.cartBtn) this.refs.cartBtn.addEventListener("click", () => this._openCart());
    if (this.refs.gmRandomBtn) this.refs.gmRandomBtn.addEventListener("click", () => this._handleRandomStock());
    if (this.refs.vaultBtn) this.refs.vaultBtn.addEventListener("click", () => this._openVault());
    if (this.refs.wishlistCb) this.refs.wishlistCb.addEventListener("change", () => {
      this.filters.wishlistOnly = !!this.refs.wishlistCb.checked;
      this._renderItems();
    });

    // Single delegated click handler on the items container — handles row click, buy, edit-price, delete.
    this.refs.itemList.addEventListener("click", (e) => this._onItemListClick(e));
    this.refs.itemList.addEventListener("change", (e) => this._onItemListChange(e));

    // ESC closes
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });

    // Global click-feedback sound on any interactive element inside the window.
    this.root.addEventListener("click", (e) => {
      const t = e.target;
      if (!t?.closest) return;
      // Match real interactive things (buttons, action attributes, tiles,
      // filter pills, dropdown options) — skip plain text / row body clicks
      // so we don't spam the sound during navigation.
      const isInteractive = t.closest(
        "button, [data-action], select, input[type=checkbox], input[type=radio], " +
        ".pf2e-cd-mer-cat-tile, .pf2e-cd-mer-filter-toggle, .pf2e-cd-mer-compare-btn, " +
        ".pf2e-cd-mer-wishlist-btn, .pf2e-cd-mer-cart-add-btn"
      );
      if (isInteractive) playClick();
    });
  }

  _onItemListClick(e) {
    // Don't treat clicks on the qty input or compare button as a row open.
    if (e.target.closest("[data-role=qty-input]") || e.target.closest(".pf2e-cd-mer-compare-btn")) {
      e.stopPropagation();
      return;
    }
    const qtyMinus = e.target.closest("[data-action=qty-minus]");
    if (qtyMinus) { e.stopPropagation(); this._adjustRowQty(qtyMinus.dataset.itemId, -1); return; }
    const qtyPlus = e.target.closest("[data-action=qty-plus]");
    if (qtyPlus)  { e.stopPropagation(); this._adjustRowQty(qtyPlus.dataset.itemId, +1); return; }
    const cartAddBtn = e.target.closest("[data-action=cart-add]");
    if (cartAddBtn) { e.stopPropagation(); this._handleAddToCart(cartAddBtn.dataset.itemId); return; }
    const wishBtn = e.target.closest("[data-action=wishlist-toggle]");
    if (wishBtn) { e.stopPropagation(); this._handleWishlistToggle(wishBtn.dataset.itemId); return; }
    const buyBtn  = e.target.closest("[data-action=buy]");
    if (buyBtn)  { e.stopPropagation(); this._handleBuy(buyBtn.dataset.itemId); return; }
    const editBtn = e.target.closest("[data-action=edit-price]");
    if (editBtn) { e.stopPropagation(); this._handleEditPrice(editBtn.dataset.itemId); return; }
    const editQtyBtn = e.target.closest("[data-action=edit-qty]");
    if (editQtyBtn) { e.stopPropagation(); this._handleEditQty(editQtyBtn.dataset.itemId); return; }
    const editOfferBtn = e.target.closest("[data-action=edit-offer]");
    if (editOfferBtn) { e.stopPropagation(); this._handleEditOffer(editOfferBtn.dataset.itemId); return; }
    const delBtn  = e.target.closest("[data-action=delete]");
    if (delBtn)  { e.stopPropagation(); this._handleDelete(delBtn.dataset.itemId); return; }
    // Service handlers
    const svcBuy = e.target.closest("[data-action=service-buy]");
    if (svcBuy) { e.stopPropagation(); this._handleBuyService(svcBuy.dataset.serviceId); return; }
    const svcAdd = e.target.closest("[data-action=service-add]");
    if (svcAdd) { e.stopPropagation(); this._handleServiceEdit(null); return; }
    const svcClear = e.target.closest("[data-action=service-clear-all]");
    if (svcClear) { e.stopPropagation(); this._handleServiceClearAll(); return; }
    const svcEdit = e.target.closest("[data-action=service-edit]");
    if (svcEdit) { e.stopPropagation(); this._handleServiceEdit(svcEdit.dataset.serviceId); return; }
    const svcDel = e.target.closest("[data-action=service-delete]");
    if (svcDel) { e.stopPropagation(); this._handleServiceDelete(svcDel.dataset.serviceId); return; }
    const svcRow = e.target.closest(".pf2e-cd-mer-service-row");
    if (svcRow) { this._showServiceDetails(svcRow.dataset.serviceId); return; }
    const row = e.target.closest(".pf2e-cd-mer-item");
    if (row) this._handleShowDetails(row.dataset.itemId);
  }

  async _handleWishlistToggle(itemId) {
    const item = this.actor?.items?.get?.(itemId);
    if (!item) return;
    await toggleWishlist(item);
    this._renderItems();
  }

  _handleAddToCart(itemId) {
    const item = this.actor?.items?.get?.(itemId);
    if (!item) return;
    const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
    const want = this._readRowQty(itemId);
    const cur = this.cart.items.get(itemId) ?? 0;
    const next = Math.max(1, Math.min(stockQty, cur + want));
    this.cart.set(itemId, next);
    this._refreshCartBar();
  }

  _refreshCartBar() {
    if (!this.refs?.cartBtn) return;
    if (!this.viewer) {
      this.refs.cartBtn.hidden = true;
      return;
    }
    this.cart.reconcile(this.actor);
    const n = this.cart.size();
    const total = this.cart.totalCp(this.actor);
    this.refs.cartBtn.hidden = false;
    if (n === 0) {
      this.refs.cartBtn.classList.remove("has-items");
    } else {
      this.refs.cartBtn.classList.add("has-items");
    }
    if (this.refs.cartCount) {
      this.refs.cartCount.textContent = n > 0 ? `${n} · ${formatCopper(total)}` : "0";
    }
  }

  _openCart() {
    if (!this.viewer || !this.actor) return;
    openCartDrawer(this.cart, this.actor, this.viewer, {
      onChanged: () => { this._refreshCartBar(); this._renderItems(); },
      onCheckout: (lines) => this._checkoutCart(lines),
    });
  }

  async _checkoutCart(lines) {
    if (!this.viewer || !this.actor) return;
    const totalCp = lines.reduce((s, l) => s + l.lineCp, 0);
    const buyerCp = priceToCopper({ value: readActorCoins(this.viewer) });
    if (buyerCp < totalCp) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.notEnoughGold"));
      throw new Error("not_enough_gold");
    }
    let usedDirectPath = false;
    try {
      if (this._hasMerchantOwnership()) {
        usedDirectPath = true;
        await deductCoins(this.viewer, totalCp);
        await addCoins(this.actor, totalCp);
        const itemsToCreate = [];
        const merchantUpdates = [];
        const merchantDeletes = [];
        for (const line of lines) {
          const data = line.item.toObject();
          delete data._id;
          data.system = foundry.utils.duplicate(data.system);
          if (data.system.quantity != null) data.system.quantity = line.qty;
          if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID];
          itemsToCreate.push(data);
          if (line.stockQty > line.qty) merchantUpdates.push({ _id: line.item.id, "system.quantity": line.stockQty - line.qty });
          else merchantDeletes.push(line.item.id);
        }
        if (itemsToCreate.length > 0) await this.viewer.createEmbeddedDocuments("Item", itemsToCreate);
        if (merchantUpdates.length > 0) await this.actor.updateEmbeddedDocuments("Item", merchantUpdates);
        if (merchantDeletes.length > 0) await this.actor.deleteEmbeddedDocuments("Item", merchantDeletes);
      } else if (game.users?.activeGM) {
        await callGM("merchant.checkout", {
          merchantId: this.actor.id, viewerId: this.viewer.id,
          lines: lines.map(l => ({ itemId: l.item.id, qty: l.qty })),
        });
      } else {
        throw new Error("no_permission_no_gm");
      }
      // Cart-specific logging: avoid the race condition where each per-line
      // recordMerchantTransaction reads the same starting log + appends 1 +
      // writes back in parallel, leaving only the last entry persisted.
      // Push to session log immediately, then batch-persist in ONE update.
      const when = Date.now();
      for (const l of lines) {
        this.transactions.push({ kind: "buy", name: l.item.name, qty: l.qty, cp: l.lineCp, when });
      }
      // Skip persistent write when the GM relay handled it — gm-ops logs
      // each line server-side already.
      if (usedDirectPath) {
        await recordMerchantTransactions(this.actor, lines.map(l => ({
          kind: "buy",
          characterId: this.viewer.id, characterName: this.viewer.name,
          userName: game.user?.name,
          itemName: l.item.name, itemImg: l.item.img,
          qty: l.qty, cp: l.lineCp,
          when,
        })));
      }
      playBuy();
      const itemCount = lines.reduce((n, l) => n + l.qty, 0);
      const distinct = lines.length;
      const summaryName = distinct === 1
        ? lines[0].item.name
        : game.i18n.format("PF2E_CINEMATIC_MERCHANT.toast.checkoutItems", { count: distinct });
      this._showTransactionPopup({
        kind: "checkout",
        name: summaryName,
        img: distinct === 1 ? lines[0].item.img : "icons/svg/chest.svg",
        qty: itemCount,
        price: formatCopper(totalCp),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | checkout failed:`, err);
      const m = err?.message === "no_permission_no_gm"
        ? game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.needGMPermission")
        : this._permissionErrorMessage(err, "buy");
      ui.notifications?.error(m);
      throw err;
    }
  }

  async _handleRandomStock() {
    if (!game.user.isGM || !this.actor) return;
    openRandomStockDialog(this.actor, () => this._renderItems());
  }

  _openVault() {
    if (!this.viewer) return;
    openVault(this.viewer);
  }

  _refreshVaultBar() {
    if (!this.refs?.vaultBtn) return;
    const visible = !!this.viewer;
    this.refs.vaultBtn.hidden = !visible;
    if (visible && this.refs.vaultCount) {
      const n = vaultCount(this.viewer);
      this.refs.vaultCount.textContent = n > 0 ? String(n) : "";
      this.refs.vaultCount.hidden = n === 0;
    }
  }

  async _handleEditOffer(itemId) {
    if (!game.user.isGM || !this.actor) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    const current = Math.round(getItemDailyOfferPct(item) * 100);
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    await DialogV2.prompt({
      window: { title: game.i18n.format("PF2E_CINEMATIC_MERCHANT.window.editOfferFor", { item: item.name }) },
      content: `
        <form class="pf2e-cd-mer-qty-form">
          <label>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editOffer")}
            <input type="number" name="offerPct" min="0" max="95" step="5" value="${current}" autofocus />
          </label>
          <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editOfferHint")}</p>
        </form>
      `,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-qty-dialog"],
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.savePrice"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const raw = Number(root?.querySelector("[name=offerPct]")?.value ?? 0);
          const pct = Math.max(0, Math.min(95, Math.floor(raw))) / 100;
          await setItemDailyOfferPct(item, pct);
        },
      },
    });
  }

  async _handleEditQty(itemId) {
    if (!game.user.isGM || !this.actor) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    const current = Math.max(1, Number(item.system?.quantity ?? 1));
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    await DialogV2.prompt({
      window: { title: game.i18n.format("PF2E_CINEMATIC_MERCHANT.window.editQtyFor", { item: item.name }) },
      content: `
        <form class="pf2e-cd-mer-qty-form">
          <label>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editQty")}
            <input type="number" name="qty" min="0" step="1" value="${current}" autofocus />
          </label>
          <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editQtyHint")}</p>
        </form>
      `,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-qty-dialog"],
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.savePrice"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const v = Math.max(0, Math.floor(Number(root?.querySelector("[name=qty]")?.value ?? 0)) || 0);
          if (v <= 0) {
            await item.delete();
          } else {
            await item.update({ "system.quantity": v });
          }
        },
      },
    });
  }

  _onItemListChange(e) {
    const cb = e.target.closest("[data-role=compare-toggle]");
    if (cb) {
      const id = cb.dataset.itemId;
      if (cb.checked) this.compareSet.add(id);
      else this.compareSet.delete(id);
      this._refreshCompareBar();
      return;
    }
    const qtyInput = e.target.closest("[data-role=qty-input]");
    if (qtyInput) {
      this._sanitizeRowQty(qtyInput);
      return;
    }
  }

  _sanitizeRowQty(input) {
    const item = this.actor?.items?.get?.(input.dataset.itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value));
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > max) v = max;
    input.value = String(v);
  }

  _adjustRowQty(itemId, delta) {
    const input = this.refs.itemList.querySelector(`[data-role=qty-input][data-item-id="${itemId}"]`);
    if (!input) return;
    const item = this.actor?.items?.get?.(itemId);
    const max = Math.max(1, Number(item?.system?.quantity ?? 1));
    let v = Math.floor(Number(input.value)) || 1;
    v = Math.max(1, Math.min(max, v + delta));
    input.value = String(v);
  }

  _readRowQty(itemId) {
    const input = this.refs.itemList.querySelector(`[data-role=qty-input][data-item-id="${itemId}"]`);
    if (!input) return 1;
    const v = Math.floor(Number(input.value)) || 1;
    return Math.max(1, v);
  }

  _openCompareModal() {
    if (!this.actor) return;
    const items = [...this.compareSet]
      .map(id => this.actor.items.get(id))
      .filter(Boolean);
    if (items.length < 2) return;
    openCompareModal(items, {
      onRemove: (id) => {
        this.compareSet.delete(id);
        this._refreshCompareBar();
        this._renderItems();
      },
      onClear: () => this._clearCompare(),
    });
  }

  _clearCompare() {
    this.compareSet.clear();
    this._refreshCompareBar();
    this._renderItems();
  }

  _handleOpenSellList() {
    if (!this.viewer || !this.actor) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.noViewerActor"));
      return;
    }
    openSellList(this.viewer, this.actor, (item, qty) => this._sellItem(item, qty));
  }

  async _sellItem(item, requestedQty = 1) {
    if (!this.viewer || !this.actor || !item) return;
    if (item.parent?.id !== this.viewer.id) return;
    const baseCp = priceToCopper(item.system?.price);
    const rate = getMerchantSellRate(this.actor);
    const unitCp = Math.floor(baseCp * rate);
    if (unitCp <= 0) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.itemWorthless"));
      return;
    }
    const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
    const sellQty = Math.max(1, Math.min(stockQty, Math.floor(requestedQty) || 1));
    const totalCp = unitCp * sellQty;
    try {
      if (this._hasMerchantOwnership()) {
        await addCoins(this.viewer, totalCp);
        await deductCoins(this.actor, totalCp);
        const itemData = item.toObject();
        delete itemData._id;
        itemData.system = foundry.utils.duplicate(itemData.system);
        if (itemData.system.quantity != null) itemData.system.quantity = sellQty;
        await this.actor.createEmbeddedDocuments("Item", [itemData]);
        if (stockQty > sellQty) await item.update({ "system.quantity": stockQty - sellQty });
        else await item.delete();
      } else if (game.users?.activeGM) {
        await callGM("merchant.sell", {
          merchantId: this.actor.id, viewerId: this.viewer.id,
          itemId: item.id, qty: sellQty,
        });
      } else {
        throw new Error("no_permission_no_gm");
      }
      this._logTransaction("sell", item.name, sellQty, totalCp, { img: item.img });
      playSell();
      this._showTransactionPopup({
        kind: "sell", name: item.name, img: item.img, qty: sellQty, price: formatCopper(totalCp),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | sell failed:`, err);
      const m = err?.message === "no_permission_no_gm"
        ? game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.needGMPermission")
        : this._permissionErrorMessage(err, "sell");
      ui.notifications?.error(m);
    }
  }

  async _handleOpenSettings() {
    if (!this.actor) return;
    const markup = getMerchantMarkup(this.actor);
    const discounts = getMerchantRarityDiscounts(this.actor);
    const sellRate = getMerchantSellRate(this.actor);
    const greetingSounds = [...getMerchantGreetingSounds(this.actor)];
    const charDiscounts = { ...getMerchantCharacterDiscounts(this.actor) };
    // Collect player characters — type:"character" actors owned by any non-GM.
    const playerCharacters = (game.actors ?? []).filter(a => {
      if (a.type !== "character") return false;
      const owners = Object.entries(a.ownership ?? {})
        .filter(([uid, lvl]) => lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER && uid !== "default");
      return owners.some(([uid]) => {
        const u = game.users?.get?.(uid);
        return u && !u.isGM;
      });
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Build dropdown options for adding characters: every player character not
    // already in the discounts map.
    const renderAddOptions = () => playerCharacters
      .filter(c => !(c.id in charDiscounts))
      .map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`)
      .join("");

    const content = `
      <form class="pf2e-cd-mer-settings-form">
        <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.info")}</p>
        <fieldset class="pf2e-cd-mer-greeting-sounds-field">
          <legend>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSounds")}</legend>
          <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSoundsHint")}</p>
          <ul class="pf2e-cd-mer-greeting-sounds-list" data-role="greeting-list"></ul>
          <button type="button" class="pf2e-cd-mer-greeting-sounds-add" data-action="add-greeting-sound">
            <i class="fa-solid fa-plus"></i>
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSoundsAdd"))}</span>
          </button>
        </fieldset>
        <label>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.markup")}
          <input type="number" name="markup" min="0" max="5" step="0.05" value="${markup}" />
        </label>
        <label>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.sellRate")}
          <input type="number" name="sellRate" min="0" max="2" step="0.05" value="${sellRate}" />
        </label>
        <fieldset>
          <legend>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.rarityDiscounts")}</legend>
          <div class="pf2e-cd-mer-settings-rarity-grid">
            ${["common","uncommon","rare","unique"].map(r => `
              <label>
                <span>${escapeHTML(localizeRarity(r))}</span>
                <input type="number" name="r-${r}" min="-1" max="1" step="0.05" value="${discounts[r] ?? 0}" />
              </label>
            `).join("")}
          </div>
        </fieldset>
        <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.discountHint")}</p>
        ${playerCharacters.length > 0 ? `
          <fieldset class="pf2e-cd-mer-char-discounts-field">
            <legend>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscounts")}</legend>
            <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsHint")}</p>
            <div class="pf2e-cd-mer-char-discounts-add-row">
              <select data-role="char-disc-add">
                <option value="">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsPick"))}</option>
                ${renderAddOptions()}
              </select>
              <button type="button" data-action="char-disc-add">
                <i class="fa-solid fa-plus"></i>
                <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsAdd"))}</span>
              </button>
            </div>
            <ul class="pf2e-cd-mer-char-discounts-list" data-role="char-disc-list"></ul>
          </fieldset>
        ` : ""}
      </form>
    `;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    await DialogV2.prompt({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.title") },
      position: { width: 560 },
      content,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-settings-dialog"],
      render: (event, dialog) => {
        const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
        if (!root) return;
        this._wireGreetingSoundList(root, greetingSounds);
        this._wireCharacterDiscounts(root, { playerCharacters, charDiscounts });
      },
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.save"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const markupV = Number(root?.querySelector("[name=markup]")?.value ?? 1);
          const sellV = Number(root?.querySelector("[name=sellRate]")?.value ?? 0.5);
          const newDiscounts = {};
          for (const r of ["common","uncommon","rare","unique"]) {
            newDiscounts[r] = Number(root?.querySelector(`[name=r-${r}]`)?.value ?? 0);
          }
          // Collect per-character discounts from the dynamic list (UI in
          // percent → store as fraction).
          const newCharDiscounts = {};
          for (const row of root?.querySelectorAll(".pf2e-cd-mer-char-discount-row") ?? []) {
            const cid = row.dataset.characterId;
            if (!cid) continue;
            const raw = Number(row.querySelector("input[type=number]")?.value);
            if (Number.isFinite(raw)) {
              newCharDiscounts[cid] = Math.max(-1, Math.min(1, raw / 100));
            }
          }
          await setMerchantMarkup(this.actor, markupV);
          await setMerchantSellRate(this.actor, sellV);
          await setMerchantRarityDiscounts(this.actor, newDiscounts);
          await setMerchantGreetingSounds(this.actor, greetingSounds);
          await setMerchantCharacterDiscounts(this.actor, newCharDiscounts);
          this._refreshHeader();
          this._renderItems();
          this._refreshGold();
        },
      },
    });
  }

  _wireCharacterDiscounts(root, { playerCharacters, charDiscounts }) {
    const addSel = root.querySelector("[data-role=char-disc-add]");
    const addBtn = root.querySelector("[data-action=char-disc-add]");
    const list = root.querySelector("[data-role=char-disc-list]");
    if (!list) return;
    // Local working state — mirror what's currently selected. Mutated by
    // add/remove; the Save callback reads from the rendered rows.
    const active = { ...charDiscounts };

    const refreshAddOptions = () => {
      if (!addSel) return;
      const used = new Set(Object.keys(active));
      const opts = [`<option value="">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsPick"))}</option>`];
      for (const c of playerCharacters) {
        if (used.has(c.id)) continue;
        opts.push(`<option value="${c.id}">${escapeHTML(c.name)}</option>`);
      }
      addSel.innerHTML = opts.join("");
    };

    const renderList = () => {
      const ids = Object.keys(active);
      if (ids.length === 0) {
        list.innerHTML = `<li class="pf2e-cd-mer-char-discounts-empty">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsEmpty"))}</li>`;
        refreshAddOptions();
        return;
      }
      const byId = new Map(playerCharacters.map(c => [c.id, c]));
      list.innerHTML = ids.map(id => {
        const c = byId.get(id);
        if (!c) return "";
        const pct = Math.round(Number(active[id] ?? 0) * 100);
        const portrait = c.img ?? "icons/svg/mystery-man.svg";
        return `
          <li class="pf2e-cd-mer-char-discount-row" data-character-id="${c.id}">
            <img class="pf2e-cd-mer-char-discount-portrait" src="${escapeHTML(portrait)}" alt="" />
            <span class="pf2e-cd-mer-char-discount-name">${escapeHTML(c.name)}</span>
            <div class="pf2e-cd-mer-char-discount-input">
              <input type="number" min="-100" max="100" step="5" value="${pct}" />
              <b>%</b>
            </div>
            <button type="button" class="pf2e-cd-mer-char-discount-remove" data-action="char-disc-remove" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.characterDiscountsRemove"))}">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </li>
        `;
      }).join("");
      // Wire per-row events
      for (const row of list.querySelectorAll(".pf2e-cd-mer-char-discount-row")) {
        const cid = row.dataset.characterId;
        const inp = row.querySelector("input[type=number]");
        inp?.addEventListener("input", () => {
          const raw = Number(inp.value);
          if (Number.isFinite(raw)) active[cid] = Math.max(-1, Math.min(1, raw / 100));
        });
        row.querySelector("[data-action=char-disc-remove]")?.addEventListener("click", () => {
          delete active[cid];
          renderList();
        });
      }
      refreshAddOptions();
    };

    addBtn?.addEventListener("click", () => {
      const cid = addSel?.value;
      if (!cid) return;
      if (cid in active) return;
      active[cid] = 0.1; // default 10% discount; user can tweak
      addSel.value = "";
      renderList();
    });
    // Selecting from the dropdown adds immediately (no extra click required)
    addSel?.addEventListener("change", () => {
      const cid = addSel.value;
      if (!cid) return;
      if (cid in active) { addSel.value = ""; return; }
      active[cid] = 0.1;
      addSel.value = "";
      renderList();
    });

    renderList();
  }

  _wireGreetingSoundList(root, sounds) {
    const list = root.querySelector("[data-role=greeting-list]");
    const addBtn = root.querySelector("[data-action=add-greeting-sound]");
    if (!list || !addBtn) return;

    const renderRow = (path, idx) => {
      const li = document.createElement("li");
      li.className = "pf2e-cd-mer-greeting-sound-row";
      li.dataset.idx = String(idx);
      // Split path so the row shows just the filename prominently and the
      // parent folder muted next to it — full path stays in the tooltip.
      const parts = String(path).split(/[\\/]/);
      const fname = parts.pop() ?? path;
      const parent = parts.length > 0 ? parts[parts.length - 1] : "";
      li.innerHTML = `
        <button type="button" class="pf2e-cd-mer-greeting-sound-play" data-action="play" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSoundsPlay"))}">
          <i class="fa-solid fa-play"></i>
        </button>
        <div class="pf2e-cd-mer-greeting-sound-path" title="${escapeHTML(path)}">
          <span class="pf2e-cd-mer-greeting-sound-name">${escapeHTML(fname)}</span>
          ${parent ? `<span class="pf2e-cd-mer-greeting-sound-parent">${escapeHTML(parent)}/</span>` : ""}
        </div>
        <button type="button" class="pf2e-cd-mer-greeting-sound-remove" data-action="remove" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSoundsRemove"))}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      `;
      return li;
    };

    const renderList = () => {
      list.innerHTML = "";
      if (sounds.length === 0) {
        const li = document.createElement("li");
        li.className = "pf2e-cd-mer-greeting-sounds-empty";
        li.textContent = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingSoundsEmpty");
        list.appendChild(li);
        return;
      }
      sounds.forEach((p, i) => list.appendChild(renderRow(p, i)));
    };

    list.addEventListener("click", (e) => {
      const playBtn = e.target.closest("[data-action=play]");
      const removeBtn = e.target.closest("[data-action=remove]");
      const row = e.target.closest(".pf2e-cd-mer-greeting-sound-row");
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (playBtn) {
        previewSound(sounds[idx]);
      } else if (removeBtn) {
        sounds.splice(idx, 1);
        renderList();
      }
    });

    addBtn.addEventListener("click", async () => {
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      if (!FP) return;
      const picker = new FP({
        type: "audio",
        current: sounds[sounds.length - 1] ?? "",
        callback: (path) => {
          if (typeof path === "string" && path.length > 0 && !sounds.includes(path)) {
            sounds.push(path);
            renderList();
          }
        },
      });
      picker.render(true);
    });

    renderList();
  }

  _debounce(fn, ms) {
    let h;
    return (...args) => {
      clearTimeout(h);
      h = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  _renderItems() {
    if (!this.actor) return;
    if (this.refs.frame) {
      this.refs.frame.classList.toggle("is-categories-view", this.viewMode === "categories");
    }
    if (this.viewMode === "categories") {
      this._renderCategoryGrid();
    } else if (this.viewMode === "services") {
      this._renderServiceList();
    } else {
      this._renderItemList();
    }
    this._renderDailyOffers();
  }

  _renderDailyOffers() {
    const host = this.refs.dailyOffers;
    if (!host) return;
    const offers = getMerchantDailyOffers(this.actor);
    if (offers.length === 0) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    const cards = offers.slice(0, 6).map(item => {
      const pct = getItemDailyOfferPct(item);
      const cp = effectiveItemPriceCp(item);
      const orig = Math.round(cp / (1 - pct));
      const img = item.img ?? "icons/svg/item-bag.svg";
      return `
        <button type="button" class="pf2e-cd-mer-daily-offer-card" data-action="daily-offer-jump" data-item-id="${item.id}" title="${escapeHTML(item.name)}">
          <img class="pf2e-cd-mer-daily-offer-img" src="${escapeHTML(img)}" alt="" />
          <div class="pf2e-cd-mer-daily-offer-body">
            <div class="pf2e-cd-mer-daily-offer-name">${escapeHTML(item.name)}</div>
            <div class="pf2e-cd-mer-daily-offer-prices">
              <span class="pf2e-cd-mer-price-strike">${formatCopper(orig)}</span>
              <span class="pf2e-cd-mer-daily-offer-price">${formatCopper(cp)}</span>
            </div>
          </div>
          <span class="pf2e-cd-mer-daily-offer-badge">-${Math.round(pct * 100)}%</span>
        </button>
      `;
    }).join("");
    host.innerHTML = `
      <div class="pf2e-cd-mer-daily-offers-title">
        <i class="fa-solid fa-tags"></i>
        ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.dailyOffers"))}
      </div>
      <div class="pf2e-cd-mer-daily-offers-list">${cards}</div>
    `;
    host.onclick = (e) => {
      const card = e.target.closest("[data-action=daily-offer-jump]");
      if (!card) return;
      const itemId = card.dataset.itemId;
      this._jumpToOfferItem(itemId);
    };
  }

  _jumpToOfferItem(itemId) {
    const item = this.actor?.items?.get?.(itemId);
    if (!item) return;
    // Switch to "all items" view, prefill search with the name, then scroll to row.
    this.viewMode = "items";
    this.filters.category = "all";
    this.filters.wishlistOnly = false;
    if (this.refs.wishlistCb) this.refs.wishlistCb.checked = false;
    this.filters.search = item.name.toLowerCase();
    if (this.refs.search) this.refs.search.value = item.name;
    this._renderItems();
    setTimeout(() => {
      const row = this.refs.itemList?.querySelector(`.pf2e-cd-mer-item[data-item-id="${itemId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("is-highlight");
        setTimeout(() => row.classList.remove("is-highlight"), 1400);
      }
    }, 40);
  }

  _renderServiceList() {
    this.refs.backBar.hidden = false;
    this.refs.filtersBar.hidden = true;
    if (this.refs.sellBar) this.refs.sellBar.hidden = !this.viewer;
    if (this.refs.compareBar) this.refs.compareBar.hidden = true;
    this.refs.currentCat.textContent = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.services");

    const services = getMerchantServices(this.actor);
    if (services.length === 0 && !game.user.isGM) {
      this.refs.itemList.innerHTML = "";
      this.refs.empty.hidden = false;
      return;
    }
    this.refs.empty.hidden = true;

    const gmToolbar = game.user.isGM ? `
      <div class="pf2e-cd-mer-service-toolbar">
        <button type="button" class="pf2e-cd-mer-service-add" data-action="service-add">
          <i class="fa-solid fa-circle-plus"></i>
          <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.add"))}</span>
        </button>
        ${services.length > 0 ? `
          <button type="button" class="pf2e-cd-mer-service-clear" data-action="service-clear-all" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.clearAll"))}">
            <i class="fa-solid fa-trash-can"></i>
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.clearAll"))}</span>
          </button>` : ""}
      </div>` : "";

    const rows = services.map(s => this._renderServiceRow(s)).join("");
    this.refs.itemList.innerHTML = gmToolbar + rows;
  }

  async _handleServiceClearAll() {
    if (!game.user.isGM || !this.actor) return;
    const services = getMerchantServices(this.actor);
    if (services.length === 0) return;
    const ok = await confirmDialog(
      game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.clearAll"),
      game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.confirmClearAll", { count: services.length })
    );
    if (!ok) return;
    await this.actor.update({ [`flags.${MODULE_ID}.services`]: [] });
    ui.notifications?.info(game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.cleared", { count: services.length }));
    this._renderItems();
  }

  _renderServiceRow(s) {
    const canBuy = !!this.viewer;
    const buyDisabled = canBuy ? "" : "disabled";
    const rarity = s.rarity ?? "common";
    const gmButtons = game.user.isGM ? `
      <button type="button" class="pf2e-cd-mer-edit-price" data-action="service-edit" data-service-id="${s.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.edit"))}"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="pf2e-cd-mer-delete" data-action="service-delete" data-service-id="${s.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.delete"))}"><i class="fa-solid fa-xmark"></i></button>
    ` : "";
    return `
      <div class="pf2e-cd-mer-item pf2e-cd-mer-service-row rarity-${rarity}" data-service-id="${s.id}">
        <img class="pf2e-cd-mer-item-img" src="${escapeHTML(s.img ?? "icons/svg/book.svg")}" alt="" />
        <div class="pf2e-cd-mer-item-main">
          <div class="pf2e-cd-mer-item-line1">
            <span class="pf2e-cd-mer-item-name">${escapeHTML(s.name)}</span>
            <span class="pf2e-cd-mer-item-price">${escapeHTML(formatCopper(s.priceCp))}</span>
          </div>
          <div class="pf2e-cd-mer-item-line2">
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-cat">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.services"))}</span>
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            ${s.level > 0 ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-level">L ${s.level}</span>` : ""}
          </div>
          ${s.description ? `<div class="pf2e-cd-mer-service-desc">${escapeHTML(s.description)}</div>` : ""}
        </div>
        <div class="pf2e-cd-mer-item-actions">
          ${gmButtons}
          <button type="button" class="pf2e-cd-mer-buy" data-action="service-buy" data-service-id="${s.id}" ${buyDisabled}>
            <i class="fa-solid fa-handshake"></i> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.pay")}
          </button>
        </div>
      </div>
    `;
  }

  async _showServiceDetails(serviceId) {
    if (!this.actor) return;
    const services = getMerchantServices(this.actor);
    const s = services.find(x => x.id === serviceId);
    if (!s) return;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const rarity = s.rarity ?? "common";
    const canBuy = !!this.viewer;
    const buttons = [];
    if (canBuy) {
      buttons.push({
        action: "buy",
        label: `${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.pay")} — ${formatCopper(Math.max(0, s.priceCp ?? 0))}`,
        icon: "fa-solid fa-handshake",
        default: true,
        callback: () => this._handleBuyService(serviceId),
      });
    }
    buttons.push({
      action: "close",
      label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close"),
      icon: "fa-solid fa-xmark",
    });

    const desc = (s.description ?? "").trim();
    const content = `
      <div class="pf2e-cd-mer-service-detail">
        <div class="pf2e-cd-mer-service-detail-header">
          <img src="${escapeHTML(s.img ?? "icons/svg/book.svg")}" alt="" />
          <div>
            <div class="pf2e-cd-mer-service-detail-name">${escapeHTML(s.name)}</div>
            <div class="pf2e-cd-mer-service-detail-meta">
              <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-cat">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.services"))}</span>
              <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
              ${s.level > 0 ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-level">L ${s.level}</span>` : ""}
              <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-price">${escapeHTML(formatCopper(s.priceCp ?? 0))}</span>
            </div>
          </div>
        </div>
        ${desc ? `<div class="pf2e-cd-mer-service-detail-desc">${escapeHTML(desc).replace(/\n/g, "<br/>")}</div>` : ""}
      </div>
    `;
    await DialogV2.wait({
      window: { title: s.name },
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-service-detail-dialog"],
      content,
      buttons,
    }).catch(() => {});
  }

  async _handleBuyService(serviceId) {
    if (!this.viewer || !this.actor) return;
    const services = getMerchantServices(this.actor);
    const s = services.find(x => x.id === serviceId);
    if (!s) return;
    const priceCp = Math.max(0, Number(s.priceCp ?? 0) || 0);
    if (priceCp > 0) {
      const buyerCp = priceToCopper({ value: readActorCoins(this.viewer) });
      if (buyerCp < priceCp) {
        ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.notEnoughGold"));
        return;
      }
    }
    try {
      if (priceCp > 0) {
        await deductCoins(this.viewer, priceCp);
        await addCoins(this.actor, priceCp);
      }
      this._logTransaction("buy", s.name, 1, priceCp, { img: s.img });
      playBuy();
      this._showTransactionPopup({
        kind: "buy", name: s.name, img: s.img, qty: 1, price: formatCopper(priceCp),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | service purchase failed:`, err);
      ui.notifications?.error(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.buyFailed"));
    }
  }

  async _handleServiceEdit(serviceId) {
    if (!game.user.isGM || !this.actor) return;
    const services = getMerchantServices(this.actor);
    const existing = serviceId ? services.find(s => s.id === serviceId) : null;
    const coins = copperToCoins(existing?.priceCp ?? 0);
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const titleKey = existing
      ? "PF2E_CINEMATIC_MERCHANT.service.editTitle"
      : "PF2E_CINEMATIC_MERCHANT.service.addTitle";

    const presetSection = existing ? "" : `
      <button type="button" class="pf2e-cd-mer-service-preset-btn" data-action="open-preset-browser">
        <i class="fa-solid fa-list-check"></i>
        <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.browseBtn"))}</span>
      </button>
    `;

    const initialImg = existing?.img ?? "icons/svg/book.svg";
    await DialogV2.prompt({
      window: { title: game.i18n.localize(titleKey) },
      position: { width: 520 },
      content: `
        <form class="pf2e-cd-mer-service-form">
          ${presetSection}
          <div class="pf2e-cd-mer-service-form-grid">
            <label class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-icon-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.img")}</span>
              <div class="pf2e-cd-mer-svc-icon-row">
                <img class="pf2e-cd-mer-svc-icon-preview" data-role="svc-img-preview" src="${escapeHTML(initialImg)}" alt="" />
                <input type="text" name="svc-img" value="${escapeHTML(initialImg)}" />
                <button type="button" class="pf2e-cd-mer-svc-icon-browse" data-action="svc-img-browse" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.imgBrowse"))}">
                  <i class="fa-solid fa-folder-open"></i>
                </button>
              </div>
            </label>
            <label class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-name-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.name")}</span>
              <input type="text" name="svc-name" value="${escapeHTML(existing?.name ?? "")}" autofocus />
            </label>
            <label class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-level-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.detail.level")}</span>
              <input type="number" name="svc-level" min="0" max="25" value="${existing?.level ?? 0}" />
            </label>
            <label class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-rarity-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.compare.rarity")}</span>
              <select name="svc-rarity">
                ${["common","uncommon","rare","unique"].map(r => `<option value="${r}"${(existing?.rarity ?? "common") === r ? " selected" : ""}>${escapeHTML(localizeRarity(r))}</option>`).join("")}
              </select>
            </label>
            <label class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-desc-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.description")}</span>
              <textarea name="svc-desc" rows="3" placeholder="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.descriptionPlaceholder"))}">${escapeHTML(existing?.description ?? "")}</textarea>
            </label>
            <div class="pf2e-cd-mer-svc-field pf2e-cd-mer-svc-price-field">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.field.price")}</span>
              <div class="pf2e-cd-mer-service-coin-inline">
                <label><input type="number" name="svc-pp" min="0" value="${coins.pp}" /><b>pp</b></label>
                <label><input type="number" name="svc-gp" min="0" value="${coins.gp}" /><b>gp</b></label>
                <label><input type="number" name="svc-sp" min="0" value="${coins.sp}" /><b>sp</b></label>
                <label><input type="number" name="svc-cp" min="0" value="${coins.cp}" /><b>cp</b></label>
              </div>
            </div>
          </div>
        </form>
      `,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-service-dialog"],
      render: (event, dialog) => {
        const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
        if (!root) return;
        // Icon picker + preview sync
        const imgInput = root.querySelector("[name=svc-img]");
        const imgPreview = root.querySelector("[data-role=svc-img-preview]");
        const imgBrowse = root.querySelector("[data-action=svc-img-browse]");
        const syncImg = () => {
          if (imgPreview && imgInput) imgPreview.src = imgInput.value || "icons/svg/book.svg";
        };
        imgInput?.addEventListener("input", syncImg);
        imgBrowse?.addEventListener("click", () => {
          const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
          if (!FP || !imgInput) return;
          new FP({
            type: "image",
            current: imgInput.value,
            callback: (path) => {
              if (typeof path === "string" && path.length > 0) {
                imgInput.value = path;
                syncImg();
              }
            },
          }).render(true);
        });
        // Browse-preset button → opens dedicated preset browser dialog
        const presetBtn = root.querySelector("[data-action=open-preset-browser]");
        const set = (n, v) => { const el = root.querySelector(`[name=${n}]`); if (el) el.value = String(v); };
        presetBtn?.addEventListener("click", () => {
          this._openServicePresetBrowser({
            onApplyOne: (p) => {
              const c = copperToCoins(p.priceCp ?? 0);
              set("svc-name", p.name);
              set("svc-desc", p.description ?? "");
              set("svc-level", p.level ?? 0);
              set("svc-rarity", p.rarity ?? "common");
              set("svc-pp", c.pp); set("svc-gp", c.gp); set("svc-sp", c.sp); set("svc-cp", c.cp);
              syncImg();
            },
            onBulkAdd: async (presets) => {
              let added = 0;
              for (const p of presets) {
                await addMerchantService(this.actor, {
                  name: p.name,
                  description: p.description ?? "",
                  priceCp: Number(p.priceCp ?? 0) || 0,
                  level: Number(p.level ?? 0) || 0,
                  rarity: p.rarity ?? "common",
                  img: "icons/svg/book.svg",
                });
                added++;
              }
              ui.notifications?.info(game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.preset.bulkAdded", { count: added }));
              this._renderItems();
              // Close the new-service dialog since we just bulk-added.
              dialog?.close?.();
            },
          });
        });
      },
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.save"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const name = String(root?.querySelector("[name=svc-name]")?.value ?? "").trim() || "Service";
          const desc = String(root?.querySelector("[name=svc-desc]")?.value ?? "");
          const level = Number(root?.querySelector("[name=svc-level]")?.value ?? 0);
          const rarity = String(root?.querySelector("[name=svc-rarity]")?.value ?? "common");
          const img = String(root?.querySelector("[name=svc-img]")?.value ?? "").trim() || "icons/svg/book.svg";
          const pp = Number(root?.querySelector("[name=svc-pp]")?.value ?? 0);
          const gp = Number(root?.querySelector("[name=svc-gp]")?.value ?? 0);
          const sp = Number(root?.querySelector("[name=svc-sp]")?.value ?? 0);
          const cp = Number(root?.querySelector("[name=svc-cp]")?.value ?? 0);
          const priceCp = pp * 1000 + gp * 100 + sp * 10 + cp;
          if (existing) {
            await updateMerchantService(this.actor, existing.id, { name, description: desc, priceCp, level, rarity, img });
          } else {
            await addMerchantService(this.actor, { name, description: desc, priceCp, level, rarity, img });
          }
          this._renderItems();
        },
      },
    });
  }

  async _openServicePresetBrowser({ onApplyOne, onBulkAdd }) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;

    // Group presets by subcategory for filter chips.
    const subcats = new Set();
    for (const p of SERVICE_PRESETS) {
      if (p.subcategory) subcats.add(p.subcategory);
    }
    const subcatList = [...subcats].sort((a, b) => a.localeCompare(b));

    const chips = subcatList.map(sc =>
      `<button type="button" class="pf2e-cd-mer-svc-pb-chip is-active" data-cat="${escapeHTML(sc)}">${escapeHTML(sc)}</button>`
    ).join("");

    const content = `
      <div class="pf2e-cd-mer-svc-pb">
        <div class="pf2e-cd-mer-svc-pb-toolbar">
          <input type="search" class="pf2e-cd-mer-svc-pb-search" data-role="svc-pb-search" placeholder="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
          <span class="pf2e-cd-mer-svc-pb-count" data-role="svc-pb-count"></span>
        </div>
        <div class="pf2e-cd-mer-svc-pb-chips">
          <button type="button" class="pf2e-cd-mer-svc-pb-chip-toggle" data-action="svc-pb-cat-all">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.picker.allCats"))}</button>
          <button type="button" class="pf2e-cd-mer-svc-pb-chip-toggle" data-action="svc-pb-cat-none">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.picker.noCats"))}</button>
          ${chips}
        </div>
        <div class="pf2e-cd-mer-svc-pb-actions">
          <button type="button" data-action="svc-pb-select-visible"><i class="fa-solid fa-check-double"></i> ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.picker.selectAll"))}</button>
          <button type="button" data-action="svc-pb-select-none"><i class="fa-solid fa-eraser"></i> ${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.picker.selectNone"))}</button>
        </div>
        <ul class="pf2e-cd-mer-svc-pb-list" data-role="svc-pb-list"></ul>
      </div>
    `;

    const state = {
      search: "",
      activeCats: new Set(subcatList),
      selected: new Set(), // indices into SERVICE_PRESETS
    };

    const visiblePresets = () => SERVICE_PRESETS
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => {
        if (state.search && !p.name.toLowerCase().includes(state.search)) return false;
        const sc = p.subcategory ?? "";
        if (sc && !state.activeCats.has(sc)) return false;
        return true;
      });

    await DialogV2.wait({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.browseTitle") },
      position: { width: 640 },
      content,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-service-dialog", "pf2e-cd-mer-svc-pb-dialog"],
      buttons: [
        {
          action: "apply-one",
          label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.applyOne"),
          icon: "fa-solid fa-arrow-down-to-line",
          default: false,
          callback: (event, button, dialog) => {
            const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
            const idx = [...state.selected][0];
            const p = SERVICE_PRESETS[idx];
            if (!p) {
              ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.applyOneNoSel"));
              return false;
            }
            if (state.selected.size > 1) {
              ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.applyOneTooMany"));
              return false;
            }
            onApplyOne?.(p);
          },
        },
        {
          action: "bulk-add",
          label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.bulkAddBtn"),
          icon: "fa-solid fa-plus",
          default: true,
          callback: async (event, button, dialog) => {
            if (state.selected.size === 0) {
              ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.preset.applyOneNoSel"));
              return false;
            }
            const presets = [...state.selected].map(i => SERVICE_PRESETS[i]).filter(Boolean);
            await onBulkAdd?.(presets);
          },
        },
        { action: "cancel", label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkCancel") },
      ],
      render: (event, dialog) => {
        const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
        if (!root) return;
        const listEl = root.querySelector("[data-role=svc-pb-list]");
        const countEl = root.querySelector("[data-role=svc-pb-count]");
        const searchEl = root.querySelector("[data-role=svc-pb-search]");

        const renderList = () => {
          const items = visiblePresets();
          if (countEl) {
            countEl.textContent = game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.preset.browseCount", {
              shown: items.length, selected: state.selected.size,
            });
          }
          listEl.innerHTML = items.map(({ p, idx }) => {
            const checked = state.selected.has(idx) ? "checked" : "";
            const priceTag = p.priceRaw ? `<span class="pf2e-cd-mer-svc-pb-price">${escapeHTML(p.priceRaw)}</span>` : "";
            const desc = p.description ? `<div class="pf2e-cd-mer-svc-pb-desc">${escapeHTML(p.description.length > 120 ? p.description.slice(0, 117) + "…" : p.description)}</div>` : "";
            const sc = p.subcategory ? `<span class="pf2e-cd-mer-svc-pb-cat">${escapeHTML(p.subcategory)}</span>` : "";
            return `
              <li class="pf2e-cd-mer-svc-pb-item">
                <label>
                  <input type="checkbox" data-idx="${idx}" ${checked} />
                  <div class="pf2e-cd-mer-svc-pb-item-main">
                    <div class="pf2e-cd-mer-svc-pb-item-row1">
                      <span class="pf2e-cd-mer-svc-pb-name">${escapeHTML(p.name)}</span>
                      ${priceTag}
                    </div>
                    <div class="pf2e-cd-mer-svc-pb-item-row2">${sc}${desc}</div>
                  </div>
                </label>
              </li>
            `;
          }).join("");
          // Wire checkbox events
          for (const cb of listEl.querySelectorAll("input[type=checkbox]")) {
            cb.addEventListener("change", () => {
              const idx = Number(cb.dataset.idx);
              if (cb.checked) state.selected.add(idx);
              else state.selected.delete(idx);
              if (countEl) {
                countEl.textContent = game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.preset.browseCount", {
                  shown: visiblePresets().length, selected: state.selected.size,
                });
              }
            });
          }
        };

        searchEl?.addEventListener("input", () => {
          state.search = searchEl.value.trim().toLowerCase();
          renderList();
        });

        for (const chip of root.querySelectorAll(".pf2e-cd-mer-svc-pb-chip")) {
          chip.addEventListener("click", () => {
            const cat = chip.dataset.cat;
            if (state.activeCats.has(cat)) {
              state.activeCats.delete(cat);
              chip.classList.remove("is-active");
            } else {
              state.activeCats.add(cat);
              chip.classList.add("is-active");
            }
            renderList();
          });
        }
        root.querySelector("[data-action=svc-pb-cat-all]")?.addEventListener("click", () => {
          subcatList.forEach(c => state.activeCats.add(c));
          root.querySelectorAll(".pf2e-cd-mer-svc-pb-chip").forEach(c => c.classList.add("is-active"));
          renderList();
        });
        root.querySelector("[data-action=svc-pb-cat-none]")?.addEventListener("click", () => {
          state.activeCats.clear();
          root.querySelectorAll(".pf2e-cd-mer-svc-pb-chip").forEach(c => c.classList.remove("is-active"));
          renderList();
        });
        root.querySelector("[data-action=svc-pb-select-visible]")?.addEventListener("click", () => {
          for (const { idx } of visiblePresets()) state.selected.add(idx);
          renderList();
        });
        root.querySelector("[data-action=svc-pb-select-none]")?.addEventListener("click", () => {
          state.selected.clear();
          renderList();
        });

        renderList();
      },
    });
  }

  async _handleOpenHistory() {
    if (!game.user.isGM || !this.actor) return;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;

    const renderRows = (entries, filterKind, filterText) => {
      const q = (filterText ?? "").trim().toLowerCase();
      const filtered = entries.filter(e => {
        if (filterKind !== "all" && e.kind !== filterKind) return false;
        if (!q) return true;
        return (e.itemName ?? "").toLowerCase().includes(q)
          || (e.characterName ?? "").toLowerCase().includes(q)
          || (e.userName ?? "").toLowerCase().includes(q);
      });
      if (filtered.length === 0) {
        return `<li class="pf2e-cd-mer-hist-empty">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.empty"))}</li>`;
      }
      // Newest first.
      return filtered.slice().reverse().map(e => {
        const when = new Date(e.when ?? 0);
        const dateStr = when.toLocaleString();
        const verbKey = e.kind === "sell"
          ? "PF2E_CINEMATIC_MERCHANT.history.verbSell"
          : "PF2E_CINEMATIC_MERCHANT.history.verbBuy";
        const verb = game.i18n.localize(verbKey);
        return `
          <li class="pf2e-cd-mer-hist-row pf2e-cd-mer-hist-${e.kind}">
            <img class="pf2e-cd-mer-hist-img" src="${escapeHTML(e.itemImg || "icons/svg/item-bag.svg")}" alt="" />
            <div class="pf2e-cd-mer-hist-main">
              <div class="pf2e-cd-mer-hist-row1">
                <span class="pf2e-cd-mer-hist-verb">${escapeHTML(verb)}</span>
                <span class="pf2e-cd-mer-hist-item">${escapeHTML(e.itemName)}</span>
                ${e.qty > 1 ? `<span class="pf2e-cd-mer-hist-qty">×${e.qty}</span>` : ""}
                <span class="pf2e-cd-mer-hist-price">${formatCopper(e.cp)}</span>
              </div>
              <div class="pf2e-cd-mer-hist-row2">
                <span class="pf2e-cd-mer-hist-char">${escapeHTML(e.characterName || "—")}</span>
                ${e.userName && e.userName !== e.characterName ? `<span class="pf2e-cd-mer-hist-user">(${escapeHTML(e.userName)})</span>` : ""}
                <span class="pf2e-cd-mer-hist-when" title="${escapeHTML(dateStr)}">${escapeHTML(this._formatRelativeTime(when))}</span>
              </div>
            </div>
          </li>
        `;
      }).join("");
    };

    const computeTotals = (entries) => {
      let totalBuy = 0, totalSell = 0;
      for (const e of entries) {
        if (e.kind === "buy") totalBuy += Number(e.cp) || 0;
        else if (e.kind === "sell") totalSell += Number(e.cp) || 0;
      }
      return { totalBuy, totalSell };
    };

    const initial = getMerchantTransactionLog(this.actor);
    const { totalBuy, totalSell } = computeTotals(initial);

    const content = `
      <div class="pf2e-cd-mer-hist">
        <div class="pf2e-cd-mer-hist-summary">
          <div class="pf2e-cd-mer-hist-stat">
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.totalBought"))}</span>
            <strong data-role="hist-total-buy">${formatCopper(totalBuy)}</strong>
          </div>
          <div class="pf2e-cd-mer-hist-stat">
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.totalSold"))}</span>
            <strong data-role="hist-total-sell">${formatCopper(totalSell)}</strong>
          </div>
          <div class="pf2e-cd-mer-hist-stat">
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.entries"))}</span>
            <strong data-role="hist-count">${initial.length}</strong>
          </div>
        </div>
        <div class="pf2e-cd-mer-hist-toolbar">
          <input type="search" data-role="hist-search" placeholder="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.search"))}" />
          <select data-role="hist-kind">
            <option value="all">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.kindAll"))}</option>
            <option value="buy">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.kindBuy"))}</option>
            <option value="sell">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.kindSell"))}</option>
          </select>
          <button type="button" class="pf2e-cd-mer-hist-clear-btn" data-action="hist-clear">
            <i class="fa-solid fa-trash-can"></i>
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.clear"))}</span>
          </button>
        </div>
        <ul class="pf2e-cd-mer-hist-list" data-role="hist-list"></ul>
      </div>
    `;

    await DialogV2.wait({
      window: { title: game.i18n.format("PF2E_CINEMATIC_MERCHANT.history.title", { actor: this.actor.name }) },
      position: { width: 640 },
      content,
      classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-history-dialog"],
      buttons: [{ action: "close", label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close"), default: true }],
      render: (event, dialog) => {
        const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
        if (!root) return;
        const listEl = root.querySelector("[data-role=hist-list]");
        const searchEl = root.querySelector("[data-role=hist-search]");
        const kindEl = root.querySelector("[data-role=hist-kind]");
        const clearBtn = root.querySelector("[data-action=hist-clear]");

        let state = { kind: "all", text: "" };
        const repaint = () => {
          const entries = getMerchantTransactionLog(this.actor);
          listEl.innerHTML = renderRows(entries, state.kind, state.text);
          const totals = computeTotals(entries);
          root.querySelector("[data-role=hist-total-buy]").textContent = formatCopper(totals.totalBuy);
          root.querySelector("[data-role=hist-total-sell]").textContent = formatCopper(totals.totalSell);
          root.querySelector("[data-role=hist-count]").textContent = String(entries.length);
        };
        searchEl?.addEventListener("input", () => { state.text = searchEl.value; repaint(); });
        kindEl?.addEventListener("change", () => { state.kind = kindEl.value; repaint(); });
        clearBtn?.addEventListener("click", async () => {
          const ok = await confirmDialog(
            game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.clear"),
            game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.clearConfirm")
          );
          if (!ok) return;
          await clearMerchantTransactionLog(this.actor);
          repaint();
        });
        repaint();
      },
    });
  }

  _formatRelativeTime(date) {
    const now = Date.now();
    const diff = now - (date?.getTime?.() ?? now);
    if (diff < 60_000) return game.i18n.localize("PF2E_CINEMATIC_MERCHANT.history.justNow");
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return game.i18n.format("PF2E_CINEMATIC_MERCHANT.history.minsAgo", { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return game.i18n.format("PF2E_CINEMATIC_MERCHANT.history.hoursAgo", { n: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return game.i18n.format("PF2E_CINEMATIC_MERCHANT.history.daysAgo", { n: days });
    return date.toLocaleDateString();
  }

  async _handleServiceDelete(serviceId) {
    if (!game.user.isGM || !this.actor) return;
    const services = getMerchantServices(this.actor);
    const s = services.find(x => x.id === serviceId);
    if (!s) return;
    const ok = await confirmDialog(
      game.i18n.localize("PF2E_CINEMATIC_MERCHANT.service.delete"),
      game.i18n.format("PF2E_CINEMATIC_MERCHANT.service.confirmDelete", { name: s.name })
    );
    if (!ok) return;
    await removeMerchantService(this.actor, serviceId);
    this._renderItems();
  }

  _renderCategoryGrid() {
    this.refs.backBar.hidden = true;
    this.refs.filtersBar.hidden = true;
    this.refs.empty.hidden = true;
    if (this.refs.sellBar) this.refs.sellBar.hidden = !this.viewer;
    if (this.refs.compareBar) this.refs.compareBar.hidden = true;
    if (this.refs.cartBtn) this.refs.cartBtn.hidden = !this.viewer || this.cart.size() === 0;

    const items = this._collectItems();
    const counts = {};
    for (const it of items) {
      const t = effectiveItemType(it);
      counts[t] = (counts[t] ?? 0) + 1;
    }
    const totalCount = items.length;

    const tiles = [];
    tiles.push({ value: "all", label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.all"), icon: "fa-store", count: totalCount });
    for (const c of CATEGORIES) {
      const n = counts[c.value] ?? 0;
      if (n === 0) continue; // hide empty categories so the grid stays focused
      tiles.push({ value: c.value, label: game.i18n.localize(c.labelKey), icon: c.icon, count: n });
    }

    // Services tile (visible whenever the merchant has services configured,
    // or always for the GM so they can add the first one).
    const services = getMerchantServices(this.actor);
    let servicesTile = "";
    if (services.length > 0 || game.user.isGM) {
      servicesTile = `
        <button type="button" class="pf2e-cd-mer-cat-tile pf2e-cd-mer-cat-services ${services.length === 0 ? "is-empty" : ""}" data-cat="__services">
          <i class="fa-solid fa-handshake-angle pf2e-cd-mer-cat-icon"></i>
          <span class="pf2e-cd-mer-cat-label">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.services"))}</span>
          <span class="pf2e-cd-mer-cat-count">${services.length}</span>
        </button>`;
    }

    // Wishlist tile (player-only) — counts items at this merchant that the
    // player has bookmarked. Clicking it filters to wishlist-only.
    let wishlistTile = "";
    if (this.viewer) {
      const wishKeys = getAllWishlistKeys();
      let wishCount = 0;
      for (const it of items) if (wishKeys.has(getItemKey(it))) wishCount++;
      wishlistTile = `
        <button type="button" class="pf2e-cd-mer-cat-tile pf2e-cd-mer-cat-wishlist ${wishCount === 0 ? "is-empty" : ""}" data-cat="__wishlist">
          <i class="fa-solid fa-bookmark pf2e-cd-mer-cat-icon"></i>
          <span class="pf2e-cd-mer-cat-label">${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.wishlist"))}</span>
          <span class="pf2e-cd-mer-cat-count">${wishCount}</span>
        </button>`;
    }

    this.refs.itemList.innerHTML = `
      <div class="pf2e-cd-mer-cat-grid">
        ${tiles.map(t => `
          <button type="button" class="pf2e-cd-mer-cat-tile" data-cat="${t.value}">
            <i class="fa-solid ${t.icon} pf2e-cd-mer-cat-icon"></i>
            <span class="pf2e-cd-mer-cat-label">${escapeHTML(t.label)}</span>
            <span class="pf2e-cd-mer-cat-count">${t.count}</span>
          </button>
        `).join("")}
        ${servicesTile}
        ${wishlistTile}
      </div>
    `;

    for (const tile of this.refs.itemList.querySelectorAll(".pf2e-cd-mer-cat-tile")) {
      tile.addEventListener("click", () => this._enterCategory(tile.dataset.cat));
    }
  }

  /** Reset every filter to its default and clear the matching UI controls. */
  _resetAllFilters() {
    this.filters.search = "";
    this.filters.category = "all";
    this.filters.rarity = "all";
    this.filters.levelMin = null;
    this.filters.levelMax = null;
    this.filters.affordableOnly = false;
    this.filters.sort = "default";
    this.filters.wishlistOnly = false;
    this.filters.usage = "all";
    this.filters.group = "all";
    this.filters.bulk = "all";
    this.filters.magical = "all";
    if (this.refs.search) this.refs.search.value = "";
    if (this.refs.raritySel) this.refs.raritySel.value = "all";
    if (this.refs.levelMin) this.refs.levelMin.value = "";
    if (this.refs.levelMax) this.refs.levelMax.value = "";
    if (this.refs.sortSel) this.refs.sortSel.value = "default";
    if (this.refs.affordableCb) this.refs.affordableCb.checked = false;
    if (this.refs.wishlistCb) this.refs.wishlistCb.checked = false;
    if (this.refs.usageSel) this.refs.usageSel.value = "all";
    if (this.refs.groupSel) this.refs.groupSel.value = "all";
    if (this.refs.bulkSel) this.refs.bulkSel.value = "all";
    if (this.refs.magicalSel) this.refs.magicalSel.value = "all";
    // Collapse the advanced-filters section too.
    if (this.refs.filtersAdv) this.refs.filtersAdv.hidden = true;
    if (this.refs.filtersBar) this.refs.filtersBar.classList.add("is-collapsed");
    const chev = this.refs.filtersToggleBtn?.querySelector("i");
    if (chev) chev.className = "fa-solid fa-chevron-down";
  }

  _enterCategory(cat) {
    // Each new category starts with a clean slate — no leftover search /
    // rarity / level filters from the previous browse.
    this._resetAllFilters();
    if (cat === "__wishlist") {
      this.filters.category = "all";
      this.filters.wishlistOnly = true;
      if (this.refs.wishlistCb) this.refs.wishlistCb.checked = true;
    } else if (cat === "__services") {
      this.viewMode = "services";
      this._renderItems();
      return;
    } else {
      this.filters.category = cat;
    }
    this.viewMode = "items";
    this._renderItems();
  }

  _goBackToCategories() {
    this.viewMode = "categories";
    this._resetAllFilters();
    this._renderItems();
  }

  _renderItemList() {
    this.refs.backBar.hidden = false;
    this.refs.filtersBar.hidden = false;
    if (this.refs.sellBar) this.refs.sellBar.hidden = !this.viewer;
    const affLabel = this.refs.affordableCb?.closest("label");
    if (affLabel) affLabel.hidden = !this.viewer;
    const sortLabel = this.refs.sortSel;
    if (sortLabel) sortLabel.hidden = false;

    // Show current category label in the back bar
    let catLabel;
    if (this.filters.wishlistOnly) {
      catLabel = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.wishlist");
    } else if (this.filters.category === "all") {
      catLabel = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.all");
    } else {
      catLabel = game.i18n.localize(CATEGORIES.find(c => c.value === this.filters.category)?.labelKey ?? "PF2E_CINEMATIC_MERCHANT.cat.all");
    }
    this.refs.currentCat.textContent = catLabel;

    const items = this._collectItems();
    this._populateDynamicFilters(items);
    const filtered = this._filterItems(items);

    if (filtered.length === 0) {
      this.refs.itemList.innerHTML = "";
      this.refs.empty.hidden = false;
      return;
    }
    this.refs.empty.hidden = true;

    this._ownedMap = this._buildViewerOwnedMap();

    const RENDER_CAP = 200;
    const sliced = filtered.slice(0, RENDER_CAP);
    let html = sliced.map(it => this._renderItemRow(it)).join("");
    if (filtered.length > RENDER_CAP) {
      html += `<div class="pf2e-cd-mer-cap-note">${game.i18n.format("PF2E_CINEMATIC_MERCHANT.window.capped", { shown: RENDER_CAP, total: filtered.length })}</div>`;
    }
    this.refs.itemList.innerHTML = html;
    this._refreshCompareBar();
    this._refreshCartBar();
  }

  async _handleShowDetails(itemId) {
    const item = this.actor.items.get(itemId);
    if (!item) return;
    const qty = Number(item.system?.quantity ?? 1);
    openItemDetails(item, {
      canBuy: !!this.viewer && qty > 0,
      onBuy: (it, n = 1) => this._handleBuy(it.id, n),
    });
  }

  async _handleImport() {
    if (!game.user.isGM || !this.actor) return;
    openCompendiumPicker(this.actor, () => {
      this._renderItems();
    });
  }

  async _handleClearAll() {
    if (!game.user.isGM || !this.actor) return;
    const items = this._collectItems();
    if (items.length === 0) {
      ui.notifications?.info(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.alreadyEmpty"));
      return;
    }
    const ok = await confirmDialog(
      game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.clearTitle"),
      game.i18n.format("PF2E_CINEMATIC_MERCHANT.gm.clearConfirm", { count: items.length, name: this.actor.name })
    );
    if (!ok) return;
    try {
      const ids = items.map(i => i.id);
      await this.actor.deleteEmbeddedDocuments("Item", ids);
      ui.notifications?.info(game.i18n.format("PF2E_CINEMATIC_MERCHANT.gm.cleared", { count: ids.length }));
    } catch (err) {
      console.warn(`${MODULE_ID} | clear-all failed:`, err);
      ui.notifications?.error(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.clearFailed"));
    }
  }

  async _handleDelete(itemId) {
    if (!game.user.isGM) return;
    const item = this.actor.items.get(itemId);
    if (!item) return;
    try {
      await item.delete();
    } catch (err) {
      console.warn(`${MODULE_ID} | delete item failed:`, err);
    }
  }

  _buildViewerOwnedMap() {
    const map = new Map();
    const viewer = this.viewer;
    if (!viewer?.items) return map;
    for (const it of viewer.items) {
      if (isCoinItem(it)) continue;
      const key = getItemIdentityKey(it);
      if (!key) continue;
      const qty = Math.max(1, Number(it.system?.quantity ?? 1));
      map.set(key, (map.get(key) ?? 0) + qty);
    }
    return map;
  }

  _collectItems() {
    if (!this.actor) return [];
    const items = this.actor.items ?? [];
    return [...items].filter(it => {
      if (isCoinItem(it)) return false;
      const allowed = new Set(["weapon","armor","shield","consumable","equipment","treasure","backpack","ammunition","kit"]);
      return it.system?.price !== undefined || allowed.has(it.type);
    });
  }

  // Walk the current visible item set, collect distinct values for the
  // dynamic filters (usage / group), populate the <select>s and hide ones
  // that wouldn't actually filter anything. Bulk + Magical always shown.
  _populateDynamicFilters(items) {
    const r = this.refs;
    const f = this.filters;
    // Pre-filter by the *non-dynamic* filters so the dropdowns only offer
    // values that would actually narrow down the visible set further.
    const lvlOK = (it) => {
      const lvl = Number(it.system?.level?.value ?? 0);
      if (f.levelMin != null && lvl < f.levelMin) return false;
      if (f.levelMax != null && lvl > f.levelMax) return false;
      return true;
    };
    const catOK = (it) => f.category === "all" || effectiveItemType(it) === f.category;
    const candidates = items.filter(it => catOK(it) && lvlOK(it));

    const usages = new Set();
    const groups = new Set();
    for (const it of candidates) {
      const u = it.system?.usage?.value;
      if (u) usages.add(u);
      const g = it.system?.group;
      if (g) groups.add(g);
    }

    const fillSelect = (sel, current, values, emptyLabel) => {
      if (!sel) return;
      if (values.size <= 1) {
        sel.hidden = true;
        sel.value = "all";
        return;
      }
      sel.hidden = false;
      const sorted = [...values].sort((a, b) => a.localeCompare(b));
      const opts = [`<option value="all">${escapeHTML(emptyLabel)}</option>`];
      for (const v of sorted) {
        opts.push(`<option value="${escapeHTML(v)}"${v === current ? " selected" : ""}>${escapeHTML(localizeUsageOrGroup(v))}</option>`);
      }
      sel.innerHTML = opts.join("");
      // Restore selection if still valid; otherwise reset.
      if (current !== "all" && !values.has(current)) {
        sel.value = "all";
        if (sel === r.usageSel) f.usage = "all";
        if (sel === r.groupSel) f.group = "all";
      } else {
        sel.value = current;
      }
    };
    fillSelect(r.usageSel, f.usage, usages, r.usageSel?.dataset?.emptyLabel ?? "Any usage");
    fillSelect(r.groupSel, f.group, groups, r.groupSel?.dataset?.emptyLabel ?? "Any group");

    // Bulk + magical are always available (most stocks contain a mix).
    if (r.bulkSel) {
      r.bulkSel.hidden = candidates.length < 2;
      r.bulkSel.value = f.bulk;
    }
    if (r.magicalSel) {
      r.magicalSel.hidden = candidates.length < 2;
      r.magicalSel.value = f.magical;
    }
  }

  _filterItems(items) {
    const f = this.filters;
    let viewerCp = null;
    if (f.affordableOnly && this.viewer) {
      viewerCp = priceToCopper({ value: readActorCoins(this.viewer) });
    }
    const wishKeys = f.wishlistOnly ? getAllWishlistKeys() : null;
    const filtered = items.filter(it => {
      if (f.search && !it.name.toLowerCase().includes(f.search)) return false;
      if (f.category !== "all" && effectiveItemType(it) !== f.category) return false;
      if (f.rarity !== "all") {
        const r = it.system?.traits?.rarity ?? "common";
        if (r !== f.rarity) return false;
      }
      const lvl = Number(it.system?.level?.value ?? 0);
      if (f.levelMin != null && lvl < f.levelMin) return false;
      if (f.levelMax != null && lvl > f.levelMax) return false;
      if (viewerCp != null) {
        const price = effectiveItemPriceCp(it);
        if (price > viewerCp) return false;
      }
      if (wishKeys && !wishKeys.has(getItemKey(it))) return false;
      if (f.usage !== "all") {
        const u = it.system?.usage?.value ?? "";
        if (u !== f.usage) return false;
      }
      if (f.group !== "all") {
        const g = it.system?.group ?? "";
        if (g !== f.group) return false;
      }
      if (f.bulk !== "all") {
        const bv = Number(it.system?.bulk?.value ?? 0);
        let ok = false;
        switch (f.bulk) {
          case "0":     ok = bv === 0; break;
          case "L":     ok = bv > 0 && bv < 1; break; // PF2E treats light as 0.1
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
      return true;
    });
    return filtered.sort((a, b) => {
      switch (f.sort) {
        case "priceAsc":  return effectiveItemPriceCp(a) - effectiveItemPriceCp(b);
        case "priceDesc": return effectiveItemPriceCp(b) - effectiveItemPriceCp(a);
        case "levelAsc":  return Number(a.system?.level?.value ?? 0) - Number(b.system?.level?.value ?? 0);
        case "levelDesc": return Number(b.system?.level?.value ?? 0) - Number(a.system?.level?.value ?? 0);
        case "nameAsc":   return a.name.localeCompare(b.name);
        case "default":
        default: {
          const lvlDiff = (Number(a.system?.level?.value ?? 0)) - (Number(b.system?.level?.value ?? 0));
          if (lvlDiff !== 0) return lvlDiff;
          return a.name.localeCompare(b.name);
        }
      }
    });
  }

  _renderItemRow(item) {
    const cp = effectiveItemPriceCp(item);
    const overrideCp = getItemPriceOverrideCp(item);
    const isOverride = overrideCp != null;
    const qty = Number(item.system?.quantity ?? 1);
    const lvl = Number(item.system?.level?.value ?? 0);
    const rarity = item.system?.traits?.rarity ?? "common";
    const cat = effectiveItemType(item);
    const img = item.img ?? "icons/svg/item-bag.svg";
    const canBuy = !!this.viewer && qty > 0;
    const editPriceBtn = game.user.isGM
      ? `<button type="button" class="pf2e-cd-mer-edit-price" data-action="edit-price" data-item-id="${item.id}" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editPrice")}"><i class="fa-solid fa-pen"></i></button>`
      : "";
    const editQtyBtn = game.user.isGM
      ? `<button type="button" class="pf2e-cd-mer-edit-qty" data-action="edit-qty" data-item-id="${item.id}" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editQty")}"><i class="fa-solid fa-cubes-stacked"></i></button>`
      : "";
    const overrideMark = isOverride ? `<span class="pf2e-cd-mer-override" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.priceOverridden")}">*</span>` : "";
    const offerPct = getItemDailyOfferPct(item);
    const editOfferBtn = game.user.isGM
      ? `<button type="button" class="pf2e-cd-mer-edit-offer ${offerPct > 0 ? "is-active" : ""}" data-action="edit-offer" data-item-id="${item.id}" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editOffer")}"><i class="fa-solid fa-tag"></i></button>`
      : "";
    const dailyBadge = offerPct > 0
      ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-offer" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.dailyOfferTooltip"))}"><i class="fa-solid fa-tag"></i> -${Math.round(offerPct * 100)}%</span>`
      : "";
    let priceMarkup;
    if (offerPct > 0) {
      // Compute the pre-offer price by un-applying the discount.
      const originalCp = Math.round(cp / (1 - offerPct));
      priceMarkup = `<span class="pf2e-cd-mer-item-price has-offer"><span class="pf2e-cd-mer-price-strike">${formatCopper(originalCp)}</span> ${formatCopper(cp)}${overrideMark}</span>`;
    } else {
      priceMarkup = `<span class="pf2e-cd-mer-item-price">${formatCopper(cp)}${overrideMark}</span>`;
    }
    const deleteBtn = game.user.isGM
      ? `<button type="button" class="pf2e-cd-mer-delete" data-action="delete" data-item-id="${item.id}" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.deleteItem")}"><i class="fa-solid fa-xmark"></i></button>`
      : "";
    const buyDisabled = canBuy ? "" : "disabled";
    const compareChecked = this.compareSet.has(item.id) ? "checked" : "";
    const compareLabel = game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.compareToggle");
    const compareBtn = `
      <label class="pf2e-cd-mer-compare-btn ${compareChecked ? "is-active" : ""}" title="${escapeHTML(compareLabel)}">
        <input type="checkbox" data-role="compare-toggle" data-item-id="${item.id}" ${compareChecked} />
        <i class="fa-solid fa-scale-balanced"></i>
      </label>`;
    const wished = isWishlisted(item);
    const wishlistBtn = this.viewer
      ? `<button type="button" class="pf2e-cd-mer-wishlist-btn ${wished ? "is-active" : ""}" data-action="wishlist-toggle" data-item-id="${item.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.wishlistToggle"))}">
        <i class="fa-solid fa-bookmark"></i>
      </button>`
      : "";
    const cartInCart = this.cart.has(item.id);
    const cartAddBtn = canBuy
      ? `<button type="button" class="pf2e-cd-mer-cart-add-btn ${cartInCart ? "is-active" : ""}" data-action="cart-add" data-item-id="${item.id}" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.cartAdd"))}">
        <i class="fa-solid fa-cart-plus"></i>
      </button>`
      : "";
    const ownedQty = this._ownedMap?.get(getItemIdentityKey(item)) ?? 0;
    const ownedBadge = ownedQty > 0
      ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-owned" title="${escapeHTML(game.i18n.format("PF2E_CINEMATIC_MERCHANT.window.ownedTooltip", { qty: ownedQty }))}"><i class="fa-solid fa-backpack"></i> ×${ownedQty}</span>`
      : "";
    const ownedClass = ownedQty > 0 ? " is-owned" : "";
    return `
      <div class="pf2e-cd-mer-item rarity-${rarity}${ownedClass}" data-item-id="${item.id}">
        <img class="pf2e-cd-mer-item-img" src="${escapeHTML(img)}" alt="" />
        <div class="pf2e-cd-mer-item-main">
          <div class="pf2e-cd-mer-item-line1">
            <span class="pf2e-cd-mer-item-name">${escapeHTML(item.name)}</span>
            ${priceMarkup}
          </div>
          <div class="pf2e-cd-mer-item-line2">
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-cat">${escapeHTML(localizeCategory(cat))}</span>
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-level">L ${lvl}</span>
            ${qty > 1 ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-qty">×${qty}</span>` : ""}
            ${dailyBadge}
            ${ownedBadge}
          </div>
        </div>
        <div class="pf2e-cd-mer-item-actions">
          ${wishlistBtn}
          ${compareBtn}
          ${cartAddBtn}
          ${editQtyBtn}
          ${editOfferBtn}
          ${editPriceBtn}
          <button type="button" class="pf2e-cd-mer-buy" data-action="buy" data-item-id="${item.id}" ${buyDisabled}>
            <i class="fa-solid fa-coins"></i> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.buy")}
          </button>
          ${deleteBtn}
        </div>
      </div>
    `;
  }

  async _handleBuy(itemId, requestedQty = null) {
    const item = this.actor.items.get(itemId);
    if (!item) return;
    if (!this.viewer) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.noViewerActor"));
      return;
    }
    const stockQty = Math.max(1, Number(item.system?.quantity ?? 1));
    let buyQty;
    if (requestedQty != null) {
      buyQty = Math.max(1, Math.min(stockQty, Math.floor(requestedQty)));
    } else if (stockQty > 1) {
      buyQty = await this._promptBuyQuantity(item, stockQty);
      if (buyQty == null) return; // cancelled
    } else {
      buyQty = 1;
    }
    const unitCp = effectiveItemPriceCp(item);
    const totalCp = unitCp * buyQty;
    const buyerCp = priceToCopper({ value: readActorCoins(this.viewer) });
    if (buyerCp < totalCp) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.notEnoughGold"));
      return;
    }
    try {
      if (this._hasMerchantOwnership()) {
        await deductCoins(this.viewer, totalCp);
        await addCoins(this.actor, totalCp);
        const itemData = item.toObject();
        delete itemData._id;
        itemData.system = foundry.utils.duplicate(itemData.system);
        if (itemData.system.quantity != null) itemData.system.quantity = buyQty;
        if (itemData.flags?.[MODULE_ID]) delete itemData.flags[MODULE_ID];
        await this.viewer.createEmbeddedDocuments("Item", [itemData]);
        if (stockQty > buyQty) await item.update({ "system.quantity": stockQty - buyQty });
        else await item.delete();
      } else if (game.users?.activeGM) {
        // Permission denied + GM online → relay through GM
        await callGM("merchant.buy", {
          merchantId: this.actor.id, viewerId: this.viewer.id,
          itemId: item.id, qty: buyQty,
        });
      } else {
        throw new Error("no_permission_no_gm");
      }
      this._logTransaction("buy", item.name, buyQty, totalCp, { img: item.img });
      playBuy();
      this._showTransactionPopup({
        kind: "buy", name: item.name, img: item.img, qty: buyQty, price: formatCopper(totalCp),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | buy failed:`, err);
      const m = err?.message === "no_permission_no_gm"
        ? game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.needGMPermission")
        : this._permissionErrorMessage(err, "buy");
      ui.notifications?.error(m);
    }
  }

  _permissionErrorMessage(err, kind) {
    const msg = String(err?.message ?? err ?? "");
    if (msg.includes("lacks permission") || msg.includes("permission")) {
      return game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.needGMPermission");
    }
    return game.i18n.localize(kind === "sell"
      ? "PF2E_CINEMATIC_MERCHANT.warn.sellFailed"
      : "PF2E_CINEMATIC_MERCHANT.warn.buyFailed");
  }

  /**
   * Ask the player how many to buy via a small popup. Returns the qty or
   * null if cancelled. If max is 1, resolves immediately to 1 (no prompt).
   */
  async _promptBuyQuantity(item, maxQty) {
    if (maxQty <= 1) return 1;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return 1;
    let result = null;
    try {
      await DialogV2.prompt({
        window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.qtyPrompt.title") },
        content: `
          <form class="pf2e-cd-mer-qty-prompt">
            <div class="pf2e-cd-mer-qty-prompt-card">
              <img src="${escapeHTML(item.img ?? "icons/svg/item-bag.svg")}" alt="" />
              <div class="pf2e-cd-mer-qty-prompt-meta">
                <div class="pf2e-cd-mer-qty-prompt-name">${escapeHTML(item.name)}</div>
                <div class="pf2e-cd-mer-qty-prompt-stock">${game.i18n.format("PF2E_CINEMATIC_MERCHANT.qtyPrompt.inStock", { n: maxQty })}</div>
              </div>
            </div>
            <label class="pf2e-cd-mer-qty-prompt-input">
              <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.qtyPrompt.howMany")}</span>
              <input type="number" name="qty" min="1" max="${maxQty}" value="1" step="1" autofocus />
            </label>
          </form>
        `,
        classes: ["pf2e-cd-mer-dialog", "pf2e-cd-mer-qty-dialog"],
        ok: {
          label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.qtyPrompt.confirm"),
          icon: "fa-solid fa-coins",
          callback: (event, button, dialog) => {
            const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
            const raw = Math.floor(Number(root?.querySelector("[name=qty]")?.value ?? 1)) || 1;
            result = Math.max(1, Math.min(maxQty, raw));
          },
        },
      });
    } catch { result = null; }
    return result;
  }

  /**
   * Brief after-sale confirmation toast. Renders a styled card in the corner,
   * auto-dismisses after a short delay, click-to-dismiss early.
   */
  _showTransactionPopup({ kind, name, img, qty, price }) {
    // Drop any existing popup so quick consecutive transactions don't stack.
    document.querySelectorAll(".pf2e-cd-mer-toast").forEach(n => n.remove());
    const verbKey = kind === "sell"
      ? "PF2E_CINEMATIC_MERCHANT.toast.sold"
      : kind === "checkout"
        ? "PF2E_CINEMATIC_MERCHANT.toast.checkout"
        : "PF2E_CINEMATIC_MERCHANT.toast.bought";
    const verb = game.i18n.localize(verbKey);
    const qtyTag = qty > 1 ? ` ×${qty}` : "";
    const root = document.createElement("div");
    root.className = `pf2e-cd-mer-toast pf2e-cd-mer-toast-${kind}`;
    root.innerHTML = `
      <img class="pf2e-cd-mer-toast-img" src="${escapeHTML(img ?? "icons/svg/item-bag.svg")}" alt="" />
      <div class="pf2e-cd-mer-toast-body">
        <div class="pf2e-cd-mer-toast-verb">
          <i class="fa-solid ${kind === "sell" ? "fa-coins" : "fa-circle-check"}"></i>
          ${escapeHTML(verb)}
        </div>
        <div class="pf2e-cd-mer-toast-name">${escapeHTML(name)}${qtyTag}</div>
        <div class="pf2e-cd-mer-toast-price">${escapeHTML(price)}</div>
      </div>
    `;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add("is-shown"));

    const dismiss = () => {
      root.classList.remove("is-shown");
      setTimeout(() => { try { root.remove(); } catch {} }, 320);
    };
    const timer = setTimeout(dismiss, 2500);
    root.addEventListener("click", () => { clearTimeout(timer); dismiss(); });
  }

  /**
   * True if the current user has OWNER permission on the merchant — i.e. they
   * can run buy/sell ops directly without bouncing through the GM client.
   */
  _hasMerchantOwnership() {
    if (!this.actor) return false;
    if (game.user.isGM) return true;
    try {
      return !!this.actor.testUserPermission?.(game.user, "OWNER");
    } catch {
      return false;
    }
  }

  async _handleSellDrop(payload) {
    if (!payload || payload.type !== "Item") return;
    if (!this.viewer) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.noViewerActor"));
      return;
    }
    let item = null;
    try {
      // Resolve dropped item — it should belong to the viewer (their inventory).
      const uuid = payload.uuid;
      if (uuid) item = await fromUuid(uuid);
    } catch { /* tolerate */ }
    if (!item) return;
    if (item.parent?.id !== this.viewer.id) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.sellNotYours"));
      return;
    }
    const baseCp = priceToCopper(item.system?.price);
    const rate = getMerchantSellRate(this.actor);
    const sellCp = Math.floor(baseCp * rate);
    if (sellCp <= 0) {
      ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.itemWorthless"));
      return;
    }
    const proceed = await confirmDialog(
      game.i18n.localize("PF2E_CINEMATIC_MERCHANT.sell.confirmTitle"),
      game.i18n.format("PF2E_CINEMATIC_MERCHANT.sell.confirm", {
        item: item.name,
        price: formatCopper(sellCp),
        rate: Math.round(rate * 100),
      })
    );
    if (!proceed) return;
    try {
      // Add coins to viewer
      await addCoins(this.viewer, sellCp);
      // Deduct from merchant (if has enough), else just credit player
      await deductCoins(this.actor, sellCp);
      // Move item to merchant
      const qty = Number(item.system?.quantity ?? 1);
      const itemData = item.toObject();
      itemData.system = foundry.utils.duplicate(itemData.system);
      if (itemData.system.quantity != null) itemData.system.quantity = 1;
      await this.actor.createEmbeddedDocuments("Item", [itemData]);
      if (qty > 1) {
        await item.update({ "system.quantity": qty - 1 });
      } else {
        await item.delete();
      }
      const speaker = ChatMessage.getSpeaker({ actor: this.viewer });
      ChatMessage.create({
        speaker,
        content: `<div class="pf2e-cd-mer-chat-sell"><strong>${escapeHTML(this.viewer.name)}</strong> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.chat.sold")} <strong>${escapeHTML(item.name)}</strong> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.chat.to")} <em>${escapeHTML(this.actor.name)}</em> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.chat.for")} ${formatCopper(sellCp)}.</div>`
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | sell failed:`, err);
      ui.notifications?.error(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.sellFailed"));
    }
  }

  async _handleEditPrice(itemId) {
    const item = this.actor.items.get(itemId);
    if (!item) return;
    const currentCp = effectiveItemPriceCp(item);
    const currentCoins = copperToCoins(currentCp);
    const content = `
      <form class="pf2e-cd-mer-price-form">
        <p class="pf2e-cd-mer-info">${game.i18n.format("PF2E_CINEMATIC_MERCHANT.window.editPriceFor", { item: escapeHTML(item.name) })}</p>
        <div class="pf2e-cd-mer-price-grid">
          <label>pp <input type="number" min="0" name="pp" value="${currentCoins.pp}"></label>
          <label>gp <input type="number" min="0" name="gp" value="${currentCoins.gp}"></label>
          <label>sp <input type="number" min="0" name="sp" value="${currentCoins.sp}"></label>
          <label>cp <input type="number" min="0" name="cp" value="${currentCoins.cp}"></label>
        </div>
      </form>
    `;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    await DialogV2.prompt({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.editPrice") },
      content,
      classes: ["pf2e-cd-mer-dialog"],
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.savePrice"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const pp = Number(root?.querySelector("[name=pp]")?.value || 0);
          const gp = Number(root?.querySelector("[name=gp]")?.value || 0);
          const sp = Number(root?.querySelector("[name=sp]")?.value || 0);
          const cp = Number(root?.querySelector("[name=cp]")?.value || 0);
          const totalCp = pp * 1000 + gp * 100 + sp * 10 + cp;
          await setItemPriceOverrideCp(item, totalCp);
        },
      },
    });
  }

  _html() {
    const catOpts = `<option value="all">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.cat.all")}</option>` +
      CATEGORIES.map(c => `<option value="${c.value}">${game.i18n.localize(c.labelKey)}</option>`).join("");
    const rarOpts = `<option value="all">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.rarity.all")}</option>` +
      RARITIES.map(r => `<option value="${r}">${localizeRarity(r)}</option>`).join("");

    return `
      <div class="pf2e-cd-mer-vignette"></div>
      <div class="pf2e-cd-mer-frame">
        <button type="button" class="pf2e-cd-mer-popout" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.popoutBtn")}" data-action="popout">
          <i class="fa-solid fa-up-right-from-square"></i>
        </button>
        <button type="button" class="pf2e-cd-mer-close" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-corner tl"></div>
        <div class="pf2e-cd-mer-corner tr"></div>
        <div class="pf2e-cd-mer-corner bl"></div>
        <div class="pf2e-cd-mer-corner br"></div>
        <div class="pf2e-cd-mer-resize" data-role="resize-handle" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.resizeHint")}"></div>
        <div class="pf2e-cd-mer-header">
          <div class="pf2e-cd-mer-subtitle"></div>
          <div class="pf2e-cd-mer-title"></div>
        </div>
        <div class="pf2e-cd-mer-body">
          <div class="pf2e-cd-mer-portrait-col">
            <div class="pf2e-cd-mer-portrait-frame">
              <img class="pf2e-cd-mer-portrait-img" src="" alt="" />
              <button type="button" class="pf2e-cd-mer-portrait-flip" data-action="portrait-flip" hidden title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.portraitFlip")}">
                <i class="fa-solid fa-arrows-left-right"></i>
              </button>
            </div>
            <div class="pf2e-cd-mer-daily-offers" hidden></div>
          </div>
          <div class="pf2e-cd-mer-content-col">
            <div class="pf2e-cd-mer-gm-toolbar" hidden>
              <button type="button" data-action="gm-import">
                <i class="fa-solid fa-circle-plus"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.importBtn")}</span>
              </button>
              <button type="button" data-action="gm-random">
                <i class="fa-solid fa-dice"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.randomBtn")}</span>
              </button>
              <button type="button" data-action="gm-settings">
                <i class="fa-solid fa-sliders"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.settingsBtn")}</span>
              </button>
              <button type="button" data-action="gm-history">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.historyBtn")}</span>
              </button>
              <button type="button" data-action="gm-clear">
                <i class="fa-solid fa-trash-can"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.gm.clearBtn")}</span>
              </button>
            </div>
            <div class="pf2e-cd-mer-back-bar" hidden>
              <button type="button" class="pf2e-cd-mer-back" data-action="back">
                <i class="fa-solid fa-chevron-left"></i>
                <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.backToCategories")}</span>
              </button>
              <span class="pf2e-cd-mer-current-cat"></span>
            </div>
            <div class="pf2e-cd-mer-filters is-collapsed" hidden data-role="merchant-filters">
              <div class="pf2e-cd-mer-filters-primary">
                <input type="text" name="mer-search" placeholder="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.search")}" />
                <select name="mer-rarity">${rarOpts}</select>
                <input type="number" name="mer-level-min" min="0" max="25" placeholder="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.levelMin")}" />
                <input type="number" name="mer-level-max" min="0" max="25" placeholder="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.levelMax")}" />
                <select name="mer-sort">
                  <option value="default">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortDefault")}</option>
                  <option value="priceAsc">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortPriceAsc")}</option>
                  <option value="priceDesc">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortPriceDesc")}</option>
                  <option value="levelAsc">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortLevelAsc")}</option>
                  <option value="levelDesc">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortLevelDesc")}</option>
                  <option value="nameAsc">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.sortNameAsc")}</option>
                </select>
                <label class="pf2e-cd-mer-filter-toggle">
                  <input type="checkbox" name="mer-affordable" />
                  <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.affordable")}</span>
                </label>
                <label class="pf2e-cd-mer-filter-toggle">
                  <input type="checkbox" name="mer-wishlist" />
                  <span><i class="fa-solid fa-bookmark"></i> ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.wishlist")}</span>
                </label>
                <button type="button" class="pf2e-cd-mer-filters-toggle" data-action="filters-toggle">
                  <i class="fa-solid fa-chevron-down"></i>
                  <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.picker.filtersToggle")}</span>
                </button>
              </div>
              <div class="pf2e-cd-mer-filters-advanced" data-role="merchant-filters-advanced" hidden>
                <select name="mer-usage" data-empty-label="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.usageAny")}" hidden></select>
                <select name="mer-group" data-empty-label="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.groupAny")}" hidden></select>
                <select name="mer-bulk" hidden>
                  <option value="all">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.bulkAny")}</option>
                  <option value="0">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.bulk0")}</option>
                  <option value="L">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.bulkLight")}</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4plus">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.bulk4plus")}</option>
                </select>
                <select name="mer-magical" hidden>
                  <option value="all">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.magicalAny")}</option>
                  <option value="yes">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.magicalYes")}</option>
                  <option value="no">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.filter.magicalNo")}</option>
                </select>
              </div>
            </div>
            <div class="pf2e-cd-mer-items"></div>
            <div class="pf2e-cd-mer-empty" hidden>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.empty")}</div>
          </div>
        </div>
        <div class="pf2e-cd-mer-sell-bar" hidden>
          <button type="button" class="pf2e-cd-mer-sell-open" data-action="open-sell">
            <i class="fa-solid fa-hand-holding-dollar"></i>
            <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.sellOpenBtn")}</span>
          </button>
          <button type="button" class="pf2e-cd-mer-vault-open" data-action="open-vault">
            <i class="fa-solid fa-vault"></i>
            <span>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.vaultOpenBtn")}</span>
            <span class="pf2e-cd-mer-vault-count" hidden></span>
          </button>
        </div>
        <button type="button" class="pf2e-cd-mer-cart-floating" data-action="open-cart" hidden>
          <i class="fa-solid fa-basket-shopping"></i>
          <span class="pf2e-cd-mer-cart-count">0</span>
        </button>
        <div class="pf2e-cd-mer-compare-bar" hidden>
          <span class="pf2e-cd-mer-compare-label">
            <i class="fa-solid fa-scale-balanced"></i>
            ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.compareSelected")}
            <span class="pf2e-cd-mer-compare-count">0</span>
          </span>
          <button type="button" class="pf2e-cd-mer-compare-open" data-action="compare-open">
            ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.compareOpen")}
          </button>
          <button type="button" class="pf2e-cd-mer-compare-clear" data-action="compare-clear">
            ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.compareClear")}
          </button>
        </div>
      </div>
    `;
  }
}

// --- Coin manipulation helpers ---

async function deductCoins(actor, cp) {
  if (!actor || cp <= 0) return;
  if (typeof actor.inventory?.removeCoins === "function") {
    return actor.inventory.removeCoins(copperToCoins(cp));
  }
  // Fallback: manually subtract
  const current = actor.system?.coins ?? actor.system?.currency ?? {};
  const totalCp = priceToCopper({ value: current });
  const newCp = Math.max(0, totalCp - cp);
  const newCoins = copperToCoins(newCp);
  return actor.update({ "system.coins": newCoins });
}

async function addCoins(actor, cp) {
  if (!actor || cp <= 0) return;
  if (typeof actor.inventory?.addCoins === "function") {
    return actor.inventory.addCoins(copperToCoins(cp));
  }
  const current = actor.system?.coins ?? actor.system?.currency ?? {};
  const totalCp = priceToCopper({ value: current });
  const newCp = totalCp + cp;
  const newCoins = copperToCoins(newCp);
  return actor.update({ "system.coins": newCoins });
}

async function confirmDialog(title, content) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.confirm({
      window: { title },
      content: `<p>${content}</p>`,
      classes: ["pf2e-cd-mer-dialog"],
    });
  }
  return new Promise(resolve => {
    new Dialog({
      title,
      content: `<p>${content}</p>`,
      buttons: {
        ok: { label: "OK", callback: () => resolve(true) },
        cancel: { label: "Cancel", callback: () => resolve(false) },
      },
      default: "ok",
      close: () => resolve(false),
    }).render(true);
  });
}
