// lib/index.js
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
  sessionsDir: config.SESSIONS_DIR || "./sessions",
  metaFile: config.META_FILE || "./data/sessions.json",
  concurrency: config.CONCURRENCY || 5,
  startDelayMs: config.START_DELAY_MS ?? 200,
  db,
});

// per-session connected handler
async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry || !entry.sock) return;
    const sock = entry.sock;

    // --- REPLACEMENT SNIPPET for inside onConnected(sessionId) ---
    // serializer
    try {
      entry.serializer = new Serializer(sock, {});
    } catch (e) {
      try {
        entry.serializer = new Serializer();
      } catch (_) {
        entry.serializer = null;
      }
    }
    const botjid = jidNormalizedUser(sock.user?.id || "");
    const botNumber = (botjid || "").split("@")[0];
    logger.info({ sessionId, botNumber }, `✅ Bot connected - ${botNumber}`);
    // fix: default login must not override false
    const login = db.get(sessionId, "login") ?? true;
    if (login) {
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
        // ensure sock.user.id exists
        const targetJid = botjid;
        // build a safe quoted contact message using the bot info
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
                thumbnailUrl: "https://files.catbox.moe/6gwht4.png",
                sourceUrl:
                  "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
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
              .catch(() => { });
            if (sock.rejectCall)
              await sock.rejectCall(call.id, from).catch(() => { });
            else if (sock.updateCallStatus)
              await sock.updateCallStatus(call.id, "reject").catch(() => { });
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
                const autorecord =
          typeof db !== "undefined"
            ? db.get(sessionId, "autorecord", false)
            : false;
        const autoReact =
          typeof db !== "undefined"
            ? db.get(sessionId, "autoreact", false)
            : false;

        // ================= AUTO READ =================
        if (autoRead === true) {
          try {
            await sock.readMessages([msg.key]);
          } catch { }
        }

        // ================= STATUS SEEN =================
        if (msg.from === "status@broadcast" && autoStatusSeen === true) {
          try {
            await sock.readMessages([msg.key]);
          } catch { }
        }

        // ================= STATUS REACT =================
        if (msg.from === "status@broadcast" && autoStatusReact === true) {
          try {
            const emojis = ["❤️", "🔥", "💯", "😍", "👀"];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(msg.from, {
              react: { text: emoji, key: msg.key },
            });
          } catch { }
        }

        // ================= AUTO TYPING (NO DELAY) =================
        if (autoTyping === true && msg.from !== "status@broadcast") {
          try {
            await sock.sendPresenceUpdate("composing", msg.from);
            //  await sock.sendPresenceUpdate("paused", msg.from);
          } catch { }
        }

        if (autorecord === true && msg.from !== "status@broadcast") {
          try {
            await sock.sendPresenceUpdate("recording", msg.from);
            //  await sock.sendPresenceUpdate("paused", msg.from);
          } catch { }
        }

        // ================= AUTO REACT =================
        if (autoReact === true && msg.from !== "status@broadcast") {
          try {
            const emojis = [
              "⛅",
              "👻",
              "⛄",
              "👀",
              "🪁",
              "🪃",
              "🎳",
              "🎀",
              "🌸",
              "🍥",
              "🎀",
              "🍓",
              "🍡",
              "💗",
              "🦋",
              "💫",
              "💀",
              "☁️",
              "🌨️",
              "🌧️",
              "🌦️",
              "🌥️",
              "⛅",
              "🪹",
              "⚡",
              "🌟",
              "☁️",
              "🎐",
              "🏖️",
              "🎐",
              "🪺",
              "🌊",
              "🐚",
              "🪸",
              "🍒",
              "🍇",
              "🍉",
              "🌻",
              "🎢",
              "🚀",
              "🍫",
              "💎",
              "🌋",
              "🏔️",
              "⛰️",
              "🌙",
              "🪐",
              "🌲",
              "🍃",
              "🍂",
              "🍁",
              "🪵",
              "🍄",
              "🌿",
              "🐞",
              "🐍",
              "🕊️",
              "🎃",
              "🏟️",
              "🎡",
              "🥂",
              "🗿",
              "⛩️",
            ];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(msg.from, {
              react: { text: emoji, key: msg.key },
            });
          } catch { }
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
