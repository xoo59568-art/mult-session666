import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import FormData from 'form-data';
import { Module } from '../lib/plugins.js';

// ==================== LINK-ONLY UPLOADER ====================

Module({
  command: "url",
  package: "converter",
  description: "Convert media to URL (upload to Rabbit server)",
})(async (message) => {
  try {
    const quotedMsg = message.quoted || message;
    const mimeType = quotedMsg.content?.mimetype || quotedMsg.type;

    if (!mimeType) {
      return message.send("_Reply to a media file (image, video, audio, document, sticker)_");
    }

    const supportedTypes = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "documentMessage",
      "stickerMessage",
    ];

    if (!supportedTypes.includes(quotedMsg.type)) {
      return message.send("❌ _Unsupported media type_");
    }

    // Download media
    const mediaBuffer = await quotedMsg.download();
    if (!mediaBuffer || mediaBuffer.length === 0) throw new Error("Failed to download media");

    // Create temp file
    const tempFilePath = path.join(os.tmpdir(), `rabbit_upload_${Date.now()}`);
    fs.writeFileSync(tempFilePath, mediaBuffer);

    // Determine extension
    let extension = ".bin";
    const mime = quotedMsg.content?.mimetype || "";

    if (mime.includes("image/jpeg") || quotedMsg.type === "imageMessage") extension = ".jpg";
    else if (mime.includes("image/png")) extension = ".png";
    else if (mime.includes("image/gif")) extension = ".gif";
    else if (mime.includes("image/webp") || quotedMsg.type === "stickerMessage") extension = ".webp";
    else if (mime.includes("video/mp4") || quotedMsg.type === "videoMessage") extension = ".mp4";
    else if (mime.includes("video/mkv")) extension = ".mkv";
    else if (mime.includes("audio/mpeg") || quotedMsg.type === "audioMessage") extension = ".mp3";
    else if (mime.includes("audio/wav")) extension = ".wav";
    else if (mime.includes("audio/ogg")) extension = ".ogg";
    else if (quotedMsg.content?.fileName) extension = path.extname(quotedMsg.content.fileName) || ".bin";

    const fileName = `file_${Date.now()}${extension}`;

    // FormData for upload
    const form = new FormData();
    form.append("fileToUpload", fs.createReadStream(tempFilePath), fileName);
    form.append("reqtype", "fileupload");

    // Upload to Catbox
    const response = await axios.post("https://catbox.moe/user/api.php", form, {
      headers: { ...form.getHeaders() },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // Remove temp file
    fs.unlinkSync(tempFilePath);

    if (!response.data || response.data.includes("error")) {
      throw new Error("Upload failed: " + (response.data || "Unknown error"));
    }

    // Replace Catbox domain with Rabbit domain
    const rabbitLink = response.data.trim().replace("files.catbox.moe", "www.rabbit.zone.id");

    // Send only the link
    await message.send(rabbitLink);

  } catch (error) {
    console.error("URL command error:", error);
    await message.send("❌ _Upload Failed: " + (error.message || "Unknown error") + "_");
  }
});  description: "Upload image to Telegraph",
})(async (message) => {
  try {
    const quotedMsg = message.quoted || message;

    if (quotedMsg.type !== "imageMessage") {
      return message.send("_Reply to an image_");
    }

    await message.react("⏳");
    await message.send("_Uploading to Telegraph..._");

    const mediaBuffer = await quotedMsg.download();
    const tempFilePath = path.join(os.tmpdir(), `telegraph_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, mediaBuffer);

    const form = new FormData();
    form.append("file", fs.createReadStream(tempFilePath));

    const response = await axios.post("https://telegra.ph/upload", form, {
      headers: form.getHeaders(),
    });

    fs.unlinkSync(tempFilePath);

    if (response.data && response.data[0]?.src) {
      const imageUrl = "https://telegra.ph" + response.data[0].src;

      await message.sendreply(
        `✅ *Image Uploaded to Telegraph*\n\n` +
          `*URL:* ${imageUrl}\n\n` +
          `_Permanent link, no expiration_`
      );
      await message.react("✅");
    } else {
      throw new Error("Upload failed");
    }
  } catch (error) {
    console.error("Telegraph command error:", error);
    await message.react("❌");
    await message.send("❌ _Failed to upload to Telegraph_");
  }
});
