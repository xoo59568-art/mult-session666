// lib/group-cache.js
// ESM - Per-session in-memory group metadata cache with inflight dedupe.
// Each sessionId gets its own { groups: Map, inflight: Map } store.

const sessions = new Map(); // sessionId -> { groups: Map, inflight: Map }

/** Ensure session container exists and return it. */
function _ensureSession(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      groups: new Map(),    // jid -> GroupMetadata
      inflight: new Map(),  // jid -> Promise<GroupMetadata>
    });
  }
  return sessions.get(sessionId);
}

/**
 * Normalize participants to a consistent shape:
 * Accepts array of strings or objects and returns [{ id: string, isAdmin: boolean }, ...]
 */
export function normalizeParticipants(participants = []) {
  return (participants || [])
    .map((p) => {
      if (!p) return null;
      const id = typeof p === "string" ? p : (p.id || p.jid || p);
      if (!id) return null;
      // normalize admin flags to boolean isAdmin
      const isAdmin = !!(
        typeof p === "object" &&
        (p.admin === true || p.isAdmin === true || p.admin === "admin")
      );
      return { id, isAdmin };
    })
    .filter(Boolean);
}

/* ---------------- Session-scoped API (sessionId required) ---------------- */

export function getCached(sessionId, jid) {
  const s = _ensureSession(sessionId);
  return s.groups.get(jid);
}

export function setCached(sessionId, jid, metadata) {
  if (!sessionId || !jid || !metadata) return;
  const s = _ensureSession(sessionId);
  const meta = { ...metadata };
  meta.participants = Array.isArray(meta.participants)
    ? normalizeParticipants(meta.participants)
    : [];
  s.groups.set(jid, meta);
}

export function deleteCached(sessionId, jid) {
  if (!sessionId) return;
  const s = _ensureSession(sessionId);
  s.groups.delete(jid);
  s.inflight.delete(jid);
}

export function listCachedJids(sessionId) {
  const s = _ensureSession(sessionId);
  return Array.from(s.groups.keys());
}

/**
 * Fetch group metadata with inflight dedupe for a session.
 * getGroupMetadata(sessionId, conn, jid)
 */
export async function getGroupMetadata(sessionId, conn, jid) {
  if (!sessionId) throw new Error("sessionId required");
  if (!jid) throw new Error("jid required");
  const s = _ensureSession(sessionId);

  const cached = s.groups.get(jid);
  if (cached) return cached;
  if (s.inflight.has(jid)) return s.inflight.get(jid);

  const p = (async () => {
    try {
      const md = await conn.groupMetadata(jid);
      const normalized = md && Array.isArray(md.participants)
        ? { ...md, participants: normalizeParticipants(md.participants) }
        : { ...md, participants: md?.participants ? normalizeParticipants(md.participants) : [] };
      s.groups.set(jid, normalized || { id: jid, participants: [] });
      return s.groups.get(jid);
    } catch (err) {
      // rethrow error to caller; inflight will be cleared in finally
      throw err;
    } finally {
      s.inflight.delete(jid);
    }
  })();

  s.inflight.set(jid, p);
  return p;
}

/**
 * Merge/overwrite updates into cached metadata for a session.
 * updateObj can contain partial fields (subject, desc, participants)
 */
export function updateCached(sessionId, jid, updateObj) {
  if (!sessionId || !jid || !updateObj) return;
  const s = _ensureSession(sessionId);
  const cached = s.groups.get(jid) || { id: jid, participants: [] };
  const merged = { ...cached, ...updateObj };

  if (Array.isArray(updateObj.participants)) {
    const existing = normalizeParticipants(cached.participants || []);
    const incoming = normalizeParticipants(updateObj.participants || []);
    const map = new Map();
    for (const p of existing) map.set(p.id, { ...p });
    for (const p of incoming) {
      const prev = map.get(p.id) || {};
      map.set(p.id, { ...prev, ...p });
    }
    merged.participants = Array.from(map.values());
  } else {
    merged.participants = Array.isArray(merged.participants)
      ? normalizeParticipants(merged.participants)
      : normalizeParticipants(cached.participants || []);
  }

  s.groups.set(jid, merged);
}

/**
 * Prefetch all groups this connection participates in for the session.
 * Returns number of groups cached. Best-effort; errors are swallowed.
 */
export async function prefetchAllParticipating(sessionId, conn) {
  if (!conn || typeof conn.groupFetchAllParticipating !== "function") return 0;
  const s = _ensureSession(sessionId);
  try {
    const all = await conn.groupFetchAllParticipating();
    let count = 0;
    for (const [jid, md] of Object.entries(all || {})) {
      if (!md) continue;
      md.participants = Array.isArray(md.participants) ? normalizeParticipants(md.participants) : [];
      s.groups.set(jid, md);
      count++;
    }
    return count;
  } catch (err) {
    // don't crash; just log and return 0
    // console.error("prefetchAllParticipating failed:", err?.message ?? err);
    return 0;
  }
}

/* ---------------- Session lifecycle helpers ---------------- */

export function deleteSession(sessionId) {
  if (!sessionId) return;
  sessions.delete(sessionId);
}

export function listSessions() {
  return Array.from(sessions.keys());
}

/* ---------------- Convenience: bound API for a given sessionId ---------------- */

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