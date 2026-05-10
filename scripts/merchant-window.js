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
  getMerchantGreeting,
  setMerchantGreeting,
  readMerchantCoins,
  setMerchantCoins,
  ensureMerchantOwnership,
  setItemPriceOverrideCp,
  getItemPriceOverrideCp,
  isCoinItem,
  normalizeMerchantType,
} from "./merchant-store.js";
import { openCompendiumPicker } from "./compendium-picker.js";
import { openItemDetails } from "./item-details.js";
import { openSellList } from "./sell-list.js";
import { openCompareModal } from "./compare-modal.js";
import { openRandomStockDialog } from "./random-stock.js";
import { isWishlisted, toggleWishlist, getAllWishlistKeys, getItemKey } from "./wishlist.js";
import { Cart, openCartDrawer } from "./cart.js";
import { playOpen, playBuy, playSell, playClick } from "./sound-fx.js";
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
      greeting:     root.querySelector(".pf2e-cd-mer-greeting"),
      gold:         root.querySelector(".pf2e-cd-mer-gold-value"),
      goldLabel:    root.querySelector(".pf2e-cd-mer-gold-label"),
      closeBtn:     root.querySelector(".pf2e-cd-mer-close"),
      search:       root.querySelector("[name=mer-search]"),
      raritySel:    root.querySelector("[name=mer-rarity]"),
      levelMin:     root.querySelector("[name=mer-level-min]"),
      levelMax:     root.querySelector("[name=mer-level-max]"),
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
      portraitImg:  root.querySelector(".pf2e-cd-mer-portrait-img"),
      portraitFrame:root.querySelector(".pf2e-cd-mer-portrait-frame"),
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
    };

    this._wireUI();
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

  _logTransaction(kind, name, qty, cp) {
    this.transactions.push({ kind, name, qty, cp, when: Date.now() });
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
    if (this.refs.greeting) {
      const greeting = getMerchantGreeting(this.actor).trim();
      if (greeting) {
        this.refs.greeting.textContent = `„${greeting}"`;
        this.refs.greeting.hidden = false;
      } else {
        this.refs.greeting.textContent = "";
        this.refs.greeting.hidden = true;
      }
    }
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
  }

  _refreshGold() {
    const target = this.viewer ?? this.actor;
    if (!target) {
      this.refs.gold.textContent = "—";
      return;
    }
    const coins = readActorCoins(target);
    const cp = priceToCopper({ value: coins });
    console.log(`${MODULE_ID} | purse refresh`, {
      target: target.name,
      isViewer: !!this.viewer,
      coins,
      cp,
      formatted: formatCopper(cp),
    });
    this.refs.goldLabel.textContent = game.i18n.localize(
      this.viewer
        ? "PF2E_CINEMATIC_MERCHANT.window.yourPurse"
        : "PF2E_CINEMATIC_MERCHANT.window.merchantPurse"
    );
    this.refs.gold.textContent = cp > 0 ? formatCopper(cp) : "0 gp";
  }

  _wireUI() {
    this.refs.closeBtn.addEventListener("click", () => this.close());

    if (this.refs.gmImportBtn)   this.refs.gmImportBtn.addEventListener("click", () => this._handleImport());
    if (this.refs.gmClearBtn)    this.refs.gmClearBtn.addEventListener("click",  () => this._handleClearAll());
    if (this.refs.gmSettingsBtn) this.refs.gmSettingsBtn.addEventListener("click", () => this._handleOpenSettings());
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
    const delBtn  = e.target.closest("[data-action=delete]");
    if (delBtn)  { e.stopPropagation(); this._handleDelete(delBtn.dataset.itemId); return; }
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
    try {
      if (this._hasMerchantOwnership()) {
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
      for (const l of lines) this._logTransaction("buy", l.item.name, l.qty, l.lineCp);
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
      classes: ["pf2e-cd-mer-dialog"],
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
      this._logTransaction("sell", item.name, sellQty, totalCp);
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
    const greeting = getMerchantGreeting(this.actor);
    const coins = readMerchantCoins(this.actor);
    const content = `
      <form class="pf2e-cd-mer-settings-form">
        <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.info")}</p>
        <label>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greeting")}
          <textarea name="greeting" rows="2" placeholder="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.greetingPlaceholder"))}">${escapeHTML(greeting)}</textarea>
        </label>
        <fieldset>
          <legend>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.merchantPurse")}</legend>
          <div class="pf2e-cd-mer-settings-coin-grid">
            <label><span>pp</span><input type="number" name="coin-pp" min="0" step="1" value="${coins.pp}" /></label>
            <label><span>gp</span><input type="number" name="coin-gp" min="0" step="1" value="${coins.gp}" /></label>
            <label><span>sp</span><input type="number" name="coin-sp" min="0" step="1" value="${coins.sp}" /></label>
            <label><span>cp</span><input type="number" name="coin-cp" min="0" step="1" value="${coins.cp}" /></label>
          </div>
          <p class="pf2e-cd-mer-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.merchantPurseHint")}</p>
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
      </form>
    `;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return;
    await DialogV2.prompt({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.title") },
      content,
      classes: ["pf2e-cd-mer-dialog"],
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.settings.save"),
        icon: "fa-solid fa-save",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const markupV = Number(root?.querySelector("[name=markup]")?.value ?? 1);
          const sellV = Number(root?.querySelector("[name=sellRate]")?.value ?? 0.5);
          const greetingV = String(root?.querySelector("[name=greeting]")?.value ?? "");
          const newDiscounts = {};
          for (const r of ["common","uncommon","rare","unique"]) {
            newDiscounts[r] = Number(root?.querySelector(`[name=r-${r}]`)?.value ?? 0);
          }
          const newCoins = {
            pp: Number(root?.querySelector("[name=coin-pp]")?.value ?? 0),
            gp: Number(root?.querySelector("[name=coin-gp]")?.value ?? 0),
            sp: Number(root?.querySelector("[name=coin-sp]")?.value ?? 0),
            cp: Number(root?.querySelector("[name=coin-cp]")?.value ?? 0),
          };
          await setMerchantMarkup(this.actor, markupV);
          await setMerchantSellRate(this.actor, sellV);
          await setMerchantRarityDiscounts(this.actor, newDiscounts);
          await setMerchantGreeting(this.actor, greetingV);
          await setMerchantCoins(this.actor, newCoins);
          this._refreshHeader();
          this._renderItems();
          this._refreshGold();
        },
      },
    });
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
    } else {
      this._renderItemList();
    }
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
        ${wishlistTile}
      </div>
    `;

    for (const tile of this.refs.itemList.querySelectorAll(".pf2e-cd-mer-cat-tile")) {
      tile.addEventListener("click", () => this._enterCategory(tile.dataset.cat));
    }
  }

  _enterCategory(cat) {
    if (cat === "__wishlist") {
      this.filters.category = "all";
      this.filters.wishlistOnly = true;
      if (this.refs.wishlistCb) this.refs.wishlistCb.checked = true;
    } else {
      this.filters.category = cat;
      this.filters.wishlistOnly = false;
      if (this.refs.wishlistCb) this.refs.wishlistCb.checked = false;
    }
    this.viewMode = "items";
    this._renderItems();
  }

  _goBackToCategories() {
    this.viewMode = "categories";
    this.filters.category = "all";
    this.filters.search = "";
    this.filters.rarity = "all";
    this.filters.levelMin = null;
    this.filters.levelMax = null;
    this.filters.wishlistOnly = false;
    if (this.refs.search) this.refs.search.value = "";
    if (this.refs.raritySel) this.refs.raritySel.value = "all";
    if (this.refs.levelMin) this.refs.levelMin.value = "";
    if (this.refs.levelMax) this.refs.levelMax.value = "";
    if (this.refs.wishlistCb) this.refs.wishlistCb.checked = false;
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
    const filtered = this._filterItems(items);

    if (filtered.length === 0) {
      this.refs.itemList.innerHTML = "";
      this.refs.empty.hidden = false;
      return;
    }
    this.refs.empty.hidden = true;

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

  _collectItems() {
    if (!this.actor) return [];
    const items = this.actor.items ?? [];
    return [...items].filter(it => {
      if (isCoinItem(it)) return false;
      const allowed = new Set(["weapon","armor","shield","consumable","equipment","treasure","backpack","ammunition","kit"]);
      return it.system?.price !== undefined || allowed.has(it.type);
    });
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
    const deleteBtn = game.user.isGM
      ? `<button type="button" class="pf2e-cd-mer-delete" data-action="delete" data-item-id="${item.id}" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.deleteItem")}"><i class="fa-solid fa-xmark"></i></button>`
      : "";
    const overrideMark = isOverride ? `<span class="pf2e-cd-mer-override" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.priceOverridden")}">*</span>` : "";
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
    return `
      <div class="pf2e-cd-mer-item rarity-${rarity}" data-item-id="${item.id}">
        <img class="pf2e-cd-mer-item-img" src="${escapeHTML(img)}" alt="" />
        <div class="pf2e-cd-mer-item-main">
          <div class="pf2e-cd-mer-item-line1">
            <span class="pf2e-cd-mer-item-name">${escapeHTML(item.name)}</span>
            <span class="pf2e-cd-mer-item-price">${formatCopper(cp)}${overrideMark}</span>
          </div>
          <div class="pf2e-cd-mer-item-line2">
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-cat">${escapeHTML(localizeCategory(cat))}</span>
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-rarity rarity-${rarity}">${escapeHTML(localizeRarity(rarity))}</span>
            <span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-level">L ${lvl}</span>
            ${qty > 1 ? `<span class="pf2e-cd-mer-item-tag pf2e-cd-mer-tag-qty">×${qty}</span>` : ""}
          </div>
        </div>
        <div class="pf2e-cd-mer-item-actions">
          ${wishlistBtn}
          ${compareBtn}
          ${cartAddBtn}
          ${editQtyBtn}
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
      this._logTransaction("buy", item.name, buyQty, totalCp);
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
        <button type="button" class="pf2e-cd-mer-close" title="${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.window.close")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="pf2e-cd-mer-corner tl"></div>
        <div class="pf2e-cd-mer-corner tr"></div>
        <div class="pf2e-cd-mer-corner bl"></div>
        <div class="pf2e-cd-mer-corner br"></div>
        <div class="pf2e-cd-mer-header">
          <div class="pf2e-cd-mer-subtitle"></div>
          <div class="pf2e-cd-mer-title"></div>
          <div class="pf2e-cd-mer-greeting" hidden></div>
          <div class="pf2e-cd-mer-gold-block">
            <span class="pf2e-cd-mer-gold-label"></span>
            <span class="pf2e-cd-mer-gold-value">—</span>
          </div>
        </div>
        <div class="pf2e-cd-mer-body">
          <div class="pf2e-cd-mer-portrait-col">
            <div class="pf2e-cd-mer-portrait-frame">
              <img class="pf2e-cd-mer-portrait-img" src="" alt="" />
            </div>
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
            <div class="pf2e-cd-mer-filters" hidden>
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
