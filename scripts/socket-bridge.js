// Tiny request/reply socket bridge so non-GM players can ask the active GM
// to perform privileged ops (touching the merchant Loot actor). Foundry by
// default refuses player updates on actors they don't own, so without this
// every Buy/Sell would fail with "lacks permission to update Item ...".

import { MODULE_ID } from "./merchant-store.js";

const SOCKET = `module.${MODULE_ID}`;
const _pending = new Map(); // reqId -> { resolve, reject, timer }
const _handlers = {};       // type -> async (payload) => result

export function registerSocketBridge() {
  if (!game.socket) return;
  game.socket.on(SOCKET, _onMessage);
}

export function registerHandler(type, fn) {
  _handlers[type] = fn;
}

/**
 * Fire a request that should run on the active GM. If the caller is GM, the
 * handler runs locally without touching the socket so single-player GM use
 * still works.
 */
export async function callGM(type, payload = {}, timeoutMs = 10000) {
  const fn = _handlers[type];
  if (game.user.isGM) {
    if (typeof fn !== "function") throw new Error(`Unknown op: ${type}`);
    return await fn(payload);
  }
  if (!game.users?.activeGM) {
    throw new Error(game.i18n?.localize?.("PF2E_CINEMATIC_MERCHANT.warn.noGM") ?? "No active GM");
  }
  return new Promise((resolve, reject) => {
    const reqId = foundry.utils.randomID();
    const timer = setTimeout(() => {
      _pending.delete(reqId);
      reject(new Error("GM relay timeout"));
    }, timeoutMs);
    _pending.set(reqId, { resolve, reject, timer });
    game.socket.emit(SOCKET, { type, payload, reqId });
  });
}

async function _onMessage(msg) {
  if (!msg) return;

  // Reply path — caller waiting for this reqId
  if (msg.kind === "reply") {
    const h = _pending.get(msg.reqId);
    if (!h) return;
    clearTimeout(h.timer);
    _pending.delete(msg.reqId);
    if (msg.error) h.reject(new Error(msg.error));
    else h.resolve(msg.result);
    return;
  }

  // Request path — only the active GM handles it (avoid duplicate handling
  // when multiple GMs are connected).
  if (!game.user.isGM) return;
  const activeGM = game.users?.activeGM;
  if (activeGM && game.user.id !== activeGM.id) return;

  const handler = _handlers[msg.type];
  let result = null;
  let error = null;
  try {
    if (typeof handler !== "function") throw new Error(`Unknown op: ${msg.type}`);
    result = await handler(msg.payload ?? {});
  } catch (err) {
    error = err?.message ?? String(err);
    console.warn(`${MODULE_ID} | socket op '${msg.type}' failed:`, err);
  }
  if (msg.reqId) {
    game.socket.emit(SOCKET, { kind: "reply", reqId: msg.reqId, result, error });
  }
}
