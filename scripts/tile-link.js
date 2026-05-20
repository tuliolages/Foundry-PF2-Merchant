import {
  MODULE_ID,
  getTileMerchantActorId, setTileMerchantActorId,
  getTileClickArea, setTileClickArea,
  getTileUseImageAlpha, setTileUseImageAlpha,
  getMerchantActor, ensureMerchantOwnership,
} from "./merchant-store.js";

let _onTileClick = null;

// === Alpha-channel hit testing =========================================
// We only want clicks on the *visible* parts of a merchant portrait to open
// the shop — clicking the transparent area around the character should pass
// through to the rest of the canvas. We cache a sampled copy of each tile's
// texture on a hidden 2D canvas so we can read alpha at any (u, v).

const ALPHA_THRESHOLD = 32;     // 0..255; everything below counts as "transparent"
const SAMPLER_MAX_DIM = 1024;   // cap sampled texture size for perf
const _alphaSamplers = new Map(); // src -> { ready: Promise, sample: (u,v) => number|null }

function getAlphaSampler(src) {
  if (!src) return null;
  const cached = _alphaSamplers.get(src);
  if (cached) return cached;
  const entry = { ready: null, sample: null, w: 0, h: 0, src };
  entry.ready = new Promise((resolve) => {
    const img = new Image();
    // Do NOT set crossOrigin — Foundry assets are typically same-origin, and
    // explicitly opting into CORS can prevent the image from loading at all
    // if the server doesn't return CORS headers. If the canvas is tainted on
    // getImageData, we catch it below and fall back gracefully.
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) {
          entry.sample = () => 255;
          resolve();
          return;
        }
        const scale = Math.min(1, SAMPLER_MAX_DIM / Math.max(iw, ih));
        const W = Math.max(1, Math.round(iw * scale));
        const H = Math.max(1, Math.round(ih * scale));
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        const data = ctx.getImageData(0, 0, W, H).data;
        entry.w = W;
        entry.h = H;
        entry.sample = (u, v) => {
          if (!Number.isFinite(u) || !Number.isFinite(v)) return 255;
          if (u < 0 || u > 1 || v < 0 || v > 1) return 255; // treat off-texture as opaque (permissive)
          const x = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
          const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
          return data[(y * W + x) * 4 + 3];
        };
        console.log(`${MODULE_ID} | alpha sampler ready for ${src} (${W}×${H})`);
      } catch (err) {
        // Likely a CORS taint or other security restriction — getImageData
        // throws. Fall back to "always opaque" so behaviour matches the
        // original bounding-box hit test.
        console.warn(`${MODULE_ID} | alpha sampler tainted for ${src}, falling back to bounds:`, err);
        entry.sample = () => 255;
      }
      resolve();
    };
    img.onerror = (err) => {
      console.warn(`${MODULE_ID} | alpha sampler image failed to load: ${src}`, err);
      entry.sample = () => 255;
      resolve();
    };
    img.src = src;
  });
  _alphaSamplers.set(src, entry);
  return entry;
}

/**
 * Convert a scene-space point into a UV coordinate inside the tile RECT
 * (0..1 across the tile rectangle, not the texture). This is mirror-agnostic
 * because the tile rectangle in scene space is not flipped by texture mirror —
 * only the IMAGE drawn inside it is. Click area is stored in these same
 * tile-rect coords so a rect drawn over the displayed character at scene
 * position X always matches a click at scene position X.
 *
 * Prefer tile.bounds when available — Foundry recomputes that to be the
 * actual rendered rect, so the math survives whatever V13/V14 ends up doing
 * with TileDocument's x/y/width/height anchoring.
 */
