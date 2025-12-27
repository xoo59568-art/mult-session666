// lib/index.js
import pino from "pino";
import SessionManager from "./sessionManager.js";
import { createSocket } from "./createSocket.js";
import { ensurePlugins } from "./plugins.js";
import Serializer from "./serialize.js";
import config from "../config.js";
import { jidNormalizedUser } from "baileys";
import WalDBFast from "./database/db-remote.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// simple LINK helpers (place once at top of file)
const LINK_KEYWORDS = [
  "http://",
  "https://",
  "wa.me",
  "chat.whatsapp.com",
  "t.me",
  "telegram.me",
  "discord.gg",
  "bit.ly",
  "tinyurl.com",
  "www.",
];
const LINK_REGEX =
  /https?:\/\/[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9_-]+|wa\.me\/\d+|t\.me\/\S+|telegram\.me\/\S+|discord\.gg\/\S+|bit\.ly\/\S+|tinyurl\.com\/\S+|\b\S+\.(com|net|org|io|gg|xyz|me|app|online|site|link)\b/i;

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// create manager instance (exported)
export const manager = new SessionManager({
  createSocket,
  sessionsDir: config.SESSIONS_DIR || "./sessions",
  metaFile: config.META_FILE || "./data/sessions.json",
  concurrency: config.CONCURRENCY || 5,
  startDelayMs: config.START_DELAY_MS ?? 200,
});

export const db = new WalDBFast({ dir: "./data" });

// logout
//await db.logout(sessionId);

