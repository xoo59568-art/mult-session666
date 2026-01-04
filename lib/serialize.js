
import { getContentType,
    downloadContentFromMessage,
    jidNormalizedUser,
    areJidsSameUser,
    extractMessageContent,
} from "@whiskeysockets/baileys";
import * as groupCache from "./group-cache.js"; // <-- per-session cache
import * as Jimp from "jimp";

async function makePp(buf) {
  const img = await Jimp.read(buf);

  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const size = Math.min(w, h);
  const x = Math.floor((w - size) / 2);
  const y = Math.floor((h - size) / 2);

  img.crop({
    x,
    y,
    w: size,
    h: size,
  });

  img.resize(640, 640);

  return await img.getBufferAsync("image/jpeg");
}
export default class Serializer {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  serializeSync(msg) {
      const conn = this.conn;
  const key = msg.key;
  const from = key.remoteJid || key.remoteJidAlt || "";
  const fromMe = key.fromMe || false;
  const sender = jidNormalizedUser(
    key.participant || key.participantAlt || from
  );
  const isGroup = from.endsWith("@g.us");
  const pushName = msg.pushName || "Unknown";
  const messageContent = extractMessageContent(msg.message);
  const type = getContentType(messageContent || msg.message);
  const content = messageContent?.[type] || msg.message?.[type];
const sessionCache = groupCache.forSession(this.sessionId);
  const cache = sessionCache;
  const extractBody = () => {
    if (!content) return "";
    return type === "conversation"
      ? content
      : type === "extendedTextMessage"
      ? content.text
      : type === "imageMessage" && content.caption
      ? content.caption
      : type === "videoMessage" && content.caption
      ? content.caption
      : type === "templateButtonReplyMessage"
      ? content.selectedDisplayText
      : type === "buttonsResponseMessage"
      ? content.selectedButtonId
      : type === "listResponseMessage"
      ? content.singleSelectReply?.selectedRowId
      : "";
  };

  const isfromMe =
    fromMe ||
    areJidsSameUser(sender, jidNormalizedUser(conn.user.id)) ||
    (conn.user.lid &&
      areJidsSameUser(sender, jidNormalizedUser(conn.user.lid)));

  const extractQuoted = () => {
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = context?.quotedMessage;
    if (!quotedMsg) return null;
    const qt = getContentType(quotedMsg);
    const qContent = quotedMsg[qt];
    const b =
      qt === "conversation"
        ? qContent
        : qt === "extendedTextMessage"
        ? qContent.text || ""
        : qt === "imageMessage"
        ? qContent.caption || ""
        : qt === "videoMessage"
        ? qContent.caption || ""
        : qt === "templateButtonReplyMessage"
        ? qContent.selectedDisplayText || ""
        : qt === "buttonsResponseMessage"
        ? qContent.selectedButtonId || ""
        : qt === "listResponseMessage"
        ? qContent.singleSelectReply?.selectedRowId || ""
        : "";
    const quotedParticipant = jidNormalizedUser(
      context.participant || context.participantAlt || from
    );
    const isQuotedFromMe =
      areJidsSameUser(quotedParticipant, jidNormalizedUser(conn.user.id)) ||
      (conn.user.lid &&
        areJidsSameUser(quotedParticipant, jidNormalizedUser(conn.user.lid)));
    return {
      type: qt,
      msg: qContent,
      body: b,
      fromMe: isQuotedFromMe,
      participant: quotedParticipant,
      id: context.stanzaId,
      key: {
        remoteJid: from,
        fromMe: isQuotedFromMe,
        id: context.stanzaId,
        participant: quotedParticipant,
      },
      download: async () => {
        try {
          const stream = await downloadContentFromMessage(
            qContent,
            qt.replace("Message", "")
          );
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks);
        } catch (err) {
          console.error("Error downloading quoted media:", err);
          return null;
        }
      },
    };
  };

  // create base message object
  const msgObj = {
    raw: msg,
    mek: msg,
    client: conn,
    conn,
    key,
    bot: jidNormalizedUser(conn.user.id),
    id: key.id,
    from,
    fromMe,
    sender,
    isGroup,
    isFromMe: isfromMe,
    isfromMe,
    pushName,
    type,
    body: extractBody(),
    content,
    quoted: extractQuoted(),
    mentions: msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
  };

