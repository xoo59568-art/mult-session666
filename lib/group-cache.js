// lib/group-cache.js
// Minimal per-session group metadata cache, bounded and TTL'd.
// Stores only: id, subject, description, owner, adminIds, participantsCount, createdAt, lastUpdatedAt, isBotAdmin (when conn provided).

import { LRUCache } from "lru-cache";
import { jidNormalizedUser } from "@whiskeysockets/baileys";

/* ---------- CONFIG (tune via env) ---------- */
const GLOBAL_MAX_SESSIONS = Number(process.env.GROUPCACHE_MAX_SESSIONS) || 50;
const PER_SESSION_MAX_GROUPS = Number(process.env.GROUPCACHE_MAX_GROUPS) || 1000;
const PER_GROUP_TTL_MS = Number(process.env.GROUPCACHE_GROUP_TTL_MS) || 1000 * 60 * 60 * 24; // 24h
const PREFETCH_GROUPS_LIMIT = Number(process.env.GROUPCACHE_PREFETCH_LIMIT) || 300;
const PRUNE_INTERVAL_MS = 1000 * 60 * 5; // background prune every 5m

/* ---------- helpers ---------- */
function safeNorm(j) {
  try {
    return jidNormalizedUser(String(j));
  } catch {
    return String(j || "");
  }
}
function estimateSizeBytes(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj || {}), "utf8");
  } catch {
    return 128;
  }
}
function compactFromRaw(mdRaw = {}, conn = null) {
  // mdRaw typically from conn.groupMetadata(jid)
  const id = mdRaw.id || mdRaw.jid || mdRaw?.id || null;
  const subject = mdRaw.subject || mdRaw.name || "";
  const description = mdRaw.desc || mdRaw.description || "";
  const owner = mdRaw.owner ? safeNorm(mdRaw.owner) : null;
  // participants: extract admin ids if any
  let adminIds = [];
  try {
    const parts = mdRaw.participants || [];
    for (const p of parts) {
      // p may be string or object with id/admin/isAdmin/admin === 'admin'
      const pid = typeof p === "string" ? p : (p?.id || p?.jid || null);
      if (!pid) continue;
      const isAdmin = !!(typeof p === "object" && (p.admin === true || p.isAdmin === true || p.admin === "admin"));
      if (isAdmin) adminIds.push(safeNorm(pid));
    }
    // dedupe
    adminIds = Array.from(new Set(adminIds));
  } catch {
    adminIds = [];
  }
  const participantsCount = (mdRaw.participants && mdRaw.participants.length) || mdRaw.size || 0;

  // compute isBotAdmin if conn provided
  let isBotAdmin = false;
  try {
    if (conn && conn.user && conn.user.id) {
      const botJ = safeNorm(conn.user.id);
      isBotAdmin = adminIds.some((a) => a === botJ);
    }
  } catch { isBotAdmin = false; }

  const now = Date.now();
  const out = {
    id,
    subject,
    description,
    owner,
    adminIds,
    participantsCount,
    isBotAdmin,
    createdAt: mdRaw.createdAt || now,
    lastUpdatedAt: now,
  };
  out._size = Math.max(estimateSizeBytes(out), 128);
  return out;
}

/* ---------- LRU storage ---------- */
// global sessions LRU; each entry holds a `groups` LRU and inflight map
const sessions = new LRUCache({
  max: GLOBAL_MAX_SESSIONS,
  ttlAutopurge: true,
});

function _ensureSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  let s = sessions.get(sessionId);
  if (s) return s;
  const groups = new LRUCache({
    max: PER_SESSION_MAX_GROUPS,
    ttl: PER_GROUP_TTL_MS,
    ttlAutopurge: true,
  });
  s = { groups, inflight: new Map(), _size: 1 };
  sessions.set(sessionId, s);
  return s;
}
function _recalcSessionSize(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  let total = 0;
  s.groups.forEach((v) => { total += (v && v._size) ? v._size : 128; });
  s._size = Math.max(total, 1);
  sessions.set(sessionId, s);
}

/* ---------- API (session-first) ---------- */
export function getCached(sessionId, jid) {
  const s = _ensureSession(sessionId);
  return s.groups.get(jid) || null;
}

export function setCached(sessionId, jid, metadata) {
  if (!sessionId || !jid || !metadata) return;
  const s = _ensureSession(sessionId);
  // keep the metadata compact and deterministic
  const compact = {
    id: metadata.id || jid,
    subject: metadata.subject || metadata.name || "",
    description: metadata.description || metadata.desc || "",
    owner: metadata.owner ? safeNorm(metadata.owner) : (metadata.owner || null),
    adminIds: Array.isArray(metadata.adminIds) ? Array.from(new Set(metadata.adminIds.map(safeNorm))) : [],
    participantsCount: metadata.participantsCount || metadata.participants?.length || 0,
    isBotAdmin: !!metadata.isBotAdmin,
    createdAt: metadata.createdAt || Date.now(),
    lastUpdatedAt: Date.now(),
  };
  compact._size = Math.max(estimateSizeBytes(compact), 128);
  s.groups.set(jid, compact);
  _recalcSessionSize(sessionId);
}

export function deleteCached(sessionId, jid) {
  if (!sessionId) return;
  const s = _ensureSession(sessionId);
  s.groups.delete(jid);
  s.inflight.delete(jid);
  _recalcSessionSize(sessionId);
}

export function listCachedJids(sessionId) {
  const s = _ensureSession(sessionId);
  return Array.from(s.groups.keys());
}

/**
 * Fetch group metadata with inflight dedupe for a session.
 * signature: getGroupMetadata(sessionId, conn, jid)
 * - conn optional only for computing isBotAdmin at fetch time; if absent, saved value may have outdated isBotAdmin.
 */
