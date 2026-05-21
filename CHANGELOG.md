# Changelog

All notable changes are listed here. The version format follows [Semantic Versioning](https://semver.org/).

## [0.1.1] — Display tweaks

- `formatCopper` collapses platinum into gold for display (`10 pp` → `100 gp`, `10 pp 5 gp` → `105 gp`). PF2e tables reckon in gp regardless of magnitude; pp is mostly a book-side shorthand. sp + cp keep their own denominations. Input fields that let GMs type prices in pp/gp/sp/cp are unaffected — only the rendered total changes.

## [0.1.0] — Initial public release

The first publicly available build of **PF2e Merchant**. Bundles everything below.

### Shop window
- Click-a-tile shop launch via Tile HUD's Link Merchant button.
- Per-tile rectangular click area editor (visual drag handles) — only the visible character triggers the shop.
- Optional alpha-channel hit mask (Monk's-ATT-style) for PNG/WEBP tiles with transparency.
- Cinematic parchment frame: draggable header, bottom-right resize grip, popout into a separate OS-level browser window.
- Container-query responsive layout adapts the inner layout to the frame width — not just the viewport — so resize, popout and side-panel use all work.
- Body scrolls on short viewports while the header (close button + ornaments) stays pinned.

### Merchant management
- Bulk import from any Item compendium with rich filters (search, rarity, level, pack, usage, group, bulk, magical, traits, max-price) and per-item quantity ranges with apply-to-all.
- Weighted random stock generator (category chips + rarity weights + level range + count + min/max qty) with loading overlay, progress bar and auto-pick for PF2E ChoiceSet prompts that pop up during creation.
- Per-merchant settings: greeting sounds (multiple, played at random on open), markup multiplier, buy-back rate, per-rarity discounts, per-character discounts via dropdown.
- GM portrait mirror toggle saved on the actor.
- Per-merchant daily offers with discount badges, jump-to-row from the under-portrait card list.

### Player experience
- Categories grid → filtered items list with collapsible advanced filters.
- "You already own this" badge using compendium-source / name+type identity matching.
- Cart with typeable quantity inputs, atomic checkout, total stays right-aligned so the +/- buttons don't jump.
- Wishlist + 2/3-item compare modal.
- Per-character vault (private stash).
- Service tab with dedicated SRD-preset browser dialog (search, subcategory chips, multi-select).

### History & accounting
- Per-merchant transaction log persisted to actor flags.
- GM-only history dialog with totals, search, buy/sell filter, character + relative timestamp, item icons.
- Player buys via GM-relay (no merchant ownership) are logged server-side, cart checkouts are batched in a single update so nothing races.

### Localization
- English + German strings.

### Compatibility
- Foundry VTT v13 (verified) and v14.
- Pathfinder 2e system (v6.0.0+).
- Optional integration with Foundry's FilePicker for audio + icon selection.
