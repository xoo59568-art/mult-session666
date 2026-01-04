// createSocket.js - FIXED VERSION (updated to use per-session group cache)
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs/promises";
import * as groupCache from "./group-cache.js"; // per-session cache

export async function createSocket(sessionId) {
  const sessionsDir = path.join(process.cwd(), "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionPath = path.join(sessionsDir, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  console.log(
    `[${sessionId}] Creating socket with Baileys v${version.join(".")}`
  );

  const sessionCache = groupCache.forSession(sessionId);

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    // integrate Baileys' cachedGroupMetadata with our per-session cache
    cachedGroupMetadata: async (jid) => {
      try {
        const md = sessionCache.getCached(jid);
        return md ?? null;
      } catch {
        return null;
      }
    },
  });

  // tag socket with sessionId and enable credential save
  sock.sessionId = sessionId;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log(`[${sessionId}] QR code generated`);
    }
    if (connection === "connecting") {
      console.log(`[${sessionId}] Connecting...`);
    }
    if (connection === "open") {
      console.log(`[${sessionId}] ✅ Connection opened successfully`);
      // warm the per-session cache (best-effort)
      try {
        await sessionCache.prefetchAllParticipating(sock);
        console.log(`[${sessionId}] Prefetched participating groups`);
      } catch (e) {
        // ignore prefetch errors
        // console.debug(`[${sessionId}] prefetch failed:`, e?.message || e);
      }
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error;
      console.log(
        `[${sessionId}] Connection closed: ${statusCode} - ${reason}`
      );
    }
  });

  return sock;
}