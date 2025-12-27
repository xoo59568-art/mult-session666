// lib/sessionManager.js
import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import EventEmitter from "events";

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.queue.length) this.queue.shift()();
  }
}

export default class SessionManager extends EventEmitter {
  /**
   * opts:
   *  - createSocket: async function(sessionId) => sock (required)
   *  - sessionsDir: path to store session auth folders (optional)
   *  - metaFile: path to persist session ids (optional)
   *  - concurrency: number (optional)
   *  - startDelayMs: number (optional)
   */
  constructor(opts = {}) {
    super();
    if (!opts.createSocket) throw new Error("createSocket option required");
    this.createSocket = opts.createSocket;
    this.sessions = new Map(); // sessionId => { sock, backoffMs, restarting, status, reconnectTimer, deleted }
    // make paths absolute to avoid CWD surprises
    this.sessionsDir = path.resolve(
      opts.sessionsDir || path.join(process.cwd(), "sessions")
    );
    this.metaFile = path.resolve(
      opts.metaFile || path.join(process.cwd(), "sessions.json")
    );
    this.concurrency = opts.concurrency || 10;
    this.semaphore = new Semaphore(this.concurrency);
    this.startDelayMs = opts.startDelayMs ?? 200;
    this.defaultBackoff = opts.defaultBackoff || 1000;
    this.maxBackoff = opts.maxBackoff || 60_000;

    // try to synchronously load meta on startup to avoid race with register()
    try {
      this._loadMetaSync();
      this.ready = Promise.resolve();
    } catch (e) {
      console.warn(
        "session manager: sync meta load failed, falling back to async:",
        e?.message || e
      );
      this.ready = this._loadMeta().catch((e2) =>
        console.warn("session manager: failed to load meta", e2?.message || e2)
      );
    }
  }

  // ----- robust synchronous loader (used at startup) -----
  _loadMetaSync() {
    try {
      try {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      } catch (e) {}
      let raw;
      try {
        raw = fs.readFileSync(this.metaFile, "utf-8");
      } catch (e) {
        if (e?.code === "ENOENT") raw = "[]";
        else throw e;
      }
      let list;
      try {
        list = JSON.parse(raw || "[]");
      } catch (e) {
        console.warn(
          "session manager: invalid meta JSON, ignoring (sync)",
          e?.message || e
        );
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of list) {
        if (!this.sessions.has(id)) {
          this.sessions.set(id, {
            sock: null,
            backoffMs: this.defaultBackoff,
            restarting: false,
            status: "stopped",
            reconnectTimer: null,
            deleted: false,
          });
        }
      }
      try {
        this._persistMetaSync();
      } catch (e) {
        // try async persist if sync persist fails
        this._persistMeta().catch(() => {});
      }
    } catch (e) {
      throw e;
    }
  }

  // ----- async loader fallback -----
  async _loadMeta() {
    try {
      await fsPromises.mkdir(this.sessionsDir, { recursive: true });
      const raw = await fsPromises
        .readFile(this.metaFile, "utf-8")
        .catch((e) => {
          if (e?.code === "ENOENT") return "[]";
          throw e;
        });
      let list;
      try {
        list = JSON.parse(raw || "[]");
      } catch (e) {
        console.warn(
          "session manager: invalid meta JSON, ignoring",
          e?.message || e
        );
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of list) {
        if (!this.sessions.has(id)) {
          this.sessions.set(id, {
            sock: null,
            backoffMs: this.defaultBackoff,
            restarting: false,
            status: "stopped",
            reconnectTimer: null,
            deleted: false,
          });
        }
      }
      await this._persistMeta().catch(() => {});
    } catch (e) {
      if (e?.code !== "ENOENT")
        console.warn("meta load error", e?.message || e);
    }
  }

