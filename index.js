// app.js
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs-extra";
import { fileURLToPath } from "url";
import initializeTelegramBot from "./bot.js";
import { forceLoadPlugins } from "./lib/plugins.js";
//import { createSockAndStart, attachHandlersToSock } from "./lib/client.js";
import eventlogger from "./lib/handier.js";
import { manager, main, db } from "./lib/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// ensure sessions dir exists
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
await fs.mkdirp(SESSIONS_DIR);

// Utility: format pairing code in groups of 4 (AAAA-BBBB-CCCC)
function fmtCode(raw) {
  if (!raw) return raw;
  // remove whitespace then group
  const s = String(raw).replace(/\s+/g, "");
  return s.match(/.{1,4}/g)?.join("-") || s;
}
async function waitForOpen(sock, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sock.ev.off("connection.update", handler);
      reject(new Error("Timed out waiting for connection to open"));
    }, timeoutMs);

    const handler = (update) => {
      const { connection, lastDisconnect } = update || {};

      if (connection === "open") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handler);
        resolve();
        return;
      } else if (connection === "close") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handler);
        const err =
          lastDisconnect?.error || new Error("Connection closed before open");
        reject(err);
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

// Start a session (if not already running)
app.get("/start/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const sock = await manager.start(sid);
    res.json({
      ok: true,
      sessionId: sid,
      running: manager.isRunning(sid),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/pair/:num/", async (req, res) => {
  const sid = req.params.num;
  const phone = sid;

  if (!/^[0-9]{6,15}$/.test(phone)) {
    return res.status(400).json({
      ok: false,
      error: "phone must be digits (E.164 without +), e.g. 919812345678",
    });
  }
  const cleanNumber = String(phone || "").replace(/[^0-9]/g, "");

  try {
    const sock = await manager.start(cleanNumber);
    if (!sock) throw new Error("Failed to create socket");

    try {
      await waitForOpen(sock, 20000);
    } catch (waitErr) {
      // Log but proceed to attempt requestPairingCode once the socket might be usable
      console.warn(`⚠️ [${sid}] waitForOpen warning: ${waitErr.message}`);
    }

    if (!sock.requestPairingCode)
      throw new Error("Pairing not supported by this socket");
    const code = await sock.requestPairingCode(cleanNumber);

    return res.json({
      ok: true,
      sessionId: sid,
      cleanNumber,
      code,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// Stop (graceful close, keep creds)
app.post("/stop/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await manager.stop(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Logout (permanent) - logout + delete creds
app.post("/logout/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await manager.logout(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// list known sessions
app.get("/sessions", (req, res) => {
  res.json({ sessions: manager.list() });
});

// health
app.get("/", (req, res) =>
  res.send("Baileys Multi-session Server (pair-code ready)")
);
// graceful shutdown
process.on("SIGINT", async () => {
  await db.flush();
  await db.close();
  process.exit(0);
});
// -- startup
const PORT = process.env.PORT || 3000;

(async function init() {
  try {
    // ensure lib main is initialized (attaches events, loads plugins) but do NOT auto-start if you want full control
    await main({ autoStartAll: false });

    app.listen(PORT, async () => {
      console.log(`Server listening on ${PORT}`);
   //  eventlogger()
      // start all sessions that were registered in meta (staggered by SessionManager)
      try {
        await manager.startAll();
        await db.ready();
        console.log("Attempted to start registered sessions");
      } catch (e) {
        console.warn("startAll err", e?.message || e);
      }
      try {
        await forceLoadPlugins();
        console.log("🔌 Plugins loaded (startup).");
      } catch (err) {
        console.error("Failed to preload plugins:", err?.message || err);
      }
      try {
        initializeTelegramBot(manager);
      } catch (e) {
        console.warn("bot err", e?.message || e);
      }
    });
  } catch (err) {
    console.error("Initialization error", err);
    process.exit(1);
  }
})();
