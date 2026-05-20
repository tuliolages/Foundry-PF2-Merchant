# PF2e Merchant

A click-a-tile merchant-shop module for the **Pathfinder 2e** system in Foundry VTT. Link any tile in your scene to a Loot actor and players get a parchment-themed shop window when they click on it — categories, filters, cart checkout, services, daily offers, transaction history, and a lot more.

![Foundry VTT v13 / v14](https://img.shields.io/badge/Foundry-v13--v14-informational)
![PF2E system](https://img.shields.io/badge/system-PF2E-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Tile-linked merchants** — link any image tile to a Loot actor; players click the tile, the shop opens. Per-tile rectangular click area editor + optional alpha-mask hit detection (Monk's ATT style) so only the visible character triggers the shop.
- **Cinematic shop window** — large parchment frame with portrait, category tiles, filtered item list, services tab, draggable header, manual resize grip, popout into a separate browser window (Foundry V14 style), and Foundry-V13 container-query responsive layout that adapts at every width.
- **Bulk stock generation** — the GM can fill a merchant from any Item compendium using a powerful picker (search, rarity, level, pack, usage, group, bulk, magical, traits, max price) with per-item quantity ranges, or use weighted random rolls (category chips + rarity weights + count + level range).
- **Cart with checkout** — players add items to a cart, edit qty inline by typing, and atomically check out (single coin deduct + bulk creation, all-or-nothing).
- **Daily offers** — GM marks items as discounted (0-95%); offers appear as cards under the portrait with original/sale prices and a clickable jump-to-row.
- **Per-character discounts** — pro player character a discount/surcharge (-100..+100%) configurable in merchant settings; applies to buy AND sell.
- **Services** — non-item services (spellcasting, hireling, lodging, etc.) with a curated SRD-preset browser (search, subcategory chips, multi-select) and a clean form for custom services.
- **Transaction history** — every buy and sell is persisted per-merchant; GM-only dialog shows totals, search, filter by buy/sell, with character + relative timestamp.
- **Wishlist + compare** — players bookmark items, compare 2-3 side-by-side.
- **Personal vault** — per-character stash that travels with the player across merchants.
- **Per-merchant greeting sounds** — multiple audio files; one plays at random on open.
- **GM portrait mirror toggle** — flip the merchant's image without re-uploading.
- **PF2e-aware** — uses the system's compendium index fields, ChoiceSet auto-pick during random stock generation, ammunition handling, item identity for "you already own this" badges in the item list.

## Installation

### From the in-app browser (after Foundry approval)

1. In Foundry, open **Configuration → Add-on Modules → Install Module**.
2. Search for `Cinematic Merchant` and click **Install**.

### Manifest URL

If you want to install before the official listing is approved, paste this URL into the **Manifest URL** field on Foundry's Install Module screen:

```
https://github.com/Iceman1991/Foundry-PF2-Merchant/releases/latest/download/module.json
```

### Requirements

- **Foundry VTT v13 or v14** (verified on v13; v14 supported)
- **Pathfinder 2e system** (≥ v6.0.0)

## Quick start

1. Enable the module in your world.
2. Create or pick a **Loot actor** that will represent the merchant's stock.
3. Drop an image tile into the scene (the merchant's portrait, sign, building, etc.).
4. Right-click the tile and use the **Link Merchant** button in the Tile HUD.
5. In the dialog, pick the Loot actor and optionally drag the rectangular click area to cover just the character.
6. As GM, click the tile to open the shop. Use the GM toolbar (top-right) to import items from the compendium, roll random stock, configure markup/discounts/greeting sounds, or review the transaction history.
7. Players click the same tile and see a player-facing shop with the same stock.

## Configuration

Open the merchant window as GM and click **Settings** in the toolbar to set:

- **Greeting sounds** — list of audio files; one plays at random when the shop opens.
- **Markup multiplier** — applies to all buy prices (1.0 = normal).
- **Buy-back rate** — player's share of base price when they sell to this merchant.
- **Rarity discounts** — per-rarity discount or surcharge.
- **Character discounts** — add specific player characters and give them a custom discount/surcharge.

## License

[MIT](LICENSE) © 2026 gooze

## Contributing / Bug reports

- Issues: <https://github.com/Iceman1991/Foundry-PF2-Merchant/issues>
- Pull requests welcome.

## Credits

Built for the Pathfinder 2e Foundry community. Service presets adapted from the public PF2e SRD.