  // botJid helper (fixed: define from conn)
  msgObj.botJid = () => {
    try {
      return jidNormalizedUser(conn.user.id);
    } catch {
      return null;
    }
  };

  // load group info using shared cache (read-through)
  msgObj.loadGroupInfo = async () => {
    if (!msgObj.isGroup) return msgObj;
    try {
      const md = await cache.getGroupMetadata(conn, msgObj.from); // read-through fetch & cache
      msgObj.groupMetadata = md || {};
msgObj.groupParticipants = msgObj.groupMetadata.participants || [];
msgObj.groupAdmins = (msgObj.groupParticipants || [])
  .filter((p) => p && (p.isAdmin === true || p.admin === "admin" || p.admin === "superadmin"))
  .map((p) => jidNormalizedUser(p.id));
msgObj.groupOwner = msgObj.groupMetadata.owner
  ? jidNormalizedUser(msgObj.groupMetadata.owner)
  : msgObj.groupAdmins[0] || null;
      msgObj.joinApprovalMode = msgObj.groupMetadata.joinApprovalMode || false;
      msgObj.memberAddMode = msgObj.groupMetadata.memberAddMode || false;
      msgObj.announce = msgObj.groupMetadata.announce || false;
      msgObj.restrict = msgObj.groupMetadata.restrict || false;
      const botJid = conn.user?.id ? jidNormalizedUser(conn.user.id) : null;
      const botLid = conn.user?.lid ? jidNormalizedUser(conn.user.lid) : null;
      msgObj.isAdmin = (msgObj.groupAdmins || []).some((adminId) =>
        areJidsSameUser(adminId, msgObj.sender)
      );
      msgObj.isBotAdmin = (msgObj.groupAdmins || []).some(
        (adminId) =>
          (botJid && areJidsSameUser(adminId, botJid)) ||
          (botLid && areJidsSameUser(adminId, botLid))
      );
    } catch (err) {
      console.error("Error loading group info:", err);
    }
    return msgObj;
  };

  // helper to refresh cache after changes (safe)
  async function refreshCache() {
    try {
      await cache.getGroupMetadata(conn, msgObj.from);
    } catch (e) {
      // ignore
    }
  }

  // group control helpers (they refresh cache after success)
  msgObj.muteGroup = async () => {
    try {
      const res = await conn.groupSettingUpdate(msgObj.from, "announcement");
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error muting group:", err);
      return null;
    }
  };

