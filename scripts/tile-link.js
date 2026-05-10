import { MODULE_ID, getTileMerchantActorId, setTileMerchantActorId, getMerchantActor, ensureMerchantOwnership } from "./merchant-store.js";

let _onTileClick = null;

export function registerTileHooks(onTileClick) {
  _onTileClick = onTileClick;

  // GM: add a "Link Merchant" button to the Tile HUD.
  Hooks.on("renderTileHUD", (hud, html) => {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    if (root.querySelector(".pf2e-cd-mer-hud-link")) return;

    const tileDoc = hud.object?.document ?? hud.object;
    const linkedId = getTileMerchantActorId(tileDoc);

    const btn = document.createElement("div");
    btn.className = "control-icon pf2e-cd-mer-hud-link";
    if (linkedId) btn.classList.add("is-linked");
    btn.dataset.action = "link-merchant";
    btn.title = linkedId
      ? game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.relink")
      : game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.link");
    btn.innerHTML = `<i class="fa-solid fa-store"></i>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLinkPicker(tileDoc);
    });

    const col = root.querySelector(".col.left") ?? root;
    col.appendChild(btn);
  });

  console.log("pf2e-cinematic-merchant | registerTileHooks called", {
    hasCanvas: !!canvas,
    canvasReady: !!canvas?.ready,
    hasStage: !!canvas?.stage,
    activeScene: !!game.scenes?.active,
  });
  // Stage-level click handler — works for players regardless of which layer is active.
  Hooks.on("canvasReady", () => {
    console.log("pf2e-cinematic-merchant | canvasReady hook fired");
    attachStageHandler();
  });
  // Foundry's canvasReady fires BEFORE the ready hook, so if a scene is already
  // loaded by the time we register, we missed the event. Attach immediately too.
  if (canvas?.ready) attachStageHandler();
}

let _stageHandler = null;
let _domHandler = null;

function attachStageHandler() {
  console.log("pf2e-cinematic-merchant | attachStageHandler", {
    hasStage: !!canvas?.stage,
    canvasReady: !!canvas?.ready,
    hasView: !!canvas?.app?.view,
  });

  // DOM-level pointerdown — fires for everyone regardless of PIXI layer permissions.
  const view = canvas?.app?.view;
  if (view) {
    if (_domHandler) {
      try { view.removeEventListener("pointerdown", _domHandler); } catch {}
    }
    _domHandler = (e) => onCanvasDomClick(e);
    view.addEventListener("pointerdown", _domHandler);
    console.log("pf2e-cinematic-merchant | DOM pointerdown handler attached on canvas.app.view");
  }

  if (!canvas?.stage) {
    console.warn("pf2e-cinematic-merchant | canvas.stage missing — handler not attached");
    return;
  }
  if (_stageHandler) {
    try { canvas.stage.off("pointerdown", _stageHandler); } catch { /* tolerate */ }
    _stageHandler = null;
  }
  _stageHandler = (event) => {
    try {
      const tiles = canvas.tiles?.placeables ?? [];
      const merchantTiles = tiles.filter(t => getTileMerchantActorId(t.document));
      const button = event?.data?.button ?? event?.data?.originalEvent?.button ?? event?.button;
      const activeLayerName = canvas.activeLayer?.constructor?.name;
      let point = null;
      try { point = event.data?.getLocalPosition?.(canvas.tiles) ?? null; } catch {}

      const global = event?.data?.global;
      let stageLocal = null;
      try { stageLocal = canvas.stage?.toLocal?.(global) ?? null; } catch {}
      console.log("pf2e-cinematic-merchant | click event", {
        button,
        activeLayer: activeLayerName,
        pointX: point?.x, pointY: point?.y,
        globalX: global?.x, globalY: global?.y,
        stageLocalX: stageLocal?.x, stageLocalY: stageLocal?.y,
        canvasMouseX: canvas.mousePosition?.x, canvasMouseY: canvas.mousePosition?.y,
        tilesTotal: tiles.length,
        merchantTilesCount: merchantTiles.length,
        firstMerchantTile: merchantTiles[0] ? {
          id: merchantTiles[0].id,
          x: merchantTiles[0].document.x,
          y: merchantTiles[0].document.y,
          w: merchantTiles[0].document.width,
          h: merchantTiles[0].document.height,
          actorId: getTileMerchantActorId(merchantTiles[0].document),
        } : null,
      });

      if (button !== 0 && button !== undefined) return;

      // GM: don't hijack clicks while the tiles layer is active (tile management mode).
      if (game.user.isGM && canvas.activeLayer === canvas.tiles) {
        console.log("pf2e-cinematic-merchant | GM on tiles layer, skipping shop open");
        return;
      }

      if (!point) return;

      // Iterate top-to-bottom (last placed = drawn on top).
      for (let i = tiles.length - 1; i >= 0; i--) {
        const tile = tiles[i];
        const actorId = getTileMerchantActorId(tile.document);
        if (!actorId) continue;
        const doc = tile.document;
        const inX = point.x >= doc.x && point.x <= doc.x + doc.width;
        const inY = point.y >= doc.y && point.y <= doc.y + doc.height;
        console.log(`pf2e-cinematic-merchant | hit-test tile ${tile.id}`, { inX, inY, point, doc: { x: doc.x, y: doc.y, w: doc.width, h: doc.height } });
        if (!inX || !inY) continue;
        const actor = getMerchantActor(actorId);
        if (!actor) {
          ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.actorMissing"));
          return;
        }
        console.log("pf2e-cinematic-merchant | opening shop for actor", actor.name);
        if (typeof _onTileClick === "function") _onTileClick(actor, tile);
        return;
      }
    } catch (err) {
      console.warn("pf2e-cinematic-merchant | stage click handler error:", err);
    }
  };
  canvas.stage.on("pointerdown", _stageHandler);
  console.log("pf2e-cinematic-merchant | stage pointer handler attached");
}

function onCanvasDomClick(e) {
  try {
    if (e.button !== 0) return;
    if (game.user.isGM && canvas.activeLayer === canvas.tiles) return;

    // Foundry maintains canvas.mousePosition in scene coords, updated on mousemove.
    const mp = canvas.mousePosition;
    const tiles = canvas.tiles?.placeables ?? [];
    const merchantTiles = tiles.filter(t => getTileMerchantActorId(t.document));
    const firstM = merchantTiles[0]?.document;
    console.log("pf2e-cinematic-merchant | DOM click", {
      mouseX: mp?.x, mouseY: mp?.y,
      tilesTotal: tiles.length,
      merchantTilesCount: merchantTiles.length,
      firstTileX: firstM?.x, firstTileY: firstM?.y,
      firstTileW: firstM?.width, firstTileH: firstM?.height,
      firstTileRot: firstM?.rotation,
      firstTileDeltaX: firstM ? mp.x - firstM.x : null,
      firstTileDeltaY: firstM ? mp.y - firstM.y : null,
      firstTileXMin: firstM?.x, firstTileXMax: firstM ? firstM.x + firstM.width : null,
      firstTileYMin: firstM?.y, firstTileYMax: firstM ? firstM.y + firstM.height : null,
    });

    if (!mp) return;

    for (let i = tiles.length - 1; i >= 0; i--) {
      const tile = tiles[i];
      const actorId = getTileMerchantActorId(tile.document);
      if (!actorId) continue;
      const doc = tile.document;
      // Use the tile's full bounds rect — handles rotated/anchored tiles correctly.
      const bounds = tile.bounds ?? null;
      let inX, inY;
      if (bounds) {
        inX = mp.x >= bounds.x && mp.x <= bounds.x + bounds.width;
        inY = mp.y >= bounds.y && mp.y <= bounds.y + bounds.height;
      } else {
        inX = mp.x >= doc.x && mp.x <= doc.x + doc.width;
        inY = mp.y >= doc.y && mp.y <= doc.y + doc.height;
      }
      console.log(`pf2e-cinematic-merchant | DOM hit-test ${tile.id}`, {
        usedBounds: !!bounds,
        boundsX: bounds?.x, boundsY: bounds?.y, boundsW: bounds?.width, boundsH: bounds?.height,
        docX: doc.x, docY: doc.y, docW: doc.width, docH: doc.height,
        inX, inY,
      });
      if (!inX || !inY) continue;
      const actor = getMerchantActor(actorId);
      if (!actor) {
        ui.notifications?.warn(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.warn.actorMissing"));
        return;
      }
      console.log("pf2e-cinematic-merchant | DOM click hits merchant tile, opening shop", actor.name);
      if (typeof _onTileClick === "function") _onTileClick(actor, tile);
      return;
    }
  } catch (err) {
    console.warn("pf2e-cinematic-merchant | DOM click handler error:", err);
  }
}

async function openLinkPicker(tileDoc) {
  const lootActors = (game.actors ?? []).filter(a => a.type === "loot");
  const currentId = getTileMerchantActorId(tileDoc);

  const options = lootActors
    .map(a => `<option value="${a.id}"${a.id === currentId ? " selected" : ""}>${a.name}</option>`)
    .join("");

  const content = `
    <form class="pf2e-cd-mer-link-form">
      <p class="pf2e-cd-mer-link-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkInfo")}</p>
      <label>
        ${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.lootActor")}
        <select name="actorId">
          <option value="">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.unlink")}</option>
          ${options}
        </select>
      </label>
      ${lootActors.length === 0 ? `<p class="pf2e-cd-mer-link-warn">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.noLootActors")}</p>` : ""}
    </form>
  `;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    await DialogV2.prompt({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkDialogTitle") },
      content,
      classes: ["pf2e-cd-mer-dialog"],
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkSave"),
        icon: "fa-solid fa-link",
        callback: (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const select = root?.querySelector("[name=actorId]");
          const value = select?.value || null;
          setTileMerchantActorId(tileDoc, value);
          if (value) ensureMerchantOwnership(getMerchantActor(value));
          attachMerchantTileHandlers();
        },
      },
    });
    return;
  }

  // Legacy fallback
  new Dialog({
    title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkDialogTitle"),
    content,
    buttons: {
      save: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkSave"),
        icon: '<i class="fa-solid fa-link"></i>',
        callback: (jq) => {
          const root = jq instanceof HTMLElement ? jq : jq?.[0];
          const value = root?.querySelector("[name=actorId]")?.value || null;
          setTileMerchantActorId(tileDoc, value);
          if (value) ensureMerchantOwnership(getMerchantActor(value));
          attachMerchantTileHandlers();
        },
      },
      cancel: { label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkCancel") },
    },
    default: "save",
  }).render(true);
}
