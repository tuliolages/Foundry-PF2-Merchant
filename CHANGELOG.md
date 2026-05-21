# Changelog

All notable changes are listed here. The version format follows [Semantic Versioning](https://semver.org/).

## [0.1.4] — Revert to original category icons

Reverts the icon swaps from v0.1.2 + v0.1.3 because the originals fit the room better:

- Ammunition: `fa-feather-pointed` → `fa-bolt-lightning`
- Container: `fa-box-archive` → `fa-suitcase`
- Armor: `fa-vest` → `fa-shirt`
- Equipment: `fa-cubes-stacked` → `fa-screwdriver-wrench`

The per-category color theming and the soft halo behind each icon from v0.1.2 are kept.

## [0.1.3] — More fantasy-themed category icons

- **Armor** now uses `fa-vest` (body-armor shape) instead of `fa-shirt` (which read as a modern T-shirt).
- **Equipment** now uses `fa-cubes-stacked` (a pile of crates / adventurer's gear) instead of `fa-screwdriver-wrench` (which read as a modern hardware-store toolkit).
- Same icon set is now applied consistently in the merchant window, the random-stock dialog, and the compendium import dialog (was out of sync between the three).

## [0.1.2] — Prettier category tiles

- Each category tile now has its own thematic color (gold for treasure, green for consumables, brown for armor and containers, steel-blue for shields, etc.) — instant visual recognition.
- Soft circular halo behind every icon with a per-category tint; hover ramps the glow and scales the icon, no more uniform red wall.
- Ammunition icon swapped from a lightning bolt (`fa-bolt-lightning`) to a feathered shaft (`fa-feather-pointed`) — less ambiguous when the same word means both electric and projectile.
- Container icon swapped from a modern suitcase to a chest archive (`fa-box-archive`) to fit the fantasy vibe.

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
