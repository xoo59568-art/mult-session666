// plugins/antilink.js
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";
Module({
  command: "antilink",
  package: "owner",
  description:
    "Enable/disable anti-link for this group or set mode (kick/null). Default mode: kick",
})(async (message, match) => {
  // only allow owner/bot to change settings (keep as before)
  if (!(message.isFromMe || message.isfromMe))
    return message.send("❌ Only bot owner can use this command.");
  if (!message.isGroup)
    return message.send("❌ This command works only in groups.");
await message.loadGroupInfo();
  // normalize bot JID/number
  const botJid = (message.conn?.user?.id && String(message.conn.user.id)) || "";
  const botNumber = botJid ? String(botJid).split("@")[0] : "unknown";
console.log("isBotAdmin", message.isBotAdmin);
console.log("isAdmin", message.isAdmin);
  // If bot is not admin, send a fast notice asking to promote the bot and exit
  if (!message.isBotAdmin) {
    try {
      // Mention the bot in the message so group members see whom to promote
      const mention = botJid ? [botJid] : [];
      return message.send(
        "⚠️ I need admin.",
        { mentions: mention }
      );
    } catch (e) {
      // fallback plain message
      return message.send(
        "⚠️ I need admin privileges to change anti-link settings. Please promote the bot to admin and retry."
      );
    }
  }

  const groupJid = message.from;
  const raw = (match || "").trim().toLowerCase();
  // status + usage
  const enabledKey = `antilink:${groupJid}:enabled`;
  const modeKey = `antilink:${groupJid}:mode`;
  // show status if no args
  if (!raw) {
    const isEnabled = db.get(botNumber, enabledKey, false) === true;
    const mode = db.get(botNumber, modeKey, "kick") || "kick";
    return message.send(
      `⚙️ AntiLink for this group\n• Status: ${
        isEnabled ? "✅ ON" : "❌ OFF"
      }\n• Mode: ${mode.toUpperCase()}\n\nUsage:\n• .antilink on\n• .antilink off\n• .antilink kick\n• .antilink null`
    );
  }
  // allow commands like ".antilink on" or ".antilink kick"
  if (raw === "on") {
    const already = db.get(botNumber, enabledKey, false) === true;
    const currentMode = db.get(botNumber, modeKey, "kick") || "kick";
    if (already) {
      return message.send(
        `ℹ️ AntiLink is already *ON* for this group (mode: *${currentMode.toUpperCase()}*).`
      );
    }
    // enable and ensure default mode is set to kick if not set
    db.setHot(botNumber, enabledKey, true);
    // set default mode to kick if not present
    const hasMode = db.get(botNumber, modeKey, null);
    if (!hasMode) db.setHot(botNumber, modeKey, "kick");
    return message.send(
      `✅ AntiLink has been *ENABLED* for this group. Default action: *KICK* (you can change with .antilink kick/null).`
    );
  }
  if (raw === "off") {
    const already = db.get(botNumber, enabledKey, false) === false;
    if (already) {
      return message.send("ℹ️ AntiLink is already *OFF* for this group.");
    }
    db.setHot(botNumber, enabledKey, false);
    // keep mode key (optional). You can remove it if you want.
    return message.send("✅ AntiLink has been *DISABLED* for this group.");
  }
  // mode switches
  if (raw === "kick" || raw === "null") {
    // set mode
    db.setHot(botNumber, modeKey, raw);
    // If enabling mode to kick but feature is off, enable it automatically (smart convenience)
    const isEnabled = db.get(botNumber, enabledKey, false) === true;
    if (!isEnabled) {
      db.setHot(botNumber, enabledKey, true);
      return message.send(
        `✅ AntiLink mode set to *${raw.toUpperCase()}* and AntiLink has been automatically *ENABLED* for this group.`
      );
    }
    return message.send(
      `✅ AntiLink mode updated to *${raw.toUpperCase()}* for this group.`
    );
  }
  // fallback: unknown arg
  return message.send(
    "Usage:\n.antilink on\n.antilink off\n.antilink kick\n.antilink null"
  );
});


