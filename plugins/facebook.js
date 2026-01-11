import { Module } from '../lib/plugins.js'
import Facebook from '../lib/Class/facebook.js'

Module({
  command: 'fb',
  package: 'downloader',
  description: 'Download Facebook videos'
})(async (message, match) => {

  // Command reply (no box)
  if (!match) {
    return message.send('❌ Please provide a Facebook URL')
  }

  if (
    !match.includes('facebook.com') &&
    !match.includes('fb.watch')
  ) {
    return message.send('❌ Invalid Facebook URL')
  }

  try {
    const fb = new Facebook()
    const result = await fb.download(match)

    if (result.status !== 200) {
      return message.send(`❌ ${result.message || result.error}`)
    }

    const dls = result.data || {}
    const qualities = Object.keys(dls)

    if (!qualities.length) {
      return message.send('❌ No downloadable video found')
    }

    const qp =
      qualities.find(q => q.toUpperCase().includes('HD')) ||
      qualities[0]

    const downloadUrl = dls[qp]

    await message.send({
      video: { url: downloadUrl },
      caption:
        `🎥 Facebook Video\n` +
        `Quality: ${qp}\n\n` +
        `𝐏ᴏᴡᴇʀᴇᴅ 𝐁Y  𝐑ᴀʙʙɪᴛ Xᴍᴅ Mɪɴɪ`
    })

  } catch (e) {
    console.error(e)
    return message.send('⚠️ Download failed')
  }
})