function sceneToTileUV(tile, scenePoint) {
  const doc = tile.document;
  const bounds = tile.bounds;
  const rot = Number(doc.rotation) || 0;
  // Pick the rect to normalize against. For non-rotated tiles, bounds == doc
  // == the displayed rect — perfect. For rotated tiles, bounds is the AABB
  // (larger than the rotated rect), so we apply inverse rotation against the
  // doc rect instead.
  let cx, cy, w, h;
  if (rot === 0 && bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.width)) {
    cx = bounds.x + bounds.width / 2;
    cy = bounds.y + bounds.height / 2;
    w = bounds.width;
    h = bounds.height;
  } else {
    cx = doc.x + doc.width / 2;
    cy = doc.y + doc.height / 2;
    w = doc.width;
    h = doc.height;
  }
  let rx = scenePoint.x - cx;
  let ry = scenePoint.y - cy;
  if (rot !== 0) {
    const rad = -rot * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const x2 = rx * cos - ry * sin;
    const y2 = rx * sin + ry * cos;
    rx = x2; ry = y2;
  }
  const u = rx / w + 0.5;
  const v = ry / h + 0.5;
  return { u, v };
}

/** UV in the original IMAGE (after un-mirroring the displayed-tile UV).
 *  Used by the alpha sampler which reads from the unmirrored source image. */
function tileUVToImageUV(tile, u, v) {
  const doc = tile.document;
  const sx = Number(doc.texture?.scaleX ?? 1);
  const sy = Number(doc.texture?.scaleY ?? 1);
  return {
    u: sx < 0 ? 1 - u : u,
    v: sy < 0 ? 1 - v : v,
  };
}

/** Check if scenePoint is inside the tile's GM-defined click rectangle. */
function isInsideClickArea(tile, scenePoint) {
  const area = getTileClickArea(tile.document);
  if (!area) return true; // no override → entire tile is clickable
  const uv = sceneToTileUV(tile, scenePoint);
  if (!uv) return true;
  const { u, v } = uv;
  const inside = u >= area.x && u <= area.x + area.w && v >= area.y && v <= area.y + area.h;
  console.log(`${MODULE_ID} | hit-area test`, {
    tile: tile.id, area,
    pointU: u.toFixed(3), pointV: v.toFixed(3),
    inside,
    doc: { x: tile.document.x, y: tile.document.y, w: tile.document.width, h: tile.document.height, rot: tile.document.rotation },
  });
  return inside;
}

/**
 * @returns {boolean} true if the pixel under scenePoint is opaque enough to
 *   register as a hit. Defaults to true (opaque) on any failure path so the
 *   user can always open the shop — the alpha gate is opt-in for "feels nicer",
 *   not "blocks merchant access".
 */
function isOpaqueAtScenePoint(tile, scenePoint) {
  try {
    // Only run the alpha check on tiles that explicitly opt in. Default
    // (false) behaves exactly like vanilla Foundry: the entire tile rect is
    // a click target.
    if (!getTileUseImageAlpha(tile.document)) return true;
    const src = tile.document?.texture?.src;
    if (!src) return true;
    const sampler = getAlphaSampler(src);
    if (!sampler?.sample) return true; // not ready yet → permit
    const tileUv = sceneToTileUV(tile, scenePoint);
    if (!tileUv) return true;
    // Sample the original (un-mirrored) image, so mirrored tiles still
    // hit-test against the right pixel of the source texture.
    const uv = tileUVToImageUV(tile, tileUv.u, tileUv.v);
    if (!Number.isFinite(uv.u) || !Number.isFinite(uv.v)) return true;
    if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return true;
    const alpha = sampler.sample(uv.u, uv.v);
    const opaque = alpha >= ALPHA_THRESHOLD;
    if (!opaque) {
      console.log(`${MODULE_ID} | alpha hit-test rejected click on ${tile.id}`, { tileU: tileUv.u.toFixed(3), tileV: tileUv.v.toFixed(3), imgU: uv.u.toFixed(3), imgV: uv.v.toFixed(3), alpha });
    }
    return opaque;
  } catch (err) {
    console.warn(`${MODULE_ID} | alpha hit-test threw, falling back to opaque:`, err);
    return true;
  }
}

