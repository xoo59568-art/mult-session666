// lib/index.js (patched: guarded listeners, concurrency limit, no nested registration)
import pino from "pino";
import SessionManager from "./sessionManager.js";
import { createSocket } from "./createSocket.js";
import { ensurePlugins } from "./plugins.js";
import Serializer from "./serialize.js";
import config from "../config.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import WalDBFast from "./database/db-remote.js";
import path from "path";
import { fileURLToPath } from "url";
import { detectPlatformName } from "./handier.js";
import * as groupCache from "./group-cache.js"; // <-- per-session cache

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

function makeGiftQuote(pushname) {
  return {
    key: {
      fromMe: false,
      participant: `917439348758@s.whatsapp.net`,
      remoteJid: "status@broadcast",
    },
    message: {
      contactMessage: {
        displayName: pushname || "User",
        vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${pushname || "User"};;\nFN:${pushname || "User"
          }\nitem1.TEL;waid=917439348758:917439348758\nitem1.X-ABLabel:WhatsApp\nEND:VCARD`,
      },
    },
  };
}

// create DB first, then pass into SessionManager to avoid circular imports
export const db = new WalDBFast({ dir: "./data" });

// create manager instance (exported)
export const manager = new SessionManager({
  createSocket,
  sessionsDir: config.SESSION_ID || "./sessions",
  metaFile: config.META_FILE || "./data/sessions.json",
  concurrency: config.CONCURRENCY || 5,
  startDelayMs: config.START_DELAY_MS ?? 200,
  db,
});

/**
 * Simple in-process enqueue to limit plugin concurrency.
 * Tune PLUGIN_CONCURRENCY via env var; default 100.
 */
const PLUGIN_CONCURRENCY = Number(process.env.PLUGIN_CONCURRENCY) || 100;
let _active = 0;
const _queue = [];
function enqueueTask(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      try {
        _active++;
        const r = await fn();
        resolve(r);
      } catch (err) {
        reject(err);
      } finally {
        _active--;
        if (_queue.length > 0) {
          const next = _queue.shift();
          setImmediate(next);
        }
      }
    };
    if (_active < PLUGIN_CONCURRENCY) {
      setImmediate(run);
    } else {
      _queue.push(run);
    }
  });
}

// per-session connected handler
async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry || !entry.sock) return;
    const sock = entry.sock;

    // create per-session cache handle
    const sessionCache = groupCache.forSession(sessionId);

    // serializer - try to create instance
    try {
      entry.serializer = new Serializer(sock, sessionId);
    } catch (e) {
      try {
        entry.serializer = new Serializer();
      } catch (_) {
        entry.serializer = null;
      }
    }

    // ensure sock.sessionId is set (createSocket already sets, but keep idempotent)
    sock.sessionId = sessionId;
    const botjid = jidNormalizedUser(sock.user?.id || "");
    const botNumber = (botjid || "").split("@")[0];
    logger.info({ sessionId, botNumber }, `✅ Bot connected - ${botNumber}`);

    // OPTIONAL: prefetch participating groups only if explicitly enabled
    if (process.env.GROUPCACHE_PREFETCH === "true") {
      try {
        // only prefetch if cache empty to avoid eager loading thousands of groups
        const existing = sessionCache.listCachedJids ? sessionCache.listCachedJids() : [];
        if (!existing || existing.length === 0) {
          await sessionCache.prefetchAllParticipating(sock);
          logger.info({ sessionId }, "Prefetched participating groups (bounded)");
        }
      } catch (e) {
        logger.debug({ sessionId }, "prefetch failed", e?.message || e);
      }
    }

    // welcome message (only once)
    const login = db.get(sessionId, "login") ?? false;
    if (!login) {
      try {
        db.setHot(sessionId, "login", true);
        const version = "2.0.5";
        const mode = "public";
        const prefix = ".";
        const start_msg = `
        *╭━━━〔🍓FREE 𝗕𝗢𝗧 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃〕━━━✦*
        *┃🌱 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 : ${botNumber}*
        *┃👻 𝐏𝐑𝐄𝐅𝐈𝐗        : ${prefix}*
        *┃🔮 𝐌𝐎𝐃𝐄        : ${mode}*
        *┃☁️ 𝐏𝐋𝐀𝐓𝐅𝐎𝐑𝐌    : ${detectPlatformName({ emoji: true })}*
        *┃🍉 PLUGINS      : 196*
        *┃🎐 𝐕𝐄𝐑𝐒𝐈𝐎𝐍      : ${version}*
        *╰━━━━━━━━━━━━━━━━━━╯*
        
        *╭━━━〔🛠️ 𝗧𝗜𝗣𝗦〕━━━━✦*
        *┃✧ 𝐓𝐘𝐏𝐄 .menu 𝐓𝐎 𝐕𝐈𝐄𝐖 𝐀𝐋𝐋*
        *┃✧ 𝐈𝐍𝐂𝐋𝐔𝐃𝐄𝐒 𝐅𝐔𝐍, 𝐆𝐀𝐌𝐄, 𝐒𝐓𝐘𝐋𝐄*
        *╰━━━━━━━━━━━━━━━━━╯*
        
        *╭━━━〔📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧〕━━━✦*
        *┃🪀 𝐃𝐄𝐕𝐄𝐋𝐎𝐏𝐄𝐑 :* +917439348758
        *┃❤️‍🩹 𝐒𝐔𝐏𝐏𝐎𝐑𝐓    :* https://chat.whatsapp.com/CEi9oEVpDTz07WmGjVdilB
        *╰━━━━━━━━━━━━━━━━━╯*
        `;
        const targetJid = botjid;
        const quoted = makeGiftQuote("𝐒uɱꪸ๏η 𝐃ɛ̚𝐯'ʬ 合");
        await sock.sendMessage(
          targetJid,
          {
            text: start_msg,
            contextInfo: {
              mentionedJid: [targetJid],
              externalAdReply: {
                title: "𝐓𝐇𝐀𝐍𝐊𝐒 𝐅𝐎𝐑 𝐂𝐇𝐎𝐎𝐒𝐈𝐍𝐆 x-kira FREE BOT ☄",
                body: "",
                thumbnailUrl: "https://files.catbox.moe/h924w4.jpg",
                sourceUrl: "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
                mediaType: 1,
                renderLargerThumbnail: true,
              },
            },
          },
          { quoted }
        );
      } catch (error) {
        logger.debug({ sessionId, err: error?.message || error }, `🍉 Connecting to WhatsApp ${botNumber}`);
      }
    } else {
      logger.debug({ sessionId }, `🍉 Skipping welcome message for ${botNumber}`);
    }

    // optional group join (configurable)
    if (config.AUTO_JOIN && config.GROUP_LINK) {
      try {
        const inviteCode = config.GROUP_LINK.split("chat.whatsapp.com/")[1]?.split("?")[0];
        if (inviteCode) await sock.groupAcceptInvite(inviteCode).catch(() => null);
      } catch (e) {
        logger.debug({ sessionId }, "join group failed", e?.message || e);
      }
    }

    // anticall handler (unchanged)
    sock.ev.on("call", async (callData) => {
      try {
        const anticallData = db.get(sessionId, "anticall") || {};
        if (anticallData?.anticall !== "true") return;
        const calls = Array.isArray(callData) ? callData : [callData];
        for (const call of calls) {
          if (call.isOffer || call.status === "offer") {
            const from = call.from || call.chatId;
            await sock.sendMessage(from, { text: "Sorry, I do not accept calls" }).catch(() => { });
            if (sock.rejectCall) await sock.rejectCall(call.id, from).catch(() => { });
            else if (sock.updateCallStatus) await sock.updateCallStatus(call.id, "reject").catch(() => { });
            logger.info({ sessionId, from }, `Rejected call from ${from}`);
          }
        }
      } catch (err) {
        logger.error({ sessionId }, "call handler error", err?.message || err);
      }
    });

    /**
     * Attach the stateful socket listeners exactly once per socket.
     * This prevents duplicate listener leak (the major memory/CPU leak).
     */
    if (!sock._listenersAttached) {
      sock._listenersAttached = true;

      // groups.update (registered once per socket)
      sock.ev.on("groups.update", async (events) => {
        for (const ev of events || []) {
          try {
            const jid = ev.id;
            const cached = sessionCache.getCached(jid) || {};
            // merge/update cache using session-scoped API
            try {
              sessionCache.updateCached(jid, { ...cached, ...ev });
            } catch {}
            // best-effort refresh metadata from server (bounded)
            try {
              const md = await sock.groupMetadata(jid).catch(() => null);
              if (md) {
                try { sessionCache.setCached(jid, md); } catch {}
              }
            } catch (err) {
              logger.debug({ sessionId, jid }, `groups.update: failed refresh: ${err?.message || err}`);
            }
          } catch (err) {
            console.error(`[${sessionId}] Failed to update group ${ev?.id}:`, err?.message ?? err);
            try { sessionCache.deleteCached(ev?.id); } catch {}
          }
        }
      });

      // group-participants.update (registered once)
      sock.ev.on("group-participants.update", async (event) => {
        try {
          if (!event || !event.id) return;
          const jid = event.id;
          // baseline cached metadata for this session (try cache, else fetch)
          let cached = sessionCache.getCached(jid) || null;
          if (!cached) {
            try {
              cached = await sessionCache.getGroupMetadata(sock, jid).catch(() => ({ id: jid, participants: [] }));
            } catch {
              cached = { id: jid, participants: [] };
            }
          }
          const participantsArr = Array.isArray(cached.participants) ? cached.participants.slice() : [];
          const incomingIds = (event.participants || []).map(p => (typeof p === "string" ? p : (p.id || p.jid || ""))).filter(Boolean);
          const byId = new Map(participantsArr.map(p => [p.id, { ...p }]));
          if (event.action === "add") {
            for (const pid of incomingIds) {
              if (!byId.has(pid)) byId.set(pid, { id: pid, isAdmin: false });
            }
          } else if (event.action === "remove") {
            for (const pid of incomingIds) {
              byId.delete(pid);
            }
          } else if (event.action === "promote" || event.action === "demote") {
            const newIsAdmin = event.action === "promote";
            for (const pid of incomingIds) {
              const cur = byId.get(pid);
              if (cur) {
                cur.isAdmin = newIsAdmin;
                byId.set(pid, cur);
              } else {
                byId.set(pid, { id: pid, isAdmin: newIsAdmin });
              }
            }
          }

          const updatedParticipants = Array.from(byId.values());
          sessionCache.updateCached(jid, { ...cached, participants: updatedParticipants });

          // enrich event for plugins (groupMetadata from cache)
          const enrichedEvent = {
            ...event,
            id: jid,
            participants: incomingIds,
            groupMetadata: sessionCache.getCached(jid) || { subject: "", participants: updatedParticipants },
            groupName: (sessionCache.getCached(jid)?.subject) || "",
            groupSize: (sessionCache.getCached(jid)?.participants || []).length,
          };

          // call each plugin that registered for this event (use enqueueTask to throttle plugin concurrency)
          const plugs = ensurePlugins();
          const pluginList = Array.isArray(plugs.all) ? plugs.all : (plugs.all ? [plugs.all] : []);
          for (const plugin of pluginList) {
            if (!plugin || plugin.on !== "group-participants.update") continue;
            if (typeof plugin.exec !== "function") continue;
            // enqueue plugin execution so we don't run unlimited plugin tasks concurrently
            enqueueTask(async () => {
              try {
                await plugin.exec(null, enrichedEvent, sock);
              } catch (err) {
                console.error("plugin exec error (group-participants.update):", err);
              }
            }).catch((e) => {
              logger.debug({ sessionId }, "enqueueTask error (group-participants.update)", e?.message || e);
            });
          }
        } catch (err) {
          console.error("group-participants.update handler error:", err);
        }
      });

      // messages.upsert handler (registered once)
      sock.ev.on("messages.upsert", async (upsert) => {
        try {
          const { messages, type } = upsert || {};
          if (type !== "notify" || !messages?.length) return;
          const raw = messages[0];
          if (!raw?.message) return;
          let msg = null;
          try {
            if (entry?.serializer && typeof entry.serializer.serializeSync === "function") {
              msg = entry.serializer.serializeSync(raw);
            } else {
              // fallback to raw message
              msg = raw;
            }
          } catch (e) {
            logger?.warn?.({ sessionId }, "serialize failed", e?.message || e);
            msg = raw;
          }
          if (!msg) return;

          // synchronous fast reads from DB (use default false)
          const autoRead = typeof db !== "undefined" ? db.get(sessionId, "autoread", false) : false;
          const autoStatusSeen = typeof db !== "undefined" ? db.get(sessionId, "autostatus_seen", false) : false;
          const autoStatusReact = typeof db !== "undefined" ? db.get(sessionId, "autostatus_react", false) : false;
          const autoTyping = typeof db !== "undefined" ? db.get(sessionId, "autotyping", false) : false;
          const autorecord = typeof db !== "undefined" ? db.get(sessionId, "autorecord", false) : false;
          const autoReact = typeof db !== "undefined" ? db.get(sessionId, "autoreact", false) : false;

          // ================= AUTO READ =================
          if (autoRead === true) {
            try { await sock.readMessages([msg.key]); } catch {}
          }
          // ================= STATUS SEEN =================
          if (msg.from === "status@broadcast" && autoStatusSeen === true) {
            try { await sock.readMessages([msg.key]); } catch {}
          }
          // ================= STATUS REACT =================
          if (msg.from === "status@broadcast" && autoStatusReact === true) {
            try {
              const emojis = ["❤️", "🔥", "💯", "😍", "👀"];
              const emoji = emojis[Math.floor(Math.random() * emojis.length)];
              await sock.sendMessage(msg.from, { react: { text: emoji, key: msg.key } });
            } catch {}
          }
          // ================= AUTO TYPING (NO DELAY) =================
          if (autoTyping === true && msg.from !== "status@broadcast") {
            try { await sock.sendPresenceUpdate("composing", msg.from); } catch {}
          }
          if (autorecord === true && msg.from !== "status@broadcast") {
            try { await sock.sendPresenceUpdate("recording", msg.from); } catch {}
          }
          // ================= AUTO REACT =================
          if (autoReact === true && msg.from !== "status@broadcast") {
            try {
              const emojis = [
                "⛅","👻","⛄","👀","🪁","🪃","🎳","🎀","🌸","🍥","🎀","🍓","🍡","💗","🦋","💫",
                "💀","☁️","🌨️","🌧️","🌦️","🌥️","⛅","🪹","⚡","🌟","☁️","🎐","🏖️","🎐","🪺",
                "🌊","🐚","🪸","🍒","🍇","🍉","🌻","🎢","🚀","🍫","💎","🌋","🏔️","⛰️","🌙","🪐",
                "🌲","🍃","🍂","🍁","🪵","🍄","🌿","🐞","🐍","🕊️","🎃","🏟️","🎡","🥂","🗿","⛩️"
              ];
              const emoji = emojis[Math.floor(Math.random() * emojis.length)];
              await sock.sendMessage(msg.from, { react: { text: emoji, key: msg.key } });
            } catch {}
          }

          const plugins = ensurePlugins();
          const prefix = config.prefix || ".";
          const body = (msg.body || "").toString();

          // commands - enqueue to throttle concurrency
          if (body.startsWith(prefix)) {
            const [cmd, ...args] = body.slice(prefix.length).trim().split(/\s+/);
            const plugin = plugins.commands.get(cmd);
            if (plugin) {
              enqueueTask(async () => {
                try { await plugin.exec(msg, args.join(" ")); } catch (err) {
                  logger.error?.({ sessionId, cmd }, `Command ${cmd} error: ${err?.message || err}`);
                }
              }).catch(e => logger.debug({ sessionId }, "enqueueTask command error", e?.message || e));
              return;
            }
          }

          // text-based plugins - dispatch each plugin via enqueueTask (so heavy bursts are throttled)
          if (body) {
            for (const plugin of plugins.text) {
              enqueueTask(async () => {
                try { await plugin.exec(msg); } catch (err) {
                  logger.error?.({ sessionId }, `Text plugin error: ${err?.message || err}`);
                }
              }).catch(e => logger.debug({ sessionId }, "enqueueTask text plugin error", e?.message || e));
            }
          }
        } catch (err) {
          try {
            logger.error?.({ sessionId: "unknown" }, "messages.upsert handler error", err?.message || err);
          } catch {
            console.error("messages.upsert handler error:", err);
          }
        }
      });
    } // end if listenersAttached

    // persist entry
    manager.sessions.set(sessionId, entry);
  } catch (err) {
    logger.error({ sessionId }, "onConnected error", err?.message || err);
  }
}

// attach manager-level events (only once)
let eventsAttached = false;
function attachManagerEvents() {
  if (eventsAttached) return;
  eventsAttached = true;
  manager.on("connected", onConnected);
  manager.on("session.deleted", (sessionId, info) => {
    // free per-session cache when a session is deleted
    try {
      db.setHot(sessionId, "login", false);
      groupCache.deleteSession(sessionId);
    } catch (e) {
      // ignore
    }
    logger.info({ sessionId, info }, "session deleted");
  });
  manager.on("connection.update", (sessionId, update) => {
    logger.debug({ sessionId, update }, "connection.update");
  });
}

/**
 * main(opts)
 *  - opts.sessions: array of session ids to register/start
 *  - opts.autoStartAll: boolean (default true)
 */
export async function main(opts = {}) {
  attachManagerEvents();
  await ensurePlugins();
  const sessionsToStart =
    Array.isArray(opts.sessions) && opts.sessions.length
      ? opts.sessions
      : Array.isArray(config.sessions) && config.sessions.length
        ? config.sessions
        : [process.argv[2] || "bot1"];
  for (const s of sessionsToStart) manager.register(s);
  if (opts.autoStartAll !== false) await manager.startAll();
  return { manager };
}