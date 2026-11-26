// ============================================================
// NOVENT Server — Anti-Delete WhatsApp Monitor (Text + Image + Video + Audio)
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

// ---------- الحالة العامة ----------
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

// ============================================================
// أدوات مساعدة
// ============================================================

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

// ============================================================
// الاتصال بواتساب
// ============================================================

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
        console.log('📱 QR code available — awaiting scan');
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
          console.log('❌ Session revoked — new QR required');
        } else {
          connectionStatus = 'disconnected';
          const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts++), 60000);
          console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s...`);
          setTimeout(() => {
            isConnecting = false;
            connectToWhatsApp().catch(console.error);
          }, delay);
        }
      }
    });

    // ---------- حفظ الرسائل والوسائط (صور/فيديو/صوت) ----------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message || msg.message.protocolMessage) continue;

        const text = extractText(msg.message);
        const isImage = !!msg.message.imageMessage;
        const isVideo = !!msg.message.videoMessage;
        const isAudio = !!msg.message.audioMessage; // دعم الصوتيات

        if (!text && !isImage && !isVideo && !isAudio) continue;

        const { jid, phone, name, isGroup, remoteJid } = getSenderInfo(msg);
        const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000;
        let mediaPath = null;

        // تحميل الوسائط وحفظها على القرص
        if (isImage || isVideo || isAudio) {
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            const ext = isImage ? '.jpg' : isVideo ? '.mp4' : '.ogg';
            mediaPath = path.join(MEDIA_DIR, `${msg.key.id}${ext}`);
            fs.writeFileSync(mediaPath, buffer);
          } catch (err) {
            console.error('❌ Failed to download media:', err.message);
          }
        }

        messageStore.set(storeKey(remoteJid, msg.key.id), {
          text: text || (isImage ? 'صورة' : isVideo ? 'فيديو' : 'تسجيل صوتي'),
          isImage,
          isVideo,
          isAudio,
          mediaPath,
          senderJid: jid,
          senderPhone: phone,
          senderName: name,
          isGroup,
          remoteJid,
          timestamp,
        });

        if (messageStore.size > MAX_MESSAGE_STORE) {
          const oldestKey = messageStore.keys().next().value;
          const oldestData = messageStore.get(oldestKey);
          if (oldestData?.mediaPath && fs.existsSync(oldestData.mediaPath)) {
            fs.unlinkSync(oldestData.mediaPath);
          }
          messageStore.delete(oldestKey);
        }
      }
    });

    // ---------- كشف الحذف (REVOKE) والتعديل (EDIT) ----------
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const { key, update: upd } = update;
        if (!key || !upd) continue;

        const { remoteJid, id } = key;
        const stored = messageStore.get(storeKey(remoteJid, id));

        // ----- 1. حالة الحذف -----
        const isRevoke =
          upd.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
          (upd.message?.protocolMessage &&
            upd.message.protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE);

        if (isRevoke) {
          const originalText = stored?.text || '(النص الأصلي غير متوفر)';
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;

          addAlert({
            id,
            type: 'DELETED',
            sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
            messageText: originalText,
            timeText: formatTime(new Date()),
            remoteJid,
            timestamp: Date.now(),
          });

          console.log(`🗑️ Deleted by ${senderName}: "${originalText}"`);

          if (canReply(remoteJid)) {
            try {
              const replyText = `🗑️ *تنبيه NOVENT*\n\n` +
                                `تم حذف رسالة من: *${senderName}*\n` +
                                `📝 النص الأصلي:\n${originalText}`;

              // 1. إذا كانت صورة
              if (stored?.isImage && stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                await sock.sendMessage(remoteJid, {
                  image: { url: stored.mediaPath },
                  caption: replyText,
                  mentions: senderJid ? [senderJid] : [],
                });
              } 
              // 2. إذا كانت فيديو
              else if (stored?.isVideo && stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                await sock.sendMessage(remoteJid, {
                  video: { url: stored.mediaPath },
                  caption: replyText,
                  mentions: senderJid ? [senderJid] : [],
                });
              }
              // 3. إذا كانت رسالة صوتية (نرسل النص أولاً ثم الصوت)
              else if (stored?.isAudio && stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                await sock.sendMessage(remoteJid, {
                  text: replyText,
                  mentions: senderJid ? [senderJid] : [],
                });
                await sock.sendMessage(remoteJid, {
                  audio: { url: stored.mediaPath },
                  mimetype: 'audio/ogg; codecs=opus',
                  ptt: true,
                });
              } 
              // 4. إذا كانت نصية
              else {
                await sock.sendMessage(remoteJid, {
                  text: replyText,
                  mentions: senderJid ? [senderJid] : [],
                });
              }
            } catch (e) {
              console.error('❌ Reply failed:', e.message);
            }
          }

          if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
            fs.unlinkSync(stored.mediaPath);
          }
          messageStore.delete(storeKey(remoteJid, id));
        }

        // ----- 2. حالة التعديل (محدثة) -----
        let editedMessageObj = null;
        if (upd.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
          editedMessageObj = upd.message.protocolMessage.editedMessage;
        } else if (upd.message?.editedMessage) {
          editedMessageObj = upd.message.editedMessage;
        } else if (upd.message?.protocolMessage?.editedMessage) {
          editedMessageObj = upd.message.protocolMessage.editedMessage;
        }

        if (editedMessageObj) {
          const newText = extractText(editedMessageObj.message) || extractText(editedMessageObj) || '(نص معدل غير معروف)';
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const oldText = stored?.text || '(النص الأصلي غير متوفر)';

          addAlert({
            id: `${id}_edit_${Date.now()}`,
            type: 'EDITED',
            sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`,
            messageText: `من: ${oldText}\nإلى: ${newText}`,
            timeText: formatTime(new Date()),
            remoteJid,
            timestamp: Date.now(),
          });

          console.log(`✏️ Edited by ${senderName}: "${oldText}" → "${newText}"`);

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
    console.error('❌ connectToWhatsApp error:', err);
    const delay = Math.min(5000 * Math.pow(1.5, reconnectAttempts++), 60000);
    setTimeout(() => connectToWhatsApp().catch(console.error), delay);
  }
}

// ============================================================
// المسارات (Routes)
// ============================================================

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: connectionStatus, uptime: Math.floor(process.uptime()) });
});

app.get('/qr', async (req, res) => {
  try {
    if (connectionStatus === 'connected') {
      return res.send(`<html dir="rtl"><body style="text-align:center;padding:40px;font-family:sans-serif"><h2 style="color:green">✅ واتساب متصل بالفعل</h2><p>${linkedPhone ? 'الرقم: '+linkedPhone : ''}</p></body></html>`);
    }
    if (connectionStatus === 'needs_reauth') {
      return res.send(`<html dir="rtl"><body style="text-align:center;padding:40px;font-family:sans-serif"><h2 style="color:red">⚠️ الجلسة انتهت</h2><p>أعد تشغيل السيرفر وامسح رمز QR جديد.</p><a href="/qr">تحديث</a></body></html>`);
    }
    if (!latestQR) {
      return res.send(`<html dir="rtl"><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>⏳ جاري تهيئة الجلسة...</h2></body></html>`);
    }
    const qrImage = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
    res.send(`
      <html dir="rtl">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:sans-serif;text-align:center;padding:20px;background:#f5f7fa;margin:0">
        <h2 style="color:#0a3a5a;margin-top:10px">امسح الرمز من واتساب</h2>
        <img src="${qrImage}" style="border:8px solid #fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:90%" />
        <script>setTimeout(() => location.reload(), 15000);</script>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(500).send('خطأ في توليد رمز QR');
  }
});

app.get('/api/dashboard', (req, res) => {
  const statusMap = { connected: 'متصل', awaiting_scan: 'بانتظار المسح', needs_reauth: 'يحتاج إعادة ربط', disconnected: 'غير متصل' };
  res.json({
    status: statusMap[connectionStatus] || 'غير متصل',
    connectionStatus,
    linkedPhone,
    deletedCount: alerts.filter((a) => a.type === 'DELETED').length,
    editedCount: alerts.filter((a) => a.type === 'EDITED').length,
    alerts: alerts.slice(0, 50).map((a) => ({ id: a.id, type: a.type, sender: a.sender, messageText: a.messageText, timeText: a.timeText })),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 NOVENT server listening on port ${PORT}`);
  connectToWhatsApp().catch(console.error);
});
