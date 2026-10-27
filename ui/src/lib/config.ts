// Backend location, from build-time env (see ui/.env.example). Empty = same origin (dev/preview proxy).
const env = import.meta.env;
export const API_BASE = String(env.VITE_API_BASE ?? "").replace(/\/$/, "");
const wsFromBase = () => {
  if (API_BASE) return API_BASE.replace(/^http/, "ws") + "/events";
  if (typeof location === "undefined") return "";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/events`;
};
export const WS_URL = String(env.VITE_WS_URL || "") || wsFromBase();
/** Replay pacing: gaps between recorded events are capped (same as the server's replay) */
export const REPLAY_MAX_GAP_MS = 1500;