  msgObj.unmuteGroup = async () => {
    try {
      const res = await conn.groupSettingUpdate(
        msgObj.from,
        "not_announcement"
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error unmuting group:", err);
      return null;
    }
  };

  msgObj.setSubject = async (text) => {
    try {
      const res = await conn.groupUpdateSubject(msgObj.from, text);
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error updating subject:", err);
      return null;
    }
  };

  msgObj.setDescription = async (text) => {
    try {
      const res = await conn.groupUpdateDescription(msgObj.from, text);
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error updating description:", err);
      return null;
    }
  };

  msgObj.addParticipant = async (jid) => {
    try {
      const jids = Array.isArray(jid) ? jid : [jid];
      const normalized = jids.map((j) => jidNormalizedUser(j));
      const res = await conn.groupParticipantsUpdate(
        msgObj.from,
        normalized,
        "add"
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error adding participant:", err);
      return null;
    }
  };

  msgObj.removeParticipant = async (jid) => {
    try {
      const jids = Array.isArray(jid) ? jid : [jid];
      const normalized = jids.map((j) => jidNormalizedUser(j));
      const res = await conn.groupParticipantsUpdate(
        msgObj.from,
        normalized,
        "remove"
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error removing participant:", err);
      return null;
    }
  };

  msgObj.promoteParticipant = async (jid) => {
    try {
      const jids = Array.isArray(jid) ? jid : [jid];
      const normalized = jids.map((j) => jidNormalizedUser(j));
      const res = await conn.groupParticipantsUpdate(
        msgObj.from,
        normalized,
        "promote"
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error promoting participant:", err);
      return null;
    }
  };

  msgObj.demoteParticipant = async (jid) => {
    try {
      const jids = Array.isArray(jid) ? jid : [jid];
      const normalized = jids.map((j) => jidNormalizedUser(j));
      const res = await conn.groupParticipantsUpdate(
        msgObj.from,
        normalized,
        "demote"
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error demoting participant:", err);
      return null;
    }
  };

  msgObj.leaveGroup = async () => {
    try {
      const res = await conn.groupLeave(msgObj.from);
      // leaving means cache entry may be invalid; delete local cache
      try {
        cache.deleteCached(msgObj.from);
      } catch {}
      return res;
    } catch (err) {
      console.error("Error leaving group:", err);
      return null;
    }
  };

  msgObj.inviteCode = async () => {
    try {
      return await conn.groupInviteCode(msgObj.from);
    } catch (err) {
      console.error("Error getting invite code:", err);
      return null;
    }
  };

  msgObj.revokeInvite = async () => {
    try {
      const res = await conn.groupRevokeInvite(msgObj.from);
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error revoking invite:", err);
      return null;
    }
  };

  msgObj.getInviteInfo = async (code) => {
    try {
      return await conn.groupGetInviteInfo(code);
    } catch (err) {
      console.error("Error getting invite info:", err);
      return null;
    }
  };

  msgObj.joinViaInvite = async (code) => {
    try {
      return await conn.groupAcceptInvite(code);
    } catch (err) {
      console.error("Error joining via invite:", err);
      return null;
    }
  };

  msgObj.getJoinRequests = async () => {
    try {
      return await conn.groupRequestParticipantsList(msgObj.from);
    } catch (err) {
      console.error("Error getting join requests:", err);
      return null;
    }
  };

  msgObj.updateJoinRequests = async (jids, action = "approve") => {
    try {
      const normalized = Array.isArray(jids)
        ? jids.map((j) => jidNormalizedUser(j))
        : [jidNormalizedUser(jids)];
      const res = await conn.groupRequestParticipantsUpdate(
        msgObj.from,
        normalized,
        action
      );
      await refreshCache();
      return res;
    } catch (err) {
      console.error("Error updating join requests:", err);
      return null;
    }
  };

  // setMemberAddMode: try modern member_add_mode if available, fallback to announcement toggle
  msgObj.setMemberAddMode = async (enable = true) => {
    try {
      // try newer param first (some Baileys versions may support)
      try {
        const attempt = await conn.groupSettingUpdate(
          msgObj.from,
          enable ? "member_add_mode" : "not_member_add_mode"
        );
        await refreshCache();
        return attempt;
      } catch (e) {
        // fallback to announcement toggle if above not supported
        const fallback = await conn.groupSettingUpdate(
          msgObj.from,
          enable ? "not_announcement" : "announcement"
        );
        await refreshCache();
        return fallback;
      }
    } catch (err) {
      console.error("Error setting member add mode:", err);
      return null;
    }
  };

  msgObj.fetchStatus = async (jid) => {
    try {
      return await conn.fetchStatus(jidNormalizedUser(jid));
    } catch (err) {
      console.error("Error fetching status:", err);
      return null;
    }
  };

  msgObj.profilePictureUrl = async (jid, type = "image") => {
    try {
      return await conn.profilePictureUrl(jidNormalizedUser(jid), type);
    } catch (err) {
      console.error("Error getting profile picture:", err);
      return null;
    }
  };

  msgObj.blockUser = async (jid) => {
    try {
      return await conn.updateBlockStatus(jidNormalizedUser(jid), "block");
    } catch (err) {
      console.error("Error blocking user:", err);
      return null;
    }
  };

  msgObj.unblockUser = async (jid) => {
    try {
      return await conn.updateBlockStatus(jidNormalizedUser(jid), "unblock");
    } catch (err) {
      console.error("Error unblocking user:", err);
      return null;
    }
  };

  msgObj.getParticipants = () => msgObj.groupParticipants || [];
  msgObj.isParticipant = (jid) => {
    const normalized = jidNormalizedUser(jid);
    return msgObj
      .getParticipants()
      .some((p) => {
        const pid = typeof p === "string" ? p : p?.id || p;
        return areJidsSameUser(jidNormalizedUser(pid), normalized);
      });
  };

  msgObj.download = async () => {
    try {
      if (!msgObj.content) return null;
      const stream = await downloadContentFromMessage(
        msgObj.content,
        msgObj.type.replace("Message", "")
      );
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      console.error("Error downloading media:", err);
      return null;
    }
  };

  msgObj.send = async (payload, options = {}) => {
    try {
      if (payload?.delete) {
        return await conn.sendMessage(msgObj.from, { delete: payload.delete });
      }

      let cend;

      if (typeof payload === "string") {
        cend = { text: payload };
      } else if (payload.video) {
        cend = {
          video: payload.video,
          caption: payload.caption || "",
          mimetype: payload.mimetype || "video/mp4",
        };
      } else if (payload.image) {
        cend = {
          image: payload.image,
          caption: payload.caption || "",
        };
      } else if (payload.audio) {
        cend = {
          audio: payload.audio,
          mimetype: payload.mimetype || "audio/mp4",
          ptt: payload.ptt || false,
        };
      } else {
        cend = payload;
      }

      if (options.mentions) {
        cend.mentions = options.mentions;
      }

      if (options.edit) {
        cend.edit = options.edit;
      }

      return await conn.sendMessage(msgObj.from, cend, {
        quoted: options.quoted,
      });
    } catch (err) {
      console.error("Error sending message:", err);
      return null;
    }
  };

  msgObj.react = async (emoji) => {
    try {
      return await conn.sendMessage(msgObj.from, {
        react: {
          text: emoji,
          key: msgObj.key,
        },
      });
    } catch (err) {
      console.error("Error reacting:", err);
      return null;
    }
  };

  const replyMethod = async (payload, options = {}) => {
    try {
      if (payload?.delete) {
        return await conn.sendMessage(msgObj.from, { delete: payload.delete });
      }

      let cend;

      if (typeof payload === "string") {
        cend = { text: payload };
      } else if (payload.video) {
        cend = {
          video: payload.video,
          caption: payload.caption || "",
          mimetype: payload.mimetype || "video/mp4",
        };
      } else if (payload.image) {
        cend = {
          image: payload.image,
          caption: payload.caption || "",
        };
      } else if (payload.audio) {
        cend = {
          audio: payload.audio,
          mimetype: payload.mimetype || "audio/mp4",
          ptt: payload.ptt || false,
        };
      } else {
        cend = payload;
      }

      if (options.mentions) {
        cend.mentions = options.mentions;
      }

      if (options.edit) {
        cend.edit = options.edit;
      }

      return await conn.sendMessage(msgObj.from, cend, { quoted: msgObj.raw });
    } catch (err) {
      console.error("Error sending reply:", err);
      return null;
    }
  };

  msgObj.sendreply = replyMethod;
  msgObj.sendReply = replyMethod;
  msgObj.reply = replyMethod;

  msgObj.setPp = async (jid, buf) => {
    try {
      const img = await makePp(buf);
      if (typeof conn.updateProfilePicture === "function") {
        try {
          await conn.updateProfilePicture(jidNormalizedUser(jid), img);
        } catch (e) {
          // ignore and fallback to query
        }
      }
      if (typeof conn.query === "function") {
        await conn.query({
          tag: "iq",
          attrs: {
            to: jidNormalizedUser(jid),
            type: "set",
            xmlns: "w:profile:picture",
          },
          content: [
            { tag: "picture", attrs: { type: "image" }, content: img },
          ],
        });
      }
      // refresh cache for that user in group metadata if present
      try {
        await refreshCache();
      } catch {}
      return true;
    } catch (err) {
      console.error("Error setting profile picture:", err);
      return null;
    }
  };

  msgObj.getLID = async (phoneNumber) => {
    try {
      if (!conn.signalRepository?.lidMapping) return null;
      return await conn.signalRepository.lidMapping.getLIDForPN(phoneNumber);
    } catch (err) {
      console.error("Error getting LID:", err);
      return null;
    }
  };

  msgObj.getPN = async (lid) => {
    try {
      if (!conn.signalRepository?.lidMapping) return null;
      return await conn.signalRepository.lidMapping.getPNForLID(lid);
    } catch (err) {
      console.error("Error getting PN:", err);
      return null;
    }
  };

  msgObj.isPnUser = (jid) => {
    return jid?.includes("@s.whatsapp.net") || false;
  };

  msgObj.isLidUser = (jid) => {
    return jid?.includes("@lid") || false;
  };

  msgObj.areJidsSame = (jid1, jid2) => {
    return areJidsSameUser(jidNormalizedUser(jid1), jidNormalizedUser(jid2));
  };

  return msgObj;
  }
}


