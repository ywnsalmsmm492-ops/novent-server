// ============================================================
// NOVENT Server — Anti-Delete WhatsApp Monitor (V5 Ultimate)
// ============================================================

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(AUTH_DIR), 'novent_media');

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected'; 
let linkedPhone = null;
let reconnectAttempts = 0;
let isConnecting = false;

const messageStore = new Map();     
const alerts = [];                  
const replyCooldown = new Map();    
const MAX_ALERTS = 200;
const MAX_MESSAGE_STORE = 5000;     
const REPLY_COOLDOWN_MS = 8000;     

function storeKey(remoteJid, id) {
  return `${remoteJid}:${id}`;
}

function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null
  );
}

function getSenderInfo(msg) {
  const remoteJid = msg.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? msg.key.participant : remoteJid;
  const phone = (senderJid || '').split('@')[0].split(':')[0] || 'unknown';
  const name = msg.pushName || (isGroup ? `عضو (${phone})` : phone);
  return { jid: senderJid, phone, name, isGroup, remoteJid };
}

function addAlert(alert) {
  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.pop();
}

function canReply(remoteJid) {
  const now = Date.now();
  const last = replyCooldown.get(remoteJid) || 0;
  if (now - last < REPLY_COOLDOWN_MS) return false;
  replyCooldown.set(remoteJid, now);
  return true;
}

// دوال تنسيق التاريخ والوقت
function formatDate(date) {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function formatTime(date) {
  return date.toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['NOVENT', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        connectionStatus = 'awaiting_scan';
        linkedPhone = null;
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        latestQR = null;
        reconnectAttempts = 0;
        linkedPhone = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
        console.log(`✅ WhatsApp connected: ${linkedPhone}`);
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        latestQR = null;
        linkedPhone = null;

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'needs_reauth';
          isConnecting = false;
        } else {
          connectionStatus = 'disconnected';
          const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts++), 60000);
          setTimeout(() => {
            isConnecting = false;
            connectToWhatsApp().catch(console.error);
          }, delay);
        }
      }
    });

    // استقبال الرسائل الجديدة
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message || msg.message.protocolMessage) continue;

        const text = extractText(msg.message);
        const isImage = !!msg.message.imageMessage;
        const isVideo = !!msg.message.videoMessage;
        const isAudio = !!msg.message.audioMessage;
        const isDocument = !!msg.message.documentMessage;
        const isSticker = !!msg.message.stickerMessage;

        if (!text && !isImage && !isVideo && !isAudio && !isDocument && !isSticker) continue;

        const { jid, phone, name, isGroup, remoteJid } = getSenderInfo(msg);
        const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000;
        let mediaPath = null;
        let mediaType = '';

        if (isImage || isVideo || isAudio || isDocument || isSticker) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const mime = msg.message.imageMessage?.mimetype || msg.message.videoMessage?.mimetype || msg.message.audioMessage?.mimetype || 'application/octet-stream';
            let ext = '.bin';
            if (mime.includes('jpeg')) ext = '.jpg'; else if (mime.includes('png')) ext = '.png'; else if (mime.includes('mp4')) ext = '.mp4'; else if (mime.includes('ogg')) ext = '.ogg'; else if (mime.includes('webp')) ext = '.webp';
            
            if (isImage) { mediaType = 'image'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isVideo) { mediaType = 'video'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isAudio) { mediaType = 'audio'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isDocument) { mediaType = 'document'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isSticker) { mediaType = 'sticker'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }

            if (mediaPath) fs.writeFileSync(mediaPath, buffer);
          } catch (err) {}
        }

        messageStore.set(storeKey(remoteJid, msg.key.id), {
          text: text || (isImage ? 'صورة' : isVideo ? 'فيديو' : isAudio ? 'تسجيل صوتي' : 'ملف'),
          mediaType, mediaPath, senderJid: jid, senderPhone: phone, senderName: name, isGroup, remoteJid, timestamp,
        });
      }
    });

    // كشف الحذف والتعديل
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const { key, update: upd } = update;
        if (!key || !upd) continue;

        const { remoteJid, id } = key;
        const stored = messageStore.get(storeKey(remoteJid, id));

        // ==========================================
        // 1. حالة الحذف (Delete)
        // ==========================================
        const isRevoke = upd.messageStubType === proto.WebMessageInfo.StubType.REVOKE || (upd.message?.protocolMessage && upd.message.protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE);

        if (isRevoke) {
          const originalText = stored?.text || '(النص الأصلي غير متوفر)';
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;
          const now = new Date();

          // إضافة التنبيه للتطبيق
          addAlert({
            id, type: 'DELETED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
            messageText: originalText, timeText: formatTime(now), remoteJid, timestamp: Date.now(),
          });

          if (canReply(remoteJid)) {
            try {
              // الرد المخصص للحذف
              const replyText = `❌ *تم حذف رسالة من المحادثة*\n\n` +
                                `📱 *المرسل:* ${senderPhone || 'غير معروف'}\n` +
                                `👤 *الاسم:* ${senderName}\n` +
                                `✉ *الرسالة قبل الحذف:* ${originalText}\n` +
                                `🕒 *تاريخ الرسالة:*  ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n` +
                                `⚠ *يرجى عدم حذف أي رسالة*`;

              if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                if (stored.mediaType === 'image') await sock.sendMessage(remoteJid, { image: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                else if (stored.mediaType === 'video') await sock.sendMessage(remoteJid, { video: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                else if (stored.mediaType === 'audio') { await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] }); await sock.sendMessage(remoteJid, { audio: { url: stored.mediaPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true }); }
                else await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
              } else {
                await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
              }
            } catch (e) { console.error(e); }
          }

          if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) fs.unlinkSync(stored.mediaPath);
          messageStore.delete(storeKey(remoteJid, id));
        }

        // ==========================================
        // 2. حالة التعديل (Edit)
        // ==========================================
        let newText = null;
        
        // التقاط التعديل بجميع الأشكال
        if (upd.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
          newText = extractText(upd.message.protocolMessage.editedMessage?.message);
        } else if (upd.message?.editedMessage) {
          newText = extractText(upd.message.editedMessage.message) || extractText(upd.message.editedMessage);
        } else if (upd.message?.protocolMessage?.editedMessage) {
          newText = extractText(upd.message.protocolMessage.editedMessage.message);
        }

        // إذا وجدنا نصاً معدلاً (حتى لو لم نجد الرسالة الأصلية)
        if (newText) {
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;
          const oldText = stored?.text || '(الرسالة الأصلية غير متوفرة)';
          const now = new Date();

          // إضافة التنبيه للتطبيق (بدون تغيير شكله)
          addAlert({
            id: `${id}_edit_${Date.now()}`, type: 'EDITED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
            messageText: `من: ${oldText}\nإلى: ${newText}`, timeText: formatTime(now), remoteJid, timestamp: Date.now(),
          });

          if (canReply(remoteJid)) {
            try {
              // الرد المخصص للتعديل
              const replyText = `🚫 *تم تعديل رسالة من المحادثة*\n\n` +
                                `📱 *المرسل:* ${senderPhone || 'غير معروف'}\n` +
                                `👤 *الاسم:* ${senderName}\n` +
                                `✉ *الرسالة قبل التعديل:* ${oldText}\n` +
                                `🕒 *تاريخ الرسالة:*  ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n` +
                                `⚠ *لا يمكنك تعديل الرسائل بعد إرسالها*`;

              await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
            } catch (e) { console.error(e); }
          }

          if (stored) {
            stored.text = newText;
            messageStore.set(storeKey(remoteJid, id), stored);
          }
        }
      }
    });

    isConnecting = false;
  } catch (err) {
    isConnecting = false;
    setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
  }
}

// ==========================================
// مسارات (Routes)
// ==========================================
app.post('/api/logout', async (req, res) => {
  try {
    if (sock && connectionStatus === 'connected') {
      await sock.logout();
      connectionStatus = 'disconnected';
      linkedPhone = null;
      res.json({ success: true, message: 'تم فصل الجهاز بنجاح' });
    } else {
      res.json({ success: false, message: 'الجهاز غير متصل بالفعل' });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, status: connectionStatus }));
app.get('/qr', async (req, res) => {
  if (connectionStatus === 'connected') return res.send(`<html dir="rtl"><body style="text-align:center;padding:40px"><h2 style="color:green">✅ متصل</h2></body></html>`);
  if (!latestQR) return res.send(`<html dir="rtl"><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px"><h2>⏳ جاري التهيئة...</h2></body></html>`);
  const qrImage = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
  
  res.send(`
    <html dir="rtl">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:sans-serif;text-align:center;padding:10px;background:#121A25;margin:0;color:#00E5FF">
      <h2 style="letter-spacing:2px; font-size:16px;">SCAN_TO_LINK</h2>
      <img src="${qrImage}" style="border:4px solid #00E5FF;border-radius:12px;box-shadow:0 0 20px rgba(0,229,255,0.4);max-width:90%" />
      <p style="color:#8892B0;font-size:10px;margin-top:10px;letter-spacing:1px;">AUTO_REFRESH_IN_15S</p>
      <script>setTimeout(()=>location.reload(),15000)</script>
    </body>
    </html>
  `);
});

app.get('/api/dashboard', (req, res) => {
  res.json({
    status: connectionStatus === 'connected' ? 'متصل' : 'غير متصل',
    connectionStatus, linkedPhone,
    deletedCount: alerts.filter((a) => a.type === 'DELETED').length,
    editedCount: alerts.filter((a) => a.type === 'EDITED').length,
    alerts: alerts.slice(0, 50),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 NOVENT server listening on port ${PORT}`);
  connectToWhatsApp().catch(console.error);
});