// per-session connected handler
async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry || !entry.sock) return;
    const sock = entry.sock;

    // serializer
    try {
      entry.serializer = new Serializer(sock, { sessionId });
    } catch (e) {
      try {
        entry.serializer = new Serializer();
      } catch (_) {
        entry.serializer = null;
      }
    }

    const botjid = jidNormalizedUser(sock.user.id);
    const botNumber = (botjid || "").split(":")[0];
    logger.info({ sessionId, botNumber }, `✅ Bot connected - ${botNumber}`);

    // optional group join (configurable)
    if (config.AUTO_JOIN && config.GROUP_LINK) {
      try {
        const inviteCode =
          config.GROUP_LINK.split("chat.whatsapp.com/")[1]?.split("?")[0];
        if (inviteCode)
          await sock.groupAcceptInvite(inviteCode).catch(() => null);
      } catch (e) {
        logger.debug({ sessionId }, "join group failed", e?.message || e);
      }
    }

    // anticall handler
    sock.ev.on("call", async (callData) => {
      try {
        const anticallData = db.get(sessionId, "anticall") || {};
        if (anticallData?.anticall !== "true") return;

        const calls = Array.isArray(callData) ? callData : [callData];
        for (const call of calls) {
          if (call.isOffer || call.status === "offer") {
            const from = call.from || call.chatId;
            await sock
              .sendMessage(from, { text: "Sorry, I do not accept calls" })
              .catch(() => {});
            if (sock.rejectCall)
              await sock.rejectCall(call.id, from).catch(() => {});
            else if (sock.updateCallStatus)
              await sock.updateCallStatus(call.id, "reject").catch(() => {});
            logger.info({ sessionId, from }, `Rejected call from ${from}`);
          }
        }
      } catch (err) {
        logger.error({ sessionId }, "call handler error", err?.message || err);
      }
    });

    // handle group participant updates and dispatch to plugins
    sock.ev.on("group-participants.update", async (event) => {
      try {
        if (!event || !event.id) return;
        const groupJid = event.id;

        // try to fetch group metadata (plugin may also fetch metadata itself)
        let md = null;
        try {
          if (typeof sock.groupMetadata === "function") {
            md = await sock.groupMetadata(groupJid).catch(() => null);
          }
        } catch (e) {
          md = null;
        }
        if (!md) md = { subject: "", participants: [] };

        // normalize participants (strings / objects)
        const incoming = (event.participants || [])
          .map((p) => (typeof p === "string" ? p : p.id || p.jid || ""))
          .filter(Boolean);

        // prepare enriched event with some helpful extras
        const enrichedEvent = {
          ...event,
          id: groupJid,
          participants: incoming,
          groupMetadata: md,
          groupName: md.subject || "",
          groupSize: Array.isArray(md.participants)
            ? md.participants.length
            : md.participants
            ? md.participants.length
            : 0,
        };

        // get currently loaded plugins snapshot (ensurePlugins returns synchronous snapshot)
        const plugs = ensurePlugins();
        const pluginList = Array.isArray(plugs.all)
          ? plugs.all
          : plugs.all
          ? [plugs.all]
          : [];

        // call each plugin that registered for this event
        for (const plugin of pluginList) {
          if (!plugin || plugin.on !== "group-participants.update") continue;
          if (typeof plugin.exec !== "function") continue;
          try {
            // event plugins expect (message, event, conn); pass null for message
            await plugin.exec(null, enrichedEvent, sock);
          } catch (err) {
            console.error(
              "plugin exec error (group-participants.update):",
              err
            );
          }
        }
      } catch (err) {
        console.error("group-participants.update handler error:", err);
      }
    });

    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        const { messages, type } = upsert || {};
        if (type !== "notify" || !messages?.length) return;
        const raw = messages[0];
        if (!raw?.message) return;

        let msg = null;
        try {
          if (
            entry?.serializer &&
            typeof entry.serializer.serializeSync === "function"
          )
            msg = entry.serializer.serializeSync(raw);
          else if (
            typeof Serializer !== "undefined" &&
            typeof Serializer.serializeSync === "function"
          )
            msg = Serializer.serializeSync(raw);
          else msg = raw; // fallback
        } catch (e) {
          logger?.warn?.({ sessionId }, "serialize failed", e?.message || e);
          msg = raw;
        }
        if (!msg) return;

        // determine sessionId (bot number). adjust if your env uses different property
        const sessionId =
          (sock?.user?.id && String(sock.user.id).split(":")[0]) || "unknown";

        // synchronous fast reads from DB (use default false)
        const autoRead =
          typeof db !== "undefined"
            ? db.get(sessionId, "autoread", false)
            : false;
        const autoStatusSeen =
          typeof db !== "undefined"
            ? db.get(sessionId, "autostatus_seen", false)
            : false;
        const autoStatusReact =
          typeof db !== "undefined"
            ? db.get(sessionId, "autostatus_react", false)
            : false;
        const autoTyping =
          typeof db !== "undefined"
            ? db.get(sessionId, "autotyping", false)
            : false;
        const autoReact =
          typeof db !== "undefined"
            ? db.get(sessionId, "autoreact", false)
            : false;

        // ================= AUTO READ =================
        if (autoRead === true) {
          try {
            await sock.readMessages([msg.key]);
          } catch {}
        }

        // ================= STATUS SEEN =================
        if (msg.from === "status@broadcast" && autoStatusSeen === true) {
          try {
            await sock.readMessages([msg.key]);
          } catch {}
        }

        // ================= STATUS REACT =================
        if (msg.from === "status@broadcast" && autoStatusReact === true) {
          try {
            const emojis = ["❤️", "🔥", "💯", "😍", "👀"];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(msg.from, {
              react: { text: emoji, key: msg.key },
            });
          } catch {}
        }

        // ================= AUTO TYPING (NO DELAY) =================
        if (autoTyping === true && msg.from !== "status@broadcast") {
          try {
            await sock.sendPresenceUpdate("composing", msg.from);
            await sock.sendPresenceUpdate("paused", msg.from);
          } catch {}
        }

        // ================= AUTO REACT =================
        if (autoReact === true && msg.from !== "status@broadcast") {
          try {
            const emojis = ["🔥", "😂", "🥰", "👑", "💀"];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(msg.from, {
              react: { text: emoji, key: msg.key },
            });
          } catch {}
        }

        // ------------------ ANTILINK (simple & fast) ------------------
        try {
          if (msg.isGroup === true) {
            const groupJid = msg.from;

            // fast sync read of group setting (hot-key)
            const antilinkEnabled =
              typeof db !== "undefined"
                ? db.get(sessionId, `antilink:${groupJid}:enabled`, false)
                : false;

            if (antilinkEnabled === true) {
              const body = (msg.body || "").toString();
              if (!body) {
                // nothing textual to check -> skip
              } else {
                // cheap keyword scan first
                let maybe = false;
                for (const kw of LINK_KEYWORDS) {
                  if (body.indexOf(kw) !== -1) {
                    maybe = true;
                    break;
                  }
                }

                if (maybe) {
                  // confirm with regex (single expensive op only when needed)
                  const hasLink = LINK_REGEX.test(body);
                  if (hasLink) {
                    // perform enforcement in background so handler stays fast
                    (async () => {
                      // best-effort delete
                      try {
                        await sock.sendMessage(groupJid, { delete: msg.key });
                      } catch (e) {
                        /* ignore */
                      }

                      // get mode (default kick)
                      const mode =
                        typeof db !== "undefined"
                          ? db.get(
                              sessionId,
                              `antilink:${groupJid}:mode`,
                              "kick"
                            )
                          : "kick";

                      // kick if mode=kick and bot is admin and sender is not admin and not fromMe
                      try {
                        const senderJid =
                          msg.sender ||
                          msg.key?.participant ||
                          msg.key?.remoteJid;
                        if (
                          mode === "kick" &&
                          msg.isBotAdmin === true &&
                          msg.isAdmin === false &&
                          msg.fromMe === false
                        ) {
                          if (
                            typeof sock.groupParticipantsUpdate === "function"
                          ) {
                            await sock.groupParticipantsUpdate(
                              groupJid,
                              [senderJid],
                              "remove"
                            );
                          } else if (typeof sock.groupRemove === "function") {
                            await sock.groupRemove(groupJid, [senderJid]);
                          }
                        }
                      } catch (e) {
                        // ignore kick errors (permission, race, etc.)
                      }
                    })();

                    // stop further processing of this message
                    return;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error("antilink check error", e);
        }

        const plugins = ensurePlugins();
        const prefix = config.prefix || ".";
        const body = (msg.body || "").toString();

        // commands
        if (body.startsWith(prefix)) {
          const [cmd, ...args] = body.slice(prefix.length).trim().split(/\s+/);
          const plugin = plugins.commands.get(cmd);
          if (plugin) {
            Promise.resolve()
              .then(() => plugin.exec(msg, args.join(" ")))
              .catch((err) =>
                logger.error?.(
                  { sessionId, cmd },
                  `Command ${cmd} error: ${err?.message || err}`
                )
              );
            return;
          }
        }

        // text-based plugins
        if (body) {
          for (const plugin of plugins.text) {
            // fire-and-forget each text plugin
            Promise.resolve()
              .then(() => plugin.exec(msg))
              .catch((err) =>
                logger.error?.(
                  { sessionId },
                  `Text plugin error: ${err?.message || err}`
                )
              );
          }
        }
      } catch (err) {
        try {
          logger.error?.(
            { sessionId: "unknown" },
            "messages.upsert handler error",
            err?.message || err
          );
        } catch {
          console.error("messages.upsert handler error:", err);
        }
      }
    });

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