function prewarmMerchantTileSamplers() {
  const tiles = canvas?.tiles?.placeables ?? [];
  for (const tile of tiles) {
    if (!getTileMerchantActorId(tile.document)) continue;
    const src = tile.document?.texture?.src;
    if (src) getAlphaSampler(src);
  }
}

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
    prewarmMerchantTileSamplers();
  });
  // Foundry's canvasReady fires BEFORE the ready hook, so if a scene is already
  // loaded by the time we register, we missed the event. Attach immediately too.
  if (canvas?.ready) {
    attachStageHandler();
    prewarmMerchantTileSamplers();
  }
  // Re-prewarm when a tile's texture changes (relink, new merchant, etc.).
  Hooks.on("updateTile", () => prewarmMerchantTileSamplers());
  Hooks.on("createTile", () => prewarmMerchantTileSamplers());
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
        // GM-defined rectangular click area: if set, click must fall inside it.
        if (!isInsideClickArea(tile, point)) {
          console.log(`pf2e-cinematic-merchant | click outside hit area of ${tile.id}, passing through`);
          continue;
        }
        // Alpha gate — skip clicks on transparent parts of the tile texture.
        if (!isOpaqueAtScenePoint(tile, point)) {
          console.log(`pf2e-cinematic-merchant | click on transparent pixel of ${tile.id}, passing through`);
          continue;
        }
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
      if (!isInsideClickArea(tile, mp)) {
        console.log(`pf2e-cinematic-merchant | DOM click outside hit area of ${tile.id}, passing through`);
        continue;
      }
      if (!isOpaqueAtScenePoint(tile, mp)) {
        console.log(`pf2e-cinematic-merchant | DOM click on transparent pixel of ${tile.id}, passing through`);
        continue;
      }
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
  const currentArea = getTileClickArea(tileDoc) ?? { x: 0, y: 0, w: 1, h: 1 };
  const currentUseAlpha = getTileUseImageAlpha(tileDoc);
  const tileImgSrc = tileDoc?.texture?.src ?? "";
  // If the tile is mirrored (negative texture.scaleX / scaleY), reflect that
  // in the editor preview so the GM draws the rectangle on the same orientation
  // they actually see in the scene.
  const tileSx = Number(tileDoc?.texture?.scaleX ?? 1);
  const tileSy = Number(tileDoc?.texture?.scaleY ?? 1);
  const tileMirrorTransform = (tileSx < 0 || tileSy < 0)
    ? `scale(${tileSx < 0 ? -1 : 1}, ${tileSy < 0 ? -1 : 1})`
    : "";

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
      ${tileImgSrc ? `
      <fieldset class="pf2e-cd-mer-hitzone-field">
        <legend>${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.clickAreaLegend")}</legend>
        <p class="pf2e-cd-mer-link-info">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.clickAreaHint")}</p>
        ${tileMirrorTransform ? `<p class="pf2e-cd-mer-link-warn">${game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.clickAreaMirrorNote")}</p>` : ""}
        <div class="pf2e-cd-mer-hitzone-editor" data-role="hitzone-editor">
          <div class="pf2e-cd-mer-hitzone-wrap" data-mirror-x="${tileSx < 0 ? "1" : "0"}" data-mirror-y="${tileSy < 0 ? "1" : "0"}">
            <img class="pf2e-cd-mer-hitzone-img" src="${escapeHTML(tileImgSrc)}" alt="" draggable="false" style="transform: scale(${tileSx < 0 ? -1 : 1}, ${tileSy < 0 ? -1 : 1});" />
            <div class="pf2e-cd-mer-hitzone-shade" data-role="hitzone-shade"></div>
            <div class="pf2e-cd-mer-hitzone-rect" data-role="hitzone-rect">
              <div class="pf2e-cd-mer-hitzone-handle" data-handle="nw"></div>
              <div class="pf2e-cd-mer-hitzone-handle" data-handle="ne"></div>
              <div class="pf2e-cd-mer-hitzone-handle" data-handle="sw"></div>
              <div class="pf2e-cd-mer-hitzone-handle" data-handle="se"></div>
            </div>
          </div>
        </div>
        <div class="pf2e-cd-mer-hitzone-actions">
          <button type="button" class="pf2e-cd-mer-hitzone-reset" data-action="hitzone-reset">
            <i class="fa-solid fa-expand"></i>
            <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.clickAreaReset"))}</span>
          </button>
        </div>
        <label class="pf2e-cd-mer-hitzone-alpha-toggle" title="${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.useImageAlphaHint"))}">
          <input type="checkbox" name="useImageAlpha"${currentUseAlpha ? " checked" : ""} />
          <span>${escapeHTML(game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.useImageAlpha"))}</span>
        </label>
      </fieldset>` : ""}
    </form>
  `;

  // Mutable state — the editor writes here and the save callback reads here.
  const state = { area: { ...currentArea } };

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    await DialogV2.prompt({
      window: { title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkDialogTitle") },
      position: { width: 520 },
      content,
      classes: ["pf2e-cd-mer-dialog"],
      render: (event, dialog) => {
        const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
        if (!root || !tileImgSrc) return;
        const editor = root.querySelector("[data-role=hitzone-editor]");
        if (editor) wireHitZoneEditor(editor, state);
      },
      ok: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkSave"),
        icon: "fa-solid fa-link",
        callback: async (event, button, dialog) => {
          const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
          const select = root?.querySelector("[name=actorId]");
          const value = select?.value || null;
          const useAlpha = !!root?.querySelector("[name=useImageAlpha]")?.checked;
          // Bundle everything into a single tileDoc.update so the three
          // independent flag writes can't race / drop each other.
          const updates = {};
          if (value) {
            updates[`flags.${MODULE_ID}.actorId`] = value;
          } else {
            updates[`flags.${MODULE_ID}.-=actorId`] = null;
          }
          if (tileImgSrc) {
            const a = state.area;
            const isFull = !a || (a.x <= 0 && a.y <= 0 && a.x + a.w >= 1 && a.y + a.h >= 1);
            if (isFull) {
              updates[`flags.${MODULE_ID}.-=clickArea`] = null;
            } else {
              updates[`flags.${MODULE_ID}.clickArea`] = {
                x: Math.max(0, Math.min(1, a.x)),
                y: Math.max(0, Math.min(1, a.y)),
                w: Math.max(0.02, Math.min(1, a.w)),
                h: Math.max(0.02, Math.min(1, a.h)),
              };
            }
          }
          if (useAlpha) updates[`flags.${MODULE_ID}.useImageAlpha`] = true;
          else updates[`flags.${MODULE_ID}.-=useImageAlpha`] = null;
          try { await tileDoc.update(updates); }
          catch (err) { console.warn(`${MODULE_ID} | tile update failed:`, err); }
          if (value) ensureMerchantOwnership(getMerchantActor(value));
        },
      },
    });
    return;
  }

  // Legacy fallback (V11 Dialog) — no hit-zone editor, just the loot picker.
  new Dialog({
    title: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkDialogTitle"),
    content,
    buttons: {
      save: {
        label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkSave"),
        icon: '<i class="fa-solid fa-link"></i>',
        callback: async (jq) => {
          const root = jq instanceof HTMLElement ? jq : jq?.[0];
          const value = root?.querySelector("[name=actorId]")?.value || null;
          await setTileMerchantActorId(tileDoc, value);
          if (value) ensureMerchantOwnership(getMerchantActor(value));
        },
      },
      cancel: { label: game.i18n.localize("PF2E_CINEMATIC_MERCHANT.tile.linkCancel") },
    },
    default: "save",
  }).render(true);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// === Hit-zone visual editor =============================================
// Drag-corners + drag-body interactive rectangle on top of the tile image.
// Writes back into state.area (in 0..1 fractions) every move.

function wireHitZoneEditor(editor, state) {
  const wrap = editor.querySelector(".pf2e-cd-mer-hitzone-wrap");
  const rect = editor.querySelector("[data-role=hitzone-rect]");
  const shade = editor.querySelector("[data-role=hitzone-shade]");
  const resetBtn = editor.parentElement?.querySelector("[data-action=hitzone-reset]");
  if (!wrap || !rect || !shade) return;

  const repaint = () => {
    const a = state.area;
    rect.style.left = `${a.x * 100}%`;
    rect.style.top = `${a.y * 100}%`;
    rect.style.width = `${a.w * 100}%`;
    rect.style.height = `${a.h * 100}%`;
    // Dim everything outside the rect via four overlays — easier than
    // clip-path and keeps the rect itself crisply transparent.
    shade.style.setProperty("--rect-left", `${a.x * 100}%`);
    shade.style.setProperty("--rect-top", `${a.y * 100}%`);
    shade.style.setProperty("--rect-right", `${(1 - a.x - a.w) * 100}%`);
    shade.style.setProperty("--rect-bottom", `${(1 - a.y - a.h) * 100}%`);
  };
  repaint();

  // Helper: convert clientX/Y inside the wrap to 0..1 fractions, clamped.
  const wrapPoint = (e) => {
    const r = wrap.getBoundingClientRect();
    const u = (e.clientX - r.left) / Math.max(1, r.width);
    const v = (e.clientY - r.top) / Math.max(1, r.height);
    return {
      u: Math.max(0, Math.min(1, u)),
      v: Math.max(0, Math.min(1, v)),
    };
  };

  let dragKind = null;          // "body" | "nw" | "ne" | "sw" | "se" | null
  let dragStart = null;         // { u, v }
  let areaStart = null;         // copy of state.area at drag start
  let activePointerId = null;

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const handleEl = e.target.closest?.("[data-handle]");
    if (handleEl) {
      dragKind = handleEl.dataset.handle;
    } else if (e.target.closest?.("[data-role=hitzone-rect]")) {
      dragKind = "body";
    } else {
      // Click outside rect on the wrap → start drawing a fresh rect from here.
      const p = wrapPoint(e);
      state.area = { x: p.u, y: p.v, w: 0.001, h: 0.001 };
      dragKind = "se";
      areaStart = { ...state.area };
      dragStart = p;
      activePointerId = e.pointerId;
      wrap.setPointerCapture?.(e.pointerId);
      repaint();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    dragStart = wrapPoint(e);
    areaStart = { ...state.area };
    activePointerId = e.pointerId;
    wrap.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const MIN_SIZE = 0.05;

  const onPointerMove = (e) => {
    if (activePointerId !== e.pointerId || !dragKind) return;
    const p = wrapPoint(e);
    const du = p.u - dragStart.u;
    const dv = p.v - dragStart.v;
    let { x, y, w, h } = areaStart;
    if (dragKind === "body") {
      x = Math.max(0, Math.min(1 - w, x + du));
      y = Math.max(0, Math.min(1 - h, y + dv));
    } else {
      // Resize from a corner. Update two edges depending on which corner.
      let left = x, top = y, right = x + w, bottom = y + h;
      if (dragKind.includes("w")) left = Math.max(0, Math.min(right - MIN_SIZE, x + du));
      if (dragKind.includes("e")) right = Math.max(left + MIN_SIZE, Math.min(1, x + w + du));
      if (dragKind.includes("n")) top = Math.max(0, Math.min(bottom - MIN_SIZE, y + dv));
      if (dragKind.includes("s")) bottom = Math.max(top + MIN_SIZE, Math.min(1, y + h + dv));
      x = left; y = top; w = right - left; h = bottom - top;
    }
    state.area = { x, y, w, h };
    repaint();
  };

  const onPointerUp = (e) => {
    if (activePointerId !== e.pointerId) return;
    activePointerId = null;
    dragKind = null;
    wrap.releasePointerCapture?.(e.pointerId);
  };

  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointermove", onPointerMove);
  wrap.addEventListener("pointerup", onPointerUp);
  wrap.addEventListener("pointercancel", onPointerUp);

  resetBtn?.addEventListener("click", () => {
    state.area = { x: 0, y: 0, w: 1, h: 1 };
    repaint();
  });
}