export async function getGroupMetadata(sessionId, conn, jid) {
  if (!sessionId) throw new Error("sessionId required");
  if (!jid) throw new Error("jid required");
  const s = _ensureSession(sessionId);
  const cached = s.groups.get(jid);
  // if present and fresh per LRU/TTL, return it
  if (cached) {
    // if conn present and bot admin might be stale, recompute isBotAdmin cheaply
    if (conn && conn.user && conn.user.id) {
      try {
        const botJ = safeNorm(conn.user.id);
        const isBotAdmin = (cached.adminIds || []).some(a => a === botJ);
        if (cached.isBotAdmin !== isBotAdmin) {
          const patched = { ...cached, isBotAdmin, lastUpdatedAt: Date.now() };
          patched._size = Math.max(estimateSizeBytes(patched), 128);
          s.groups.set(jid, patched);
          _recalcSessionSize(sessionId);
          return patched;
        }
      } catch { /* ignore */ }
    }
    return cached;
  }
  // inflight dedupe
  if (s.inflight.has(jid)) return s.inflight.get(jid);
  const p = (async () => {
    try {
      // fetch from server
      if (!conn || typeof conn.groupMetadata !== "function") {
        // can't fetch; create minimal stub
        const stub = { id: jid, subject: "", description: "", owner: null, adminIds: [], participantsCount: 0, isBotAdmin: false, createdAt: Date.now(), lastUpdatedAt: Date.now() };
        stub._size = Math.max(estimateSizeBytes(stub), 128);
        s.groups.set(jid, stub);
        _recalcSessionSize(sessionId);
        return s.groups.get(jid);
      }
      const mdRaw = await conn.groupMetadata(jid);
      const compact = compactFromRaw(mdRaw || {}, conn);
      s.groups.set(jid, compact);
      _recalcSessionSize(sessionId);
      return s.groups.get(jid);
    } catch (err) {
      // on error, keep inflight cleared and rethrow
      throw err;
    } finally {
      s.inflight.delete(jid);
    }
  })();
  s.inflight.set(jid, p);
  return p;
}

/**
 * updateCached: merge partial updates (subject, description, participants)
 * keep small shape
 */
export function updateCached(sessionId, jid, updateObj) {
  if (!sessionId || !jid || !updateObj) return;
  const s = _ensureSession(sessionId);
  const cached = s.groups.get(jid) || { id: jid, subject: "", description: "", owner: null, adminIds: [], participantsCount: 0, isBotAdmin: false, createdAt: Date.now(), lastUpdatedAt: Date.now() };
  const merged = { ...cached, ...updateObj, lastUpdatedAt: Date.now() };
  // if participants present, recompute adminIds and participantsCount
  if (Array.isArray(updateObj.participants)) {
    const ids = [];
    for (const p of updateObj.participants) {
      try {
        const pid = typeof p === "string" ? p : (p.id || p.jid || null);
        if (!pid) continue;
        const isAdmin = !!(typeof p === "object" && (p.admin === true || p.isAdmin === true || p.admin === "admin"));
        if (isAdmin) ids.push(safeNorm(pid));
      } catch {}
    }
    merged.adminIds = Array.from(new Set([...(merged.adminIds || []), ...ids]));
    merged.participantsCount = updateObj.participants.length || merged.participantsCount;
  }
  merged._size = Math.max(estimateSizeBytes(merged), 128);
  s.groups.set(jid, merged);
  _recalcSessionSize(sessionId);
}

/**
 * Prefetch participating groups (bounded to PREFETCH_GROUPS_LIMIT)
 * returns number loaded
 */
export async function prefetchAllParticipating(sessionId, conn) {
  if (!conn || typeof conn.groupFetchAllParticipating !== "function") return 0;
  const s = _ensureSession(sessionId);
  try {
    const all = await conn.groupFetchAllParticipating();
    let count = 0;
    for (const [jid, md] of Object.entries(all || {})) {
      if (count >= PREFETCH_GROUPS_LIMIT) break;
      if (!md) continue;
      const compact = compactFromRaw(md, conn);
      s.groups.set(jid, compact);
      count++;
    }
    _recalcSessionSize(sessionId);
    return count;
  } catch (err) {
    return 0;
  }
}

/* ---------- lifecycle helpers ---------- */
export function deleteSession(sessionId) {
  if (!sessionId) return;
  sessions.delete(sessionId);
}
export function listSessions() {
  return Array.from(sessions.keys());
}

/* ---------- convenience bound API ---------- */
export function forSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  return {
    getCached: (jid) => getCached(sessionId, jid),
    setCached: (jid, md) => setCached(sessionId, jid, md),
    deleteCached: (jid) => deleteCached(sessionId, jid),
    listCachedJids: () => listCachedJids(sessionId),
    getGroupMetadata: (conn, jid) => getGroupMetadata(sessionId, conn, jid),
    updateCached: (jid, obj) => updateCached(sessionId, jid, obj),
    prefetchAllParticipating: (conn) => prefetchAllParticipating(sessionId, conn),
    deleteSession: () => deleteSession(sessionId),
    listSessions: () => listSessions(),
  };
}

/* ---------- background maintenance ---------- */
setInterval(() => {
  try {
    sessions.forEach((s, sid) => {
      try { if (s?.groups?.purge) s.groups.purge(); } catch {}
      _recalcSessionSize(sid);
    });
  } catch {}
}, PRUNE_INTERVAL_MS);

/* ---------- diagnostics ---------- */
export function stats() {
  const out = { totalSessions: sessions.size, sessions: [] };
  sessions.forEach((s, sid) => {
    out.sessions.push({ sessionId: sid, groups: s.groups.size, approxBytes: s._size });
  });
  return out;
}