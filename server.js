// ============================================================
// NOVENT Server — Anti-Delete WhatsApp Monitor
// ============================================================

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';

// ---------- الحالة العامة ----------
let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected'; // disconnected | awaiting_scan | connected | needs_reauth
let linkedPhone = null;
let reconnectAttempts = 0;
let isConnecting = false;

const messageStore = new Map();     // key: `${remoteJid}:${id}` -> رسالة واردة
const alerts = [];                  // آخر التنبيهات
const replyCooldown = new Map();    // منع تكرار الردود
const MAX_ALERTS = 200;
const MAX_MESSAGE_STORE = 5000;     // حد أقصى لعدد الرسائل المحفوظة
const REPLY_COOLDOWN_MS = 8000;     // 8 ثوانٍ بين كل ردين في نفس المحادثة

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

    // حفظ الاعتمادات فور أي تغيير (ضروري لاستمرارية الجلسة)
    sock.ev.on('creds.update', saveCreds);

    // ---------- تحديث حالة الاتصال ----------
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

    // ---------- حفظ كل رسالة واردة جديدة ----------
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // 🔒 منع الحلقات: لا نعالج رسائل البوت نفسه
        if (msg.key.fromMe) continue;
        // تجاهل الرسائل الفارغة أو رسائل البروتوكول
        if (!msg.message || msg.message.protocolMessage) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const { jid, phone, name, isGroup, remoteJid } = getSenderInfo(msg);
        const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000;

        messageStore.set(storeKey(remoteJid, msg.key.id), {
          text,
          senderJid: jid,
          senderPhone: phone,
          senderName: name,
          isGroup,
          remoteJid,
          timestamp,
        });

        // حد أقصى: احذف الأقدم عند تجاوز الحد
        if (messageStore.size > MAX_MESSAGE_STORE) {
          const oldestKey = messageStore.keys().next().value;
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

        // ----- حالة الحذف -----
        const isRevoke =
          upd.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
          (upd.message?.protocolMessage &&
            upd.message.protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE);

        if (isRevoke) {
          const originalText = stored?.text || '(النص الأصلي غير متوفر — الرسالة أقدم من الذاكرة)';
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

          // إرسال رد تلقائي مع منع التكرار
          if (canReply(remoteJid)) {
            try {
              await sock.sendMessage(remoteJid, {
                text:
                  `🗑️ *تنبيه NOVENT*\n\n` +
                  `تم حذف رسالة من: *${senderName}*\n` +
                  `📝 النص الأصلي:\n${originalText}`,
                mentions: senderJid ? [senderJid] : [],
              });
            } catch (e) {
              console.error('❌ Reply failed:', e.message);
            }
          }

          messageStore.delete(storeKey(remoteJid, id));
        }

        // ----- حالة التعديل -----
        if (upd.message?.editedMessage) {
          const newText =
            extractText(upd.message.editedMessage.message) || '(نص معدل غير معروف)';
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

// 🔋 Health check — يستخدمه Ping خارجي لإبقاء Render مستيقظًا
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: connectionStatus,
    uptime: Math.floor(process.uptime()),
    alerts: alerts.length,
  });
});

// 📱 صفحة QR
app.get('/qr', async (req, res) => {
  try {
    if (connectionStatus === 'connected') {
      return res.send(`
        <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f7fa}</style>
        </head><body>
          <h2 style="color:#0a7a6a">✅ واتساب متصل بالفعل</h2>
          <p>${linkedPhone ? 'الرقم المرتبط: <b>' + linkedPhone + '</b>' : ''}</p>
          <p style="color:#888;font-size:13px;margin-top:30px">لا حاجة لمسح رمز جديد.</p>
        </body></html>
      `);
    }

    if (connectionStatus === 'needs_reauth') {
      return res.send(`
        <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f7fa}</style>
        </head><body>
          <h2 style="color:#c0392b">⚠️ الجلسة انتهت</h2>
          <p>افتح واتساب على هاتفك وامسح رمز QR جديدًا بعد إعادة تشغيل السيرفر.</p>
          <a href="/qr" style="display:inline-block;margin-top:20px;padding:10px 20px;background:#0a3a5a;color:#fff;border-radius:8px;text-decoration:none">تحديث</a>
        </body></html>
      `);
    }

    if (!latestQR) {
      return res.send(`
        <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="3">
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f7fa}</style>
        </head><body>
          <h2>⏳ جاري تهيئة جلسة واتساب...</h2>
          <p>سيظهر رمز QR هنا تلقائيًا خلال ثوانٍ.</p>
        </body></html>
      `);
    }

    const qrImage = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>NOVENT | ربط واتساب</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:20px;background:#f5f7fa;margin:0">
        <h2 style="color:#0a3a5a;margin-top:10px">امسح الرمز من واتساب</h2>
        <p style="color:#555;margin:6px 0 20px">واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</p>
        <img src="${qrImage}" alt="QR"
             style="border:8px solid #fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:90%" />
        <p style="color:#999;font-size:12px;margin-top:24px">تحديث تلقائي كل 15 ثانية</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('QR generation error:', e);
    res.status(500).send('خطأ في توليد رمز QR');
  }
});

// 📊 لوحة المعلومات للتطبيق
app.get('/api/dashboard', (req, res) => {
  const statusMap = {
    connected: 'متصل',
    awaiting_scan: 'بانتظار المسح',
    needs_reauth: 'يحتاج إعادة ربط',
    disconnected: 'غير متصل',
  };

  res.json({
    status: statusMap[connectionStatus] || 'غير متصل',
    connectionStatus,
    linkedPhone,
    deletedCount: alerts.filter((a) => a.type === 'DELETED').length,
    editedCount: alerts.filter((a) => a.type === 'EDITED').length,
    alerts: alerts.slice(0, 50).map((a) => ({
      id: a.id,
      type: a.type,
      sender: a.sender,
      messageText: a.messageText,
      timeText: a.timeText,
    })),
    serverTime: new Date().toISOString(),
  });
});

// نقطة جذر بسيطة
app.get('/', (req, res) => {
  res.send('NOVENT Server is running. Visit /qr to link WhatsApp.');
});

// ============================================================
// التشغيل
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 NOVENT server listening on port ${PORT}`);
  console.log(`📁 Auth directory: ${AUTH_DIR}`);
  connectToWhatsApp().catch(console.error);
});
