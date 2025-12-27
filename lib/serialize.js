// core/Serializer.js
import axios from "axios";
import sharp from "sharp";
import {
  getContentType,
  jidNormalizedUser,
  areJidsSameUser,
  downloadMediaMessage,
  downloadContentFromMessage,
} from "baileys";

// --- small semaphore ---
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    if (this.queue.length) {
      const r = this.queue.shift();
      r();
    }
  }
}

// --- internal TTL cache (fallback) ---
class TTLCache {
  constructor(defaultTtlSec = 300) {
    this.map = new Map();
    this.ttlMs = defaultTtlSec * 1000;
  }
  get(k) {
    const r = this.map.get(k);
    if (!r) return null;
    if (Date.now() > r.expiry) {
      this.map.delete(k);
      return null;
    }
    return r.value;
  }
  set(k, v, ttlSec) {
    const ttl = (ttlSec ?? this.ttlMs / 1000) * 1000;
    this.map.set(k, { value: v, expiry: Date.now() + ttl });
  }
  delete(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

// --- small image helper (can be moved to worker threads) ---
async function makePp(buf) {
  const img = await sharp(buf)
    .rotate()
    .resize(324, 324, { fit: "cover" })
    .jpeg({ quality: 90 })
    .toBuffer();
  const prev = await sharp(buf)
    .rotate()
    .resize(150, 150, { fit: "cover" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { img, prev };
}

export default class Serializer {
  /**
   * conn: baileys connection
   * opts: { mediaConcurrency, groupCacheTtl, fetchTimeoutMs, cacheModule }
   * - cacheModule should implement async get(key) and async set(key, value, ttlSec)
   */
  constructor(conn, opts = {}) {
    this.conn = conn;
    this.client = conn; // alias for compatibility
    this.mediaSemaphore = new Semaphore(opts.mediaConcurrency ?? 4);
    this.groupCache = new TTLCache(opts.groupCacheTtl ?? 300);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 15000;
    this.cacheModule = opts.cacheModule ?? null; // external cache (e.g., redis) if provided

    // baileys helper detection
    this.hasDownloadMediaMessage = typeof downloadMediaMessage === "function";
    this.hasDownloadContentFromMessage =
      typeof downloadContentFromMessage === "function";

    // bind
    this._downloadMediaFromMsg = this._downloadMediaFromMsg.bind(this);
    this._safeFetchBuffer = this._safeFetchBuffer.bind(this);
  }

  async _safeFetchBuffer(url) {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: this.fetchTimeoutMs,
      maxContentLength: 50 * 1024 * 1024,
    });
    return Buffer.from(res.data);
  }

  // controlled download helper
  async _downloadMediaFromMsg(wamessage, mediaType = null) {
    if (!wamessage || !wamessage.message) return null;
    let ct;
    try {
      ct = getContentType(wamessage.message);
    } catch (e) {
      ct = Object.keys(wamessage.message || {})[0];
    }
    const targetType =
      mediaType && !mediaType.endsWith("Message")
        ? `${mediaType}Message`
        : mediaType || ct;

    await this.mediaSemaphore.acquire();
    try {
      if (this.hasDownloadMediaMessage) {
        try {
          const buffer = await downloadMediaMessage(
            wamessage,
            "buffer",
            {},
            {}
          );
          return buffer;
        } catch (err) {
          // fallback
        }
      }
      if (this.hasDownloadContentFromMessage) {
        const content =
          wamessage.message?.[targetType] ?? wamessage.message?.[ct];
        if (!content) return null;
        const stream = await downloadContentFromMessage(
          content,
          (targetType || ct).replace("Message", "")
        );
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        return Buffer.concat(chunks);
      }
      return null;
    } catch (err) {
      console.error("downloadMediaFromMsg error:", err);
      return null;
    } finally {
      this.mediaSemaphore.release();
    }
  }

  // ===== synchronous lightweight serializer =====
  serializeSync(msg) {
    const key = msg.key || {};
    const from = key.remoteJid || key.remoteJidAlt || "";
    const fromMe = !!key.fromMe;
    const sender = jidNormalizedUser(
      key.participant || key.participantAlt || from
    );
    const isGroup = String(from).endsWith("@g.us");
    const pushName = msg.pushName || "Unknown";
    const messageRoot = msg.message ?? {};
    const type = (() => {
      try {
        return getContentType(messageRoot);
      } catch (e) {
        return Object.keys(messageRoot)[0] || "unknown";
      }
    })();
    const content = messageRoot?.[type] ?? null;

    const extractBody = () => {
      if (!content) return "";
      if (type === "conversation") return content;
      if (type === "extendedTextMessage") return content?.text || "";
      if (type === "imageMessage" || type === "videoMessage")
        return content?.caption || "";
      if (type === "templateButtonReplyMessage")
        return content?.selectedDisplayText || "";
      if (type === "buttonsResponseMessage")
        return content?.selectedButtonId || "";
      if (type === "listResponseMessage")
        return content?.singleSelectReply?.selectedRowId || "";
      return content?.caption || content?.text || "";
    };

    const isFromMe =
      fromMe ||
      areJidsSameUser(sender, jidNormalizedUser(this.conn.user?.id || "")) ||
      (this.conn.user?.lid &&
        areJidsSameUser(sender, jidNormalizedUser(this.conn.user.lid)));

    const msgObj = {
      raw: msg,
      client: this.client,
      conn: this.conn,
      key,
      id: key.id,
      from,
      fromMe,
      sender,
      isGroup,
      isFromMe,
      pushName,
      type,
      body: extractBody(),
      content,
      quoted: (() => {
        const context = msg.message?.extendedTextMessage?.contextInfo;
        if (!context || !context.quotedMessage) return null;
        const quotedMsg = context.quotedMessage;
        const qt = (() => {
          try {
            return getContentType(quotedMsg);
          } catch (e) {
            return Object.keys(quotedMsg)[0] || "unknown";
          }
        })();
        const qContent = quotedMsg[qt];
        const body =
          qt === "conversation"
            ? qContent
            : qt === "extendedTextMessage"
            ? qContent?.text || ""
            : qContent?.caption || "";
        const quotedParticipant = jidNormalizedUser(
          context.participant || context.participantAlt || from
        );
        const quotedFromMe =
          areJidsSameUser(
            quotedParticipant,
            jidNormalizedUser(this.conn.user?.id || "")
          ) ||
          (this.conn.user?.lid &&
            areJidsSameUser(
              quotedParticipant,
              jidNormalizedUser(this.conn.user.lid)
            ));
        return {
          type: qt,
          msg: qContent,
          body,
          fromMe: quotedFromMe,
          participant: quotedParticipant,
          id: context.stanzaId,
          key: {
            remoteJid: from,
            fromMe: quotedFromMe,
            id: context.stanzaId,
            participant: quotedParticipant,
          },
        };
      })(),
      mentions:
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [],

      // group placeholders
      groupMetadata: null,
      groupParticipants: null,
      groupAdmins: null,
      groupOwner: null,
      isAdmin: false,
      isBotAdmin: false,
    };

    // --- group helpers (lazy) ---
    msgObj.getParticipants = () => msgObj.groupParticipants || [];
    msgObj.isParticipant = (jid) => {
      const normalized = jidNormalizedUser(jid);
      return (msgObj.getParticipants() || []).some((p) =>
        areJidsSameUser(jidNormalizedUser(p.id), normalized)
      );
    };

    msgObj.loadGroupInfo = async () => {
      if (!msgObj.isGroup) return msgObj;
      const cacheKey = `group:${msgObj.from}:meta`;

      // try external cache first (if provided)
      if (this.cacheModule && typeof this.cacheModule.get === "function") {
        try {
          const cachedRaw = await this.cacheModule.get(cacheKey);
          if (cachedRaw) {
            try {
              const parsed = JSON.parse(cachedRaw);
              Object.assign(msgObj, parsed);
              return msgObj;
            } catch (e) {
              msgObj.groupMetadata = cachedRaw; /* fallback */
            }
          }
        } catch (e) {
          /* ignore cache errors */
        }
      } else {
        const cached = this.groupCache.get(cacheKey);
        if (cached) {
          Object.assign(msgObj, cached);
          return msgObj;
        }
      }

      try {
        const meta = await this.conn.groupMetadata(msgObj.from);
        msgObj.groupMetadata = meta;
        msgObj.groupParticipants = meta?.participants ?? [];
        msgObj.groupAdmins = (msgObj.groupParticipants || [])
          .filter((p) => p.admin === "admin" || p.admin === "superadmin")
          .map((p) => jidNormalizedUser(p.id));
        msgObj.groupOwner = meta?.owner
          ? jidNormalizedUser(meta.owner)
          : msgObj.groupAdmins[0] ?? null;
        msgObj.joinApprovalMode = meta?.joinApprovalMode ?? false;
        msgObj.memberAddMode = meta?.memberAddMode ?? false;
        msgObj.announce = meta?.announce ?? false;
        msgObj.restrict = meta?.restrict ?? false;
        msgObj.isAdmin = (msgObj.groupAdmins || []).some((adminId) =>
          areJidsSameUser(
            jidNormalizedUser(adminId),
            jidNormalizedUser(msgObj.sender)
          )
        );
        const botJid = jidNormalizedUser(this.conn.user?.id || "");
        const botLid = this.conn.user?.lid
          ? jidNormalizedUser(this.conn.user.lid)
          : null;
        msgObj.isBotAdmin = (msgObj.groupAdmins || []).some(
          (adminId) =>
            areJidsSameUser(jidNormalizedUser(adminId), botJid) ||
            (botLid && areJidsSameUser(jidNormalizedUser(adminId), botLid))
        );

        msgObj.botJid = () => botJid;

        const toCache = {
          groupMetadata: msgObj.groupMetadata,
          groupParticipants: msgObj.groupParticipants,
          groupAdmins: msgObj.groupAdmins,
          groupOwner: msgObj.groupOwner,
          joinApprovalMode: msgObj.joinApprovalMode,
          memberAddMode: msgObj.memberAddMode,
          announce: msgObj.announce,
          restrict: msgObj.restrict,
        };

        if (this.cacheModule && typeof this.cacheModule.set === "function") {
          try {
            await this.cacheModule.set(cacheKey, JSON.stringify(toCache), 300);
          } catch (e) {
            /* ignore */
          }
        } else {
          this.groupCache.set(cacheKey, toCache, 300);
        }
      } catch (err) {
        console.error("Error loading group info:", err);
      }
      return msgObj;
    };

    // --- download media lazy ---
    msgObj.download = async () => {
      try {
        const ct = getContentType(msg.message ?? {});
        const contentObj = msg.message?.[ct] ?? null;
        if (!contentObj) return null;
        return await this._downloadMediaFromMsg(msg, ct.replace("Message", ""));
      } catch (err) {
        console.error("msgObj.download error:", err);
        return null;
      }
    };

    // --- sending / replying ---
    msgObj.send = async (payload, options = {}) => {
      try {
        if (payload?.delete)
          return await this.conn.sendMessage(msgObj.from, {
            delete: payload.delete,
          });
        let cend;
        if (typeof payload === "string") cend = { text: payload };
        else if (payload.video)
          cend = {
            video: payload.video,
            caption: payload.caption || "",
            mimetype: payload.mimetype || "video/mp4",
          };
        else if (payload.image)
          cend = { image: payload.image, caption: payload.caption || "" };
        else if (payload.audio)
          cend = {
            audio: payload.audio,
            mimetype: payload.mimetype || "audio/mp4",
            ptt: payload.ptt || false,
          };
        else cend = payload;

        if (options.edit) cend.edit = options.edit;
        if (options.quoted) {
          const quotedObj = options.quoted?.raw ?? options.quoted ?? msgObj.raw;
          return await this.conn.sendMessage(msgObj.from, cend, {
            quoted: quotedObj,
          });
        }
        return await this.conn.sendMessage(msgObj.from, cend);
      } catch (err) {
        console.error("msgObj.send error:", err);
        return null;
      }
    };

    const replyMethod = async (payload, options = {}) => {
      return await msgObj.send(payload, {
        ...options,
        quoted: options.quoted ?? msgObj.raw,
      });
    };
    msgObj.reply = replyMethod;
    msgObj.sendReply = replyMethod;
    msgObj.sendreply = replyMethod;

    // --- react (like old code) ---
    msgObj.react = async (emoji) => {
      try {
        return await this.conn.sendMessage(msgObj.from, {
          react: { text: emoji, key: msgObj.key },
        });
      } catch (err) {
        console.error("Error reacting:", err);
        return null;
      }
    };

    // --- sendFromUrl (uses axios) ---
    msgObj.sendFromUrl = async (url, opts = {}) => {
      try {
        const buffer = await this._safeFetchBuffer(url);
        if (opts.asSticker) return await msgObj.send({ sticker: buffer });
        if (opts.asDocument)
          return await msgObj.send({
            document: buffer,
            mimetype: opts.mimetype || "application/octet-stream",
            fileName: opts.fileName || "file",
          });
        if (opts.asVideo)
          return await msgObj.send({
            video: buffer,
            caption: opts.caption || "",
          });
        if (opts.asAudio)
          return await msgObj.send({
            audio: buffer,
            mimetype: "audio/mp4",
            ptt: opts.ptt || false,
          });
        return await msgObj.send({
          image: buffer,
          caption: opts.caption || "",
        });
      } catch (err) {
        console.error("sendFromUrl error:", err);
        return null;
      }
    };

    // --- profile picture set (keeps makePp) ---
    msgObj.setPp = async (jid, buf) => {
      try {
        if (typeof this.conn.updateProfilePicture === "function") {
          const { img } = await makePp(buf);
          return await this.conn
            .updateProfilePicture(jidNormalizedUser(jid), img)
            .catch(() => null);
        }
        const { img } = await makePp(buf);
        await this.conn.query({
          tag: "iq",
          attrs: {
            to: jidNormalizedUser(jid),
            type: "set",
            xmlns: "w:profile:picture",
          },
          content: [{ tag: "picture", attrs: { type: "image" }, content: img }],
        });
        return true;
      } catch (err) {
        console.error("setPp error:", err);
        return null;
      }
    };

    // --- LID / PN helpers ---
    msgObj.getLID = async (phoneNumber) => {
      try {
        if (!this.conn?.signalRepository?.lidMapping) return null;
        return await this.conn.signalRepository.lidMapping.getLIDForPN(
          phoneNumber
        );
      } catch (err) {
        console.error("getLID error:", err);
        return null;
      }
    };
    msgObj.getPN = async (lid) => {
      try {
        if (!this.conn?.signalRepository?.lidMapping) return null;
        return await this.conn.signalRepository.lidMapping.getPNForLID(lid);
      } catch (err) {
        console.error("getPN error:", err);
        return null;
      }
    };
    msgObj.isPnUser = (jid) => jid?.includes("@s.whatsapp.net") || false;
    msgObj.isLidUser = (jid) => jid?.includes("@lid") || false;
    msgObj.areJidsSame = (jid1, jid2) =>
      areJidsSameUser(jidNormalizedUser(jid1), jidNormalizedUser(jid2));

    // --- block/unblock/fetchStatus/profilePictureUrl ---
    msgObj.fetchStatus = async (jid) => {
      try {
        return await this.conn.fetchStatus(jidNormalizedUser(jid));
      } catch (err) {
        console.error("fetchStatus error:", err);
        return null;
      }
    };
    msgObj.profilePictureUrl = async (jid, type = "image") => {
      try {
        return await this.conn.profilePictureUrl(jidNormalizedUser(jid), type);
      } catch (err) {
        console.error("profilePictureUrl error:", err);
        return null;
      }
    };
    msgObj.blockUser = async (jid) => {
      try {
        return await this.conn.updateBlockStatus(
          jidNormalizedUser(jid),
          "block"
        );
      } catch (err) {
        console.error("blockUser error:", err);
        return null;
      }
    };
    msgObj.unblockUser = async (jid) => {
      try {
        return await this.conn.updateBlockStatus(
          jidNormalizedUser(jid),
          "unblock"
        );
      } catch (err) {
        console.error("unblockUser error:", err);
        return null;
      }
    };

    // --- group management / invites / join requests (added to match old code) ---
    msgObj.muteGroup = async () => {
      try {
        return await this.conn.groupSettingUpdate(msgObj.from, "announcement");
      } catch (err) {
        console.error("muteGroup error:", err);
        return null;
      }
    };
    msgObj.unmuteGroup = async () => {
      try {
        return await this.conn.groupSettingUpdate(
          msgObj.from,
          "not_announcement"
        );
      } catch (err) {
        console.error("unmuteGroup error:", err);
        return null;
      }
    };
    msgObj.setSubject = async (text) => {
      try {
        return await this.conn.groupUpdateSubject(msgObj.from, text);
      } catch (err) {
        console.error("setSubject error:", err);
        return null;
      }
    };
    msgObj.setDescription = async (text) => {
      try {
        return await this.conn.groupUpdateDescription(msgObj.from, text);
      } catch (err) {
        console.error("setDescription error:", err);
        return null;
      }
    };
    msgObj.leaveGroup = async () => {
      try {
        return await this.conn.groupLeave(msgObj.from);
      } catch (err) {
        console.error("leaveGroup error:", err);
        return null;
      }
    };

    msgObj.inviteCode = async () => {
      try {
        return await this.conn.groupInviteCode(msgObj.from);
      } catch (err) {
        console.error("inviteCode error:", err);
        return null;
      }
    };
    msgObj.revokeInvite = async () => {
      try {
        return await this.conn.groupRevokeInvite(msgObj.from);
      } catch (err) {
        console.error("revokeInvite error:", err);
        return null;
      }
    };
    msgObj.getInviteInfo = async (code) => {
      try {
        return await this.conn.groupGetInviteInfo(code);
      } catch (err) {
        console.error("getInviteInfo error:", err);
        return null;
      }
    };
    msgObj.joinViaInvite = async (code) => {
      try {
        return await this.conn.groupAcceptInvite(code);
      } catch (err) {
        console.error("joinViaInvite error:", err);
        return null;
      }
    };

    msgObj.getJoinRequests = async () => {
      try {
        return await this.conn.groupRequestParticipantsList(msgObj.from);
      } catch (err) {
        console.error("getJoinRequests error:", err);
        return null;
      }
    };
    msgObj.updateJoinRequests = async (jids, action = "approve") => {
      try {
        const normalized = Array.isArray(jids)
          ? jids.map((j) => jidNormalizedUser(j))
          : [jidNormalizedUser(jids)];
        return await this.conn.groupRequestParticipantsUpdate(
          msgObj.from,
          normalized,
          action
        );
      } catch (err) {
        console.error("updateJoinRequests error:", err);
        return null;
      }
    };
    msgObj.setMemberAddMode = async (enable = true) => {
      try {
        return await this.conn.groupSettingUpdate(
          msgObj.from,
          enable ? "not_announcement" : "announcement"
        );
      } catch (err) {
        console.error("setMemberAddMode error:", err);
        return null;
      }
    };

    // --- participant helpers (add/remove/promote/demote) ---
    msgObj.addParticipant = async (jids) => {
      try {
        const normalized = Array.isArray(jids)
          ? jids.map((j) => jidNormalizedUser(j))
          : [jidNormalizedUser(jids)];
        if (typeof this.conn.groupParticipantsUpdate === "function")
          return await this.conn.groupParticipantsUpdate(
            msgObj.from,
            normalized,
            "add"
          );
        if (typeof this.conn.groupAdd === "function")
          return await this.conn.groupAdd(msgObj.from, normalized);
        return null;
      } catch (err) {
        console.error("addParticipant error:", err);
        return null;
      }
    };
    msgObj.removeParticipant = async (jids) => {
      try {
        const normalized = Array.isArray(jids)
          ? jids.map((j) => jidNormalizedUser(j))
          : [jidNormalizedUser(jids)];
        if (typeof this.conn.groupParticipantsUpdate === "function")
          return await this.conn.groupParticipantsUpdate(
            msgObj.from,
            normalized,
            "remove"
          );
        if (typeof this.conn.groupRemove === "function")
          return await this.conn.groupRemove(msgObj.from, normalized);
        return null;
      } catch (err) {
        console.error("removeParticipant error:", err);
        return null;
      }
    };
    msgObj.promoteParticipant = async (jids) => {
      try {
        const normalized = Array.isArray(jids)
          ? jids.map((j) => jidNormalizedUser(j))
          : [jidNormalizedUser(jids)];
        if (typeof this.conn.groupParticipantsUpdate === "function")
          return await this.conn.groupParticipantsUpdate(
            msgObj.from,
            normalized,
            "promote"
          );
        if (typeof this.conn.groupPromote === "function")
          return await this.conn.groupPromote(msgObj.from, normalized);
        return null;
      } catch (err) {
        console.error("promoteParticipant error:", err);
        return null;
      }
    };
    msgObj.demoteParticipant = async (jids) => {
      try {
        const normalized = Array.isArray(jids)
          ? jids.map((j) => jidNormalizedUser(j))
          : [jidNormalizedUser(jids)];
        if (typeof this.conn.groupParticipantsUpdate === "function")
          return await this.conn.groupParticipantsUpdate(
            msgObj.from,
            normalized,
            "demote"
          );
        if (typeof this.conn.groupDemote === "function")
          return await this.conn.groupDemote(msgObj.from, normalized);
        return null;
      } catch (err) {
        console.error("demoteParticipant error:", err);
        return null;
      }
    };

    return msgObj;
  }

  // optional async alias kept
  async serialize(msg) {
    return this.serializeSync(msg);
  }
}