  // ----- async, atomic persist with small retry logic -----
  async _persistMeta() {
    try {
      const dir = path.dirname(this.metaFile);
      await fsPromises.mkdir(dir, { recursive: true });
      const list = Array.from(this.sessions.keys());
      const tmp = `${this.metaFile}.tmp`;

      // write tmp
      await fsPromises.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");

      // ensure tmp exists then try rename with a few retries
      let attempts = 0;
      while (attempts < 4) {
        try {
          // confirm tmp exists before rename
          await fsPromises.stat(tmp);
          await fsPromises.rename(tmp, this.metaFile);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 4) {
            throw err;
          }
          // if tmp disappeared, rewrite it and retry
          if (err?.code === "ENOENT") {
            try {
              await fsPromises.writeFile(
                tmp,
                JSON.stringify(list, null, 2),
                "utf-8"
              );
            } catch (writeErr) {
              // if we can't rewrite, wait and retry
            }
          }
          // small backoff before retry
          await new Promise((r) => setTimeout(r, 50 * attempts));
        }
      }

      // best-effort fsync on directory
      try {
        const dirFd = fs.openSync(dir, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch (e) {
        // ignore — some envs restrict fsync
      }
      this.emit("meta.updated", list);
    } catch (e) {
      console.warn("meta persist error", e?.message || e);
    }
  }

  // ----- synchronous, atomic persist with defensive checks -----
  _persistMetaSync() {
    try {
      const dir = path.dirname(this.metaFile);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
      const list = Array.from(this.sessions.keys());
      const tmp = `${this.metaFile}.tmp`;
      // write temp file synchronously then rename (with retries)
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");

      let attempts = 0;
      while (attempts < 4) {
        try {
          if (!fs.existsSync(tmp)) {
            // try to write again
            fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
          }
          fs.renameSync(tmp, this.metaFile);
          break;
        } catch (e) {
          attempts++;
          if (attempts >= 4) {
            throw e;
          }
          // brief pause (sync sleep via blocking loop is nasty — use small JS delay via Atomics if necessary,
          // but to keep this sync we just attempt several times quickly)
        }
      }

      try {
        const dirFd = fs.openSync(dir, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch (e) {}
      this.emit("meta.updated", list);
    } catch (e) {
      // fallback to async attempt if sync fails
      try {
        this._persistMeta().catch(() => {});
      } catch (_) {}
      console.warn("meta persist sync error", e?.message || e);
    }
  }

  /**
   * register(sessionId)
   * - Synchronous API for backwards compatibility: ensures meta is persisted before return.
   * - This prevents race where caller does not await and process restarts immediately.
   */
  register(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sock: null,
        backoffMs: this.defaultBackoff,
        restarting: false,
        status: "stopped",
        reconnectTimer: null,
        deleted: false,
      });
    } else {
      // if previously marked deleted, unmark when explicitly registering
      const entry = this.sessions.get(sessionId);
      if (entry.deleted) entry.deleted = false;
    }
    // Persist synchronously to guarantee on-disk presence immediately
    this._persistMetaSync();
  }

  /**
   * unregister(sessionId) - synchronous (persists immediately)
   */
  unregister(sessionId) {
    if (this.sessions.has(sessionId)) {
      const entry = this.sessions.get(sessionId);
      // cancel any pending reconnect timer
      if (entry?.reconnectTimer) {
        try {
          clearTimeout(entry.reconnectTimer);
        } catch {}
        entry.reconnectTimer = null;
      }
      this.sessions.delete(sessionId);
      this._persistMetaSync();
    }
  }

  async start(sessionId) {
    // wait for initial meta load
    if (this.ready) await this.ready;

    // if the session was previously deleted and caller calls start,
    // allow register to recreate it (this is expected when user re-registers).
    this.register(sessionId);

    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("failed to register session");

    // If entry is marked deleted (some races), don't start
    if (entry.deleted) {
      throw new Error("session marked deleted; won't start");
    }

    if (entry.sock) return entry.sock; // already running
    await this.semaphore.acquire();
    try {
      entry.status = "starting";
      const sock = await this.createSocket(sessionId);
      entry.sock = sock;
      entry.status = "connected";
      entry.restarting = false;
      entry.backoffMs = this.defaultBackoff;
      // clear any reconnect timer if present
      if (entry.reconnectTimer) {
        try {
          clearTimeout(entry.reconnectTimer);
        } catch {}
        entry.reconnectTimer = null;
      }
      // minimal event forwarding
      sock.ev.on("messages.upsert", (m) =>
        this.emit("messages.upsert", sessionId, m)
      );
      sock.ev.on("groups.update", (u) =>
        this.emit("groups.update", sessionId, u)
      );
      sock.ev.on("group-participants.update", (u) =>
        this.emit("group-participants.update", sessionId, u)
      );
      sock.ev.on("creds.update", (u) =>
        this.emit("creds.update", sessionId, u)
      );
      sock.ev.on("connection.update", (update) =>
        this._handleConnectionUpdate(sessionId, update)
      );
      // persist meta async (we already did sync on register, but persist again to be safe)
      this._persistMeta().catch(() => {});
      this.sessions.set(sessionId, entry);
      return sock;
    } finally {
      // small stagger to avoid bursts
      await new Promise((r) => setTimeout(r, this.startDelayMs));
      this.semaphore.release();
    }
  }

  async startAll() {
    if (this.ready) await this.ready;
    const keys = Array.from(this.sessions.keys());
    const concurrency = this.concurrency;
    for (let i = 0; i < keys.length; i += concurrency) {
      const chunk = keys.slice(i, i + concurrency).map((sid) =>
        this.start(sid).catch((e) => {
          console.warn("startAll chunk error", sid, e?.message || e);
        })
      );
      await Promise.all(chunk);
    }
  }

  async stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.sock) return false;
    try {
      entry.status = "stopping";
      try {
        if (typeof entry.sock.logout === "function") {
          await entry.sock.logout();
        } else if (entry.sock.ws) {
          entry.sock.ws.close();
        }
      } catch (e) {
        // ignore
      }
    } finally {
      entry.sock = null;
      entry.status = "stopped";
      this.sessions.set(sessionId, entry);
    }
    return true;
  }

  async logout(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    try {
      if (entry.sock && typeof entry.sock.logout === "function") {
        await entry.sock.logout();
      } else if (entry.sock && entry.sock.ws) {
        try {
          entry.sock.ws.close();
        } catch {}
      }
    } catch (e) {
      console.warn("logout sock err", e?.message || e);
    }

    // cancel any pending reconnect timer
    if (entry.reconnectTimer) {
      try {
        clearTimeout(entry.reconnectTimer);
      } catch {}
      entry.reconnectTimer = null;
    }

    // remove auth folder if exists
    const sessionPath = path.join(this.sessionsDir, sessionId);
    try {
      await fsPromises.rm(sessionPath, { recursive: true, force: true });
    } catch (e) {}
    // mark deleted and delete from in-memory map
    entry.deleted = true;
    entry.sock = null;
    entry.restarting = false;
    this.sessions.delete(sessionId);
    // persist (async ok)
    await this._persistMeta();
    this.emit("loggedOut", sessionId);
    return true;
  }

  isRunning(sessionId) {
    const entry = this.sessions.get(sessionId);
    return !!(entry && entry.sock);
  }

  list() {
    const out = [];
    for (const [k, v] of this.sessions.entries()) {
      out.push({ sessionId: k, status: v.status, backoffMs: v.backoffMs });
    }
    return out;
  }

  async _handleConnectionUpdate(sessionId, update) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const { connection, lastDisconnect } = update;
    //  if (qr) this.emit("qr", sessionId, qr);
    this.emit("connection.update", sessionId, update);

    if (connection === "open") {
      entry.status = "connected";
      entry.backoffMs = this.defaultBackoff;
      entry.restarting = false;
      this.sessions.set(sessionId, entry);
      // ensure saved on disk when socket actually opened
      await this._persistMeta().catch(() => {});
      this.emit("connected", sessionId);
      return;
    }

    if (connection === "close") {
      // try to infer permanent logout
      let statusCode = lastDisconnect?.error?.output?.statusCode;
      let payloadReason = lastDisconnect?.error?.output?.payload?.reason;
      const reasonStr = String(statusCode || payloadReason || "").toLowerCase();
      console.log(statusCode, payloadReason, reasonStr);
      const isLoggedOut =
        statusCode === 401 ||
        403 ||
        reasonStr.includes("loggedout") ||
        reasonStr.includes("logout") ||
        reasonStr.includes("forbidden");

      if (isLoggedOut) {
        // Cancel any scheduled reconnects and delete auth dir + session
        try {
          if (entry.reconnectTimer) {
            try {
              clearTimeout(entry.reconnectTimer);
            } catch {}
            entry.reconnectTimer = null;
          }
          entry.sock = null;
          entry.restarting = false;
          const sessionPath = path.join(this.sessionsDir, sessionId);
          await fsPromises.rm(sessionPath, { recursive: true, force: true });
        } catch (e) {}
        // remove from map and persist
        this.sessions.delete(sessionId);
        await this._persistMeta().catch(() => {});
        this.emit("session.deleted", sessionId, {
          reason: payloadReason || statusCode,
        });
        return;
      }

      // transient -> attempt reconnect with exponential backoff
      if (!entry.restarting) {
        entry.restarting = true;
        entry.sock = null;
        entry.status = "reconnecting";
        const backoff = entry.backoffMs || this.defaultBackoff;
        // schedule reconnect and store timer id so it can be cancelled
        const timer = setTimeout(async () => {
          try {
            // if session removed meanwhile, do not attempt start
            if (!this.sessions.has(sessionId)) return;
            entry.restarting = false;
            entry.backoffMs = Math.min(
              (entry.backoffMs || this.defaultBackoff) * 2,
              this.maxBackoff
            );
            // ensure we updated backoff on the stored entry
            const cur = this.sessions.get(sessionId);
            if (cur) cur.backoffMs = entry.backoffMs;
            await this.start(sessionId);
          } catch (e) {
            console.warn(`[${sessionId}] reconnect failed`, e?.message || e);
            const cur = this.sessions.get(sessionId);
            if (cur) cur.restarting = false;
          }
        }, backoff);
        entry.reconnectTimer = timer;
        this.sessions.set(sessionId, entry);
      }
    }
  }
}
