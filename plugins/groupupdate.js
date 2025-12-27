// plugins/welcome-goodbye.js
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";
import axios from "axios";
import config from "../config.js";
import { jidNormalizedUser } from "baileys";

function defaultWelcome() {
  return {
    status: false,
    message: "Hi &mention, welcome to &name! total &size",
    sendPpIfRequested: true,
  };
}
function defaultGoodbye() {
  return {
    status: false,
    message: "Goodbye &mention. We will miss you from &name (now &size).",
    sendPpIfRequested: false,
  };
}
function toBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === "string")
    return ["true", "1", "yes", "on"].includes(v.toLowerCase());
  return Boolean(v);
}

function buildText(template = "", replacements = {}) {
  let text = template || "";
  const wantsPp = text.includes("&pp");
  text = text.replace(/&pp/g, "").trim();
  text = text.replace(/&mention/g, replacements.mentionText || "");
  text = text.replace(/&name/g, replacements.name || "");
  text = text.replace(/&size/g, String(replacements.size ?? ""));
  return { text, wantsPp };
}

async function fetchProfileBuffer(conn, jid) {
  try {
    const url = await conn.profilePictureUrl?.(jid, "image").catch(() => null);
    if (!url) return null;
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
    });
    return Buffer.from(res.data);
  } catch (e) {
    return null;
  }
}

async function sendWelcomeMsg(
  conn,
  groupJid,
  text,
  mentions = [],
  imgBuffer = null
) {
  try {
    if (imgBuffer) {
      await conn.sendMessage(groupJid, {
        image: imgBuffer,
        caption: text,
        mentions,
      });
    } else {
      await conn.sendMessage(groupJid, { text, mentions });
    }
  } catch (err) {
    // fallback without mentions if library errors
    try {
      if (imgBuffer)
        await conn.sendMessage(groupJid, { image: imgBuffer, caption: text });
      else await conn.sendMessage(groupJid, { text });
    } catch (e) {
      console.error("sendWelcomeMsg error:", e);
    }
  }
}

/* ---------------- COMMANDS (GLOBAL) ---------------- */

// .welcome [on|off|show|<message>]  -- GLOBAL setting (owner-only)
Module({
  command: "welcome",
  package: "group",
  description:
    "Toggle/set/show global welcome message for the bot (owner-only)",
})(async (message, match) => {
  // only bot owner may change global settings
  if (!message.isFromMe)
    return message.send?.("❌ Only bot owner can use this command.");

  const raw = (match || "").trim();
  const botNumber =
    (message.conn?.user?.id && String(message.conn.user.id).split(":")[0]) ||
    "bot";
  const key = `global:welcome`;

  let cfg = await db.getAsync(botNumber, key, null);
  if (!cfg || typeof cfg !== "object") cfg = defaultWelcome();

  if (!raw) {
    return await message.sendreply?.(
      `*Global Welcome Settings*
• Status: ${toBool(cfg.status) ? "✅ ON" : "❌ OFF"}
• Message: ${cfg.message || "(none)"}

Placeholders: &mention, &name, &size, &pp`
    );
  }

  const lower = raw.toLowerCase();
  if (lower === "on" || lower === "off") {
    cfg.status = lower === "on";
    await db.set(botNumber, key, cfg);
    await message.react?.("✅");
    return await message.send(
      cfg.status ? "✅ Global welcome ENABLED" : "❌ Global welcome DISABLED"
    );
  }

  if (lower === "show" || lower === "get") {
    return await message.sendreply?.(`Message: ${cfg.message || "(none)"}
Status: ${toBool(cfg.status) ? "ON" : "OFF"}`);
  }

  // save custom global template
  cfg.message = raw;
  await db.set(botNumber, key, cfg);
  await message.react?.("✅");
  return await message.send("✅ Global welcome message updated");
});

// .goodbye [on|off|show|<message>]  -- GLOBAL setting (owner-only)
Module({
  command: "goodbye",
  package: "group",
  description:
    "Toggle/set/show global goodbye message for the bot (owner-only)",
})(async (message, match) => {
  if (!message.isFromMe)
    return message.send?.(
      "❌ Only bot owner can use this command (global setting)."
    );

  const raw = (match || "").trim();
  const botNumber =
    (message.conn?.user?.id && String(message.conn.user.id).split(":")[0]) ||
    "bot";
  const key = `global:goodbye`;

  let cfg = await db.getAsync(botNumber, key, null);
  if (!cfg || typeof cfg !== "object") cfg = defaultGoodbye();

  if (!raw) {
    return await message.sendreply?.(
      `*Global Goodbye Settings*
• Status: ${toBool(cfg.status) ? "✅ ON" : "❌ OFF"}
• Message: ${cfg.message || "(none)"}

Placeholders: &mention, &name, &size, &pp`
    );
  }

  const lower = raw.toLowerCase();
  if (lower === "on" || lower === "off") {
    cfg.status = lower === "on";
    await db.set(botNumber, key, cfg);
    await message.react?.("✅");
    return await message.send(
      cfg.status ? "✅ Global goodbye ENABLED" : "❌ Global goodbye DISABLED"
    );
  }

  if (lower === "show" || lower === "get") {
    return await message.sendreply?.(`Message: ${cfg.message || "(none)"}
Status: ${toBool(cfg.status) ? "ON" : "OFF"}`);
  }

  // save custom global template
  cfg.message = raw;
  await db.set(botNumber, key, cfg);
  await message.react?.("✅");
  return await message.send("✅ Global goodbye message updated");
});

/* ---------------- EVENT: group-participants.update ---------------- */
Module({ on: "group-participants.update" })(async (_msg, event, conn) => {
  try {
    if (
      !event ||
      !event.id ||
      !event.action ||
      !Array.isArray(event.participants)
    )
      return;
    const groupJid = event.id;

    // load group metadata (plugins may also fetch more if needed)
    let md = null;
    try {
      md = await conn.groupMetadata?.(groupJid).catch(() => null);
    } catch (e) {
      md = null;
    }
    if (!md) md = { subject: "", participants: [] };
    const groupName = md.subject || "";
    const groupSize = (md.participants && md.participants.length) || 0;

    for (const p of event.participants) {
      const participantJid = jidNormalizedUser(
        typeof p === "string" ? p : p.id || p.jid
      );
      if (!participantJid) continue;

      // skip if the bot itself is the target
      const botJid = jidNormalizedUser(conn.user?.id);
      if (
        botJid &&
        participantJid &&
        participantJid.includes(botJid.split(":")[0])
      )
        continue;

      // GLOBAL welcome handling
      if (event.action === "add") {
        const cfgRaw = await db.getAsync(
          botJid ? String(botJid).split(":")[0] : "bot",
          `global:welcome`,
          null
        );
        const cfg =
          cfgRaw && typeof cfgRaw === "object" ? cfgRaw : defaultWelcome();
        if (!toBool(cfg.status)) continue;
        const mentionText = `@${participantJid.split("@")[0]}`;
        const replacements = { mentionText, name: groupName, size: groupSize };
        const { text, wantsPp } = buildText(cfg.message, replacements);
        let imgBuf = null;
        if (wantsPp) imgBuf = await fetchProfileBuffer(conn, participantJid);
        await sendWelcomeMsg(conn, groupJid, text, [participantJid], imgBuf);
      }

      // GLOBAL goodbye handling
      if (event.action === "remove") {
        const cfgRaw = await db.getAsync(
          botJid ? String(botJid).split(":")[0] : "bot",
          `global:goodbye`,
          null
        );
        const cfg =
          cfgRaw && typeof cfgRaw === "object" ? cfgRaw : defaultGoodbye();
        if (!toBool(cfg.status)) continue;
        const mentionText = `@${participantJid.split("@")[0]}`;
        const replacements = { mentionText, name: groupName, size: groupSize };
        const { text, wantsPp } = buildText(cfg.message, replacements);
        let imgBuf = null;
        if (wantsPp) imgBuf = await fetchProfileBuffer(conn, participantJid);
        await sendWelcomeMsg(conn, groupJid, text, [participantJid], imgBuf);
      }

      // PROMOTE / DEMOTE -> PDM (global) using bot owner mention
      if (event.action === "promote" || event.action === "demote") {
        let owner = botJid || null;
        if (owner && !owner.includes("@")) owner = `${owner}@s.whatsapp.net`;
        const ownerMention = owner
          ? `@${owner.split("@")[0]}`
          : conn.user?.id
          ? `@${String(conn.user.id).split(":")[0]}`
          : "Owner";

        const actor = event.actor || event.author || event.by || null;
        const actorText = actor ? `@${actor.split("@")[0]}` : "Admin";
        const targetText = `@${participantJid.split("@")[0]}`;
        const actionText = event.action === "promote" ? "promoted" : "demoted";

        const sendText = `╭─〔 *🎉 Admin Event* 〕
├─ ${actorText} has ${actionText} ${targetText}
├─ Group: ${groupName}
╰─➤ Powered by ${ownerMention}`;
        try {
          const mentions = [actor, participantJid, botJid];
          if (owner) mentions.push(owner);
          await conn.sendMessage(groupJid, {
            text: sendText,
            mentions: mentions.filter(Boolean),
          });
        } catch (e) {
          try {
            await conn.sendMessage(groupJid, { text: sendText });
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error("welcome-goodbye event handler error:", err);
  }
});