const LINK_REGEX =
  /https?:\/\/[^\s]+|chat\.whatsapp\.com\/[A-Za-z0-9_-]+|wa\.me\/\d+|t\.me\/\S+|telegram\.me\/\S+|discord\.gg\/\S+|bit\.ly\/\S+|tinyurl\.com\/\S+|\b\S+\.(com|net|org|io|gg|xyz|me|app|online|site|link)\b/i;

Module({ on: "text", package: "group", description: "Enforce anti-link policy in groups" })(
  async (message) => {
    try {
      // only for groups
      if (!message || !message.isGroup) return;

      // safety: must have body
      const body = (message.body || "").toString();
      if (!body) return;

      // determine sessionId used by your DB keys (bot number)
      const botJid = (message.conn?.user?.id && String(message.conn.user.id)) || "";
      const botNumber = botJid ? String(botJid).split("@")[0] : "unknown";

      const groupJid = message.from;

      // DB key names you used in your command example
      const enabledKey = `antilink:${groupJid}:enabled`;
      const modeKey = `antilink:${groupJid}:mode`;

      // quick check whether antilink is enabled for this group (hot key expected)
      const enabled = db.get(botNumber, enabledKey, false) === true;
      if (!enabled) return;

      // check bot/admin/sender roles
      const botIsAdmin = !!message.isBotAdmin;
      const senderIsAdmin = !!message.isAdmin;
      const senderIsOwnerOrFromMe = !!message.isfromMe; // owner/bot self

      // only act if bot is admin, and sender is not admin, and sender is not bot owner/bot itself
      if (!botIsAdmin) {
        // optional: notify group that bot needs admin rights (keep it quiet to avoid spam)
        // await message.send("⚠️ I need admin privileges to enforce anti-link.");
        return;
      }
      if (senderIsAdmin || senderIsOwnerOrFromMe) return;

      // detect link
      if (!LINK_REGEX.test(body)) return;

      // OK — we have an offending message. Determine mode
      const mode = (db.get(botNumber, modeKey, "kick") || "kick").toString().toLowerCase();

      // 1) delete offending message (uses Serializer msgObj.send({ delete: msg.key }) behavior)
      try {
        // If your serializer supports `message.send({ delete: message.key })` this will work.
        // Otherwise, try conn.sendMessage with `delete` content (Baileys compatibility).
        if (typeof message.send === "function") {
          await message.send({ delete: message.key }).catch(() => {});
        } else if (message.conn && typeof message.conn.sendMessage === "function") {
          await message.conn.sendMessage(message.from, { delete: message.key }).catch(() => {});
        }
      } catch (e) {
        // non-fatal
      }

      const senderJid = message.sender || message.key?.participant || message.key?.from || null;
      const senderNum = senderJid ? senderJid.split("@")[0] : "user";

      // 2) Handle according to mode
      if (mode === "null") {
        // just remove the link and optionally notify once
        try {
          await message.reply(`⚠️ Link removed from @${senderNum}`, { mentions: [senderJid] });
        } catch (e) { /* ignore */ }
        return;
      }

      if (mode === "kick") {
        try {
          // notify group that the user is being removed
          await message.reply(
            `🚫 @${senderNum} posted a prohibited link and will be removed from the group.`,
            { mentions: [senderJid] }
          );
        } catch (e) { /* ignore */ }

        // small delay so the delete/notify reaches the group before kicking
        await new Promise((r) => setTimeout(r, 600));

        // remove the participant (Serializer exposes message.removeParticipant)
        try {
          if (typeof message.removeParticipant === "function") {
            await message.removeParticipant([senderJid]);
          } else if (message.conn && typeof message.conn.groupParticipantsUpdate === "function") {
            await message.conn.groupParticipantsUpdate(message.from, [senderJid], "remove");
          }
        } catch (err) {
          console.error("antilink: failed to remove participant", err);
          // if removal fails, try to notify admin
          try {
            await message.reply(
              `❌ Failed to remove @${senderNum}. Please remove them manually.`,
              { mentions: [senderJid] }
            );
          } catch {}
        }
      }
    } catch (error) {
      console.error("AntiLink enforcement error:", error);
    }
  }
);