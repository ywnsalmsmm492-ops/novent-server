// ============================================================
// NOVENT Server — Anti-Delete WhatsApp Monitor (V3 Ultimate)
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

    // ============================================================
    // استقبال الرسائل والتعديلات
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        // 🔥 1. فحص التعديلات (يتم فحصها هنا لأن واتساب يرسلها كرسالة جديدة معدلة)
        let newText = null;
        if (msg.message.editedMessage) {
          newText = extractText(msg.message.editedMessage.message);
        } else if (msg.message.protocolMessage?.editedMessage) {
          newText = extractText(msg.message.protocolMessage.editedMessage.message);
        } else if (msg.message.protocolMessage?.type === 14) { // 14 هو رقم تعديل الرسالة في واتساب
          newText = extractText(msg.message.protocolMessage.editedMessage?.message);
        }

        if (newText) {
          const { remoteJid, id } = msg.key;
          const stored = messageStore.get(storeKey(remoteJid, id));
          
          if (stored && !stored.isEditReplied) {
            const senderName = stored.senderName || msg.pushName || 'غير معروف';
            const senderPhone = stored.senderPhone || '';
            const senderJid = stored.senderJid;
            const oldText = stored.text || '(غير متوفر)';

            addAlert({
              id: `${id}_edit_${Date.now()}`,
              type: 'EDITED',
              sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
              messageText: `من: ${oldText}\nإلى: ${newText}`,
              timeText: formatTime(new Date()),
              remoteJid,
              timestamp: Date.now(),
            });

            console.log(`✏️ Edited by ${senderName}: "${oldText}" -> "${newText}"`);

            if (canReply(remoteJid)) {
              try {
                await sock.sendMessage(remoteJid, {
                  text: `✏️ *تنبيه NOVENT*\n\nتم تعديل رسالة من: *${senderName}*\n\n📝 *قبل:* ${oldText}\n📝 *بعد:* ${newText}`,
                  mentions: senderJid ? [senderJid] : [],
                });
              } catch (e) { }
            }

            stored.text = newText;
            stored.isEditReplied = true;
            messageStore.set(storeKey(remoteJid, id), stored);
          }
          continue; 
        }

        // 🔥 2. استقبال رسالة جديدة
        if (msg.message.protocolMessage) continue; // تجاهل رسائل النظام

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
            const buffer = await downloadMediaMessage(
              msg, 'buffer', {},
              { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            
            const mime = msg.message.imageMessage?.mimetype || msg.message.videoMessage?.mimetype || msg.message.audioMessage?.mimetype || 'application/octet-stream';
            let ext = '.bin';
            if (mime.includes('jpeg')) ext = '.jpg';
            else if (mime.includes('png')) ext = '.png';
            else if (mime.includes('mp4')) ext = '.mp4';
            else if (mime.includes('ogg')) ext = '.ogg';
            else if (mime.includes('webp')) ext = '.webp';

            if (isImage) { mediaType = 'image'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isVideo) { mediaType = 'video'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isAudio) { mediaType = 'audio'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isDocument) { mediaType = 'document'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }
            else if (isSticker) { mediaType = 'sticker'; mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`); }

            if (mediaPath) fs.writeFileSync(mediaPath, buffer);
          } catch (err) {
            console.error('❌ Failed to download media:', err.message);
          }
        }

        messageStore.set(storeKey(remoteJid, msg.key.id), {
          text: text || (isImage ? 'صورة' : isVideo ? 'فيديو' : isAudio ? 'تسجيل صوتي' : 'ملف'),
          mediaType, mediaPath, senderJid: jid, senderPhone: phone, senderName: name, isGroup, remoteJid, timestamp,
          isEditReplied: false
        });

        if (messageStore.size > MAX_MESSAGE_STORE) {
          const oldestKey = messageStore.keys().next().value;
          const oldestData = messageStore.get(oldestKey);
          if (oldestData?.mediaPath && fs.existsSync(oldestData.mediaPath)) fs.unlinkSync(oldestData.mediaPath);
          messageStore.delete(oldestKey);
        }
      }
    });

    // ============================================================
    // كشف الحذف فقط (REVOKE)
    // ============================================================
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const { key, update: upd } = update;
        if (!key || !upd) continue;

        const { remoteJid, id } = key;
        const stored = messageStore.get(storeKey(remoteJid, id));

        const isRevoke =
          upd.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
          (upd.message?.protocolMessage && upd.message.protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE);

        if (isRevoke) {
          const originalText = stored?.text || '(النص الأصلي غير متوفر)';
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;

          addAlert({
            id, type: 'DELETED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
            messageText: originalText, timeText: formatTime(new Date()), remoteJid, timestamp: Date.now(),
          });

          if (canReply(remoteJid)) {
            try {
              const replyText = `🗑️ *تنبيه NOVENT*\n\nتم حذف رسالة من: *${senderName}*\n📝 المحتوى:\n${originalText}`;

              if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                if (stored.mediaType === 'image') {
                  await sock.sendMessage(remoteJid, { image: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                } else if (stored.mediaType === 'video') {
                  await sock.sendMessage(remoteJid, { video: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                } else if (stored.mediaType === 'audio') {
                  await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
                  await sock.sendMessage(remoteJid, { audio: { url: stored.mediaPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
                } else {
                  await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
                }
              } else {
                await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
              }
            } catch (e) { }
          }

          if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) fs.unlinkSync(stored.mediaPath);
          messageStore.delete(storeKey(remoteJid, id));
        }
      }
    });

    isConnecting = false;
  } catch (err) {
    isConnecting = false;
    setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
  }
}

// مسار تسجيل الخروج
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
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, status: connectionStatus }));
app.get('/qr', async (req, res) => {
  if (connectionStatus === 'connected') return res.send(`<html dir="rtl"><body style="text-align:center;padding:40px"><h2 style="color:green">✅ متصل</h2></body></html>`);
  if (!latestQR) return res.send(`<html dir="rtl"><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px"><h2>⏳ جاري التهيئة...</h2></body></html>`);
  const qrImage = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
  res.send(`<html dir="rtl"><body style="text-align:center;padding:20px"><h2>امسح الرمز</h2><img src="${qrImage}" /><script>setTimeout(()=>location.reload(),15000)</script></body></html>`);
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
