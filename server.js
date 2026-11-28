// ============================================================
// NOVENT Server V9 — Ultimate SaaS + WhatsApp + Admin Dashboard
// ============================================================

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'novent_media');

// 🛡️ محرك اتصال ذكي وقاعدة بيانات
let MONGO_URI = process.env.MONGO_URI ? process.env.MONGO_URI.trim() : '';
MONGO_URI = MONGO_URI.replace(/^["']|["']$/g, '');
if (MONGO_URI && MONGO_URI.includes('://') && MONGO_URI.includes('@')) {
    try {
        const [protocol, rest] = MONGO_URI.split('://');
        const [credentials, host] = rest.split('@');
        if (credentials.includes(':')) {
            const [user, ...passParts] = credentials.split(':');
            const pass = passParts.join(':');
            MONGO_URI = `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}`;
        }
    } catch (e) {}
}
if (MONGO_URI && MONGO_URI.startsWith('mongodb') && !MONGO_URI.includes('authSource=')) {
    MONGO_URI += (MONGO_URI.includes('?') ? '&' : '?') + 'authSource=admin';
}
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_novent_key_2050';

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ==========================================
// 1. قاعدة البيانات والنماذج
// ==========================================
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  subscriptionEndDate: { type: Date, default: null },
  linkedPhone: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 🛡️ نموذج لحفظ جلسة الواتساب في قاعدة البيانات (لحل مشكلة إعادة الربط)
const sessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Session = mongoose.model('Session', sessionSchema);

async function useMongoAuthState() {
  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await Session.findByIdAndUpdate(id, { data: JSON.parse(json) }, { upsert: true });
  };
  const readData = async (id) => {
    try {
      const session = await Session.findById(id);
      if (!session || !session.data) return null;
      return JSON.parse(JSON.stringify(session.data), BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };
  const removeData = async (id) => { await Session.findByIdAndDelete(id); };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

// ==========================================
// 2. مسارات المصادقة للتطبيق (Auth)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const existingUser = await User.findOne({ phone });
    if (existingUser) return res.status(400).json({ message: 'رقم الهاتف مستخدم بالفعل' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const user = await User.create({ name, phone, password: hashedPassword, role: 'user' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ message: 'تم إنشاء الحساب بنجاح', token, user: { id: user._id, name: user.name, phone: user.phone, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'رقم الهاتف أو كلمة المرور غير صحيحة' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.status(200).json({ message: 'تم تسجيل الدخول بنجاح', token, user: { id: user._id, name: user.name, phone: user.phone, role: user.role, subscriptionEndDate: user.subscriptionEndDate } });
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ', error: err.message });
  }
});

// ==========================================
// 3. الباب السري للمدير (Admin Login)
// ==========================================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin', username: ADMIN_USER }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, token });
  } else {
    return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
});

const isAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'غير مصرح' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ message: 'صلاحيات المدير مطلوبة' });
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'توكن غير صالح' });
  }
};

// ==========================================
// 4. مسارات لوحة التحكم (Admin Routes)
// ==========================================
app.get('/api/admin/stats', isAdmin, async (req, res) => {
  const totalUsers = await User.countDocuments();
  const activeUsers = await User.countDocuments({ subscriptionEndDate: { $gt: new Date() } });
  res.json({ totalUsers, activeUsers });
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  const users = await User.find({}, '-password').sort({ createdAt: -1 });
  res.json(users);
});

app.post('/api/admin/renew', isAdmin, async (req, res) => {
  const { phone, days } = req.body;
  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

  const currentEndDate = user.subscriptionEndDate && user.subscriptionEndDate > new Date() 
    ? new Date(user.subscriptionEndDate) : new Date();
  currentEndDate.setDate(currentEndDate.getDate() + parseInt(days));
  user.subscriptionEndDate = currentEndDate;
  await user.save();

  if (sock && connectionStatus === 'connected') {
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: `✅ *تم تجديد اشتراكك بنجاح*\nشكراً لك! تم إضافة ${days} يوماً.\nتاريخ الانتهاء الجديد: ${currentEndDate.toISOString().split('T')[0]}` }).catch(()=>{});
  }
  res.json({ message: 'تم التجديد بنجاح', newDate: currentEndDate });
});

app.post('/api/admin/reset-password', isAdmin, async (req, res) => {
  const { phone, newPassword } = req.body;
  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ message: 'المستخدم غير موجود' });

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(newPassword, salt);
  await user.save();
  res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
});

app.post('/api/admin/send-message', isAdmin, async (req, res) => {
  const { phone, message } = req.body;
  if (sock && connectionStatus === 'connected') {
    try {
      await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
      res.json({ success: true, message: 'تم إرسال الرسالة' });
    } catch (e) { res.status(500).json({ success: false, message: 'فشل الإرسال' }); }
  } else {
    res.status(400).json({ message: 'الواتساب غير متصل' });
  }
});

// ==========================================
// 5. كود الواتساب (Baileys)
// ==========================================
let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected'; 
let linkedPhone = null;
let reconnectAttempts = 0;
let isConnecting = false;

const messageStore = new Map();     
const alerts = [];                  
const replyCooldown = new Map();    
const MAX_ALERTS = 100;
const MAX_MESSAGE_STORE = 1000;     
const REPLY_COOLDOWN_MS = 8000;     

function storeKey(remoteJid, id) { return `${remoteJid}:${id}`; }
function extractText(message) {
  if (!message) return null;
  return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || null;
}
function getSenderInfo(msg) {
  const remoteJid = msg.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? msg.key.participant : remoteJid;
  const phone = (senderJid || '').split('@')[0].split(':')[0] || 'unknown';
  const name = msg.pushName || (isGroup ? `عضو (${phone})` : phone);
  return { jid: senderJid, phone, name, isGroup, remoteJid };
}
function addAlert(alert) { alerts.unshift(alert); if (alerts.length > MAX_ALERTS) alerts.pop(); }
function canReply(remoteJid) {
  const now = Date.now(); const last = replyCooldown.get(remoteJid) || 0;
  if (now - last < REPLY_COOLDOWN_MS) return false;
  replyCooldown.set(remoteJid, now); return true;
}
function formatDate(date) { return date.toISOString().split('T')[0]; }
function formatTime(date) { return date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', hour12: true }); }

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    // استخدام قاعدة البيانات لحفظ الجلسة بدلاً من الملفات
    const { state, saveCreds } = await useMongoAuthState();
    
    let version = [2, 3000, 1015901307];
    try { const res = await fetchLatestBaileysVersion(); version = res.version; } catch (e) {}

    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['NOVENT', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { latestQR = qr; connectionStatus = 'awaiting_scan'; linkedPhone = null; console.log('🔄 تم توليد كود QR جديد'); }
      if (connection === 'open') {
        connectionStatus = 'connected'; latestQR = null; reconnectAttempts = 0;
        linkedPhone = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
        console.log(`✅ WhatsApp connected: ${linkedPhone}`);
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        latestQR = null; linkedPhone = null;
        if (statusCode === DisconnectReason.loggedOut) { connectionStatus = 'needs_reauth'; isConnecting = false; }
        else {
          connectionStatus = 'disconnected';
          const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts++), 30000);
          setTimeout(() => { isConnecting = false; connectToWhatsApp().catch(console.error); }, delay);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;

        // 🛠️ التقاط التعديلات والحذف التي تأتي عبر upsert
        if (msg.message.protocolMessage) {
          const protocolMsg = msg.message.protocolMessage;
          const targetId = protocolMsg.key.id;
          const targetJid = protocolMsg.key.remoteJid;
          const stored = messageStore.get(storeKey(targetJid, targetId));

          if (protocolMsg.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
            const newText = extractText(protocolMsg.editedMessage);
            if (newText) {
              const senderName = stored?.senderName || msg.pushName || 'غير معروف';
              const senderPhone = stored?.senderPhone || (targetJid || '').split('@')[0];
              const senderJid = stored?.senderJid || targetJid;
              const oldText = stored?.text || '(الرسالة الأصلية غير متوفرة)';
              const now = new Date();

              addAlert({ id: `${targetId}_edit_${Date.now()}`, type: 'EDITED', sender: `${senderName} • ${senderPhone}`, messageText: `من: ${oldText}\nإلى: ${newText}`, timeText: formatTime(now), remoteJid: targetJid, timestamp: Date.now() });

              if (canReply(targetJid)) {
                try {
                  const replyText = `🚫 *تم تعديل رسالة من المحادثة*\n\n📱 *المرسل:* ${senderPhone}\n👤 *الاسم:* ${senderName}\n✉ *الرسالة قبل التعديل:* ${oldText}\n📝 *الرسالة الجديدة:* ${newText}\n🕒 *تاريخ الرسالة:* ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n⚠ *لا يمكنك تعديل الرسائل بعد إرسالها*`;
                  await sock.sendMessage(targetJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
                } catch (e) { console.log('Error replying to edit in upsert:', e.message); }
              }
              if (stored) { stored.text = newText; messageStore.set(storeKey(targetJid, targetId), stored); }
            }
            continue;
          }

          if (protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE) {
             const senderName = stored?.senderName || 'غير معروف';
             const senderPhone = stored?.senderPhone || '';
             const senderJid = stored?.senderJid;
             const now = new Date();
             let mediaLabel = stored?.text || '(النص الأصلي غير متوفر)';

             addAlert({ id: targetId, type: 'DELETED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`, messageText: stored?.text || mediaLabel, timeText: formatTime(now), remoteJid: targetJid, timestamp: Date.now() });

             if (canReply(targetJid)) {
               try {
                 const replyText = `❌ *تم حذف رسالة من المحادثة*\n\n📱 *المرسل:* ${senderPhone || 'غير معروف'}\n👤 *الاسم:* ${senderName}\n✉ *الرسالة قبل الحذف:* ${mediaLabel}\n🕒 *تاريخ الرسالة:*  ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n⚠ *يرجى عدم حذف أي رسالة*`;
                 await sock.sendMessage(targetJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
               } catch (e) { }
             }
             if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) fs.unlinkSync(stored.mediaPath);
             messageStore.delete(storeKey(targetJid, targetId));
             continue;
          }
          continue; 
        }

        // معالجة الرسائل العادية
        const text = extractText(msg.message);
        const isImage = !!msg.message.imageMessage; const isVideo = !!msg.message.videoMessage; const isAudio = !!msg.message.audioMessage; const isDocument = !!msg.message.documentMessage; const isSticker = !!msg.message.stickerMessage;
        if (!text && !isImage && !isVideo && !isAudio && !isDocument && !isSticker) continue;
        const { jid, phone, name, isGroup, remoteJid } = getSenderInfo(msg);
        const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000;
        let mediaPath = null; let mediaType = '';

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

        messageStore.set(storeKey(remoteJid, msg.key.id), { text: text || (isImage ? 'صورة' : isVideo ? 'فيديو' : isAudio ? 'تسجيل صوتي' : 'ملف'), mediaType, mediaPath, senderJid: jid, senderPhone: phone, senderName: name, isGroup, remoteJid, timestamp });
        if (messageStore.size > MAX_MESSAGE_STORE) { const oldestKey = messageStore.keys().next().value; const oldestData = messageStore.get(oldestKey); if (oldestData?.mediaPath && fs.existsSync(oldestData.mediaPath)) fs.unlinkSync(oldestData.mediaPath); messageStore.delete(oldestKey); }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const { key, update: upd } = update;
        if (!key || !upd) continue;
        
        const originalId = upd.message?.protocolMessage?.key?.id || key.id;
        const remoteJid = upd.message?.protocolMessage?.key?.remoteJid || key.remoteJid;
        const stored = messageStore.get(storeKey(remoteJid, originalId));

        const isRevoke = upd.messageStubType === proto.WebMessageInfo.StubType.REVOKE || (upd.message?.protocolMessage && upd.message.protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE);
        if (isRevoke) {
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;
          const now = new Date();

          let mediaLabel = stored?.text || '(النص الأصلي غير متوفر)';
          if (stored?.mediaType === 'image') mediaLabel = '📷 صورة (مرفقة بالأسفل)';
          else if (stored?.mediaType === 'video') mediaLabel = '🎥 فيديو (مرفق بالأسفل)';
          else if (stored?.mediaType === 'audio') mediaLabel = '🎙️ رسالة صوتية (مرفقة بالأسفل)';
          else if (stored?.mediaType === 'document') mediaLabel = '📁 ملف (مرفق بالأسفل)';
          else if (stored?.mediaType === 'sticker') mediaLabel = '🖼️ ملصق';

          addAlert({ id: originalId, type: 'DELETED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`, messageText: stored?.text || mediaLabel, timeText: formatTime(now), remoteJid, timestamp: Date.now() });

          if (canReply(remoteJid)) {
            try {
              const replyText = `❌ *تم حذف رسالة من المحادثة*\n\n📱 *المرسل:* ${senderPhone || 'غير معروف'}\n👤 *الاسم:* ${senderName}\n✉ *الرسالة قبل الحذف:* ${mediaLabel}\n🕒 *تاريخ الرسالة:*  ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n⚠ *يرجى عدم حذف أي رسالة*`;
              
              if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) {
                if (stored.mediaType === 'image') await sock.sendMessage(remoteJid, { image: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                else if (stored.mediaType === 'video') await sock.sendMessage(remoteJid, { video: { url: stored.mediaPath }, caption: replyText, mentions: senderJid ? [senderJid] : [] });
                else if (stored.mediaType === 'audio') { await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] }); await sock.sendMessage(remoteJid, { audio: { url: stored.mediaPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true }); }
                else await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
              } else {
                await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
              }
            } catch (e) { console.log('Error replying to delete:', e.message); }
          }
          if (stored?.mediaPath && fs.existsSync(stored.mediaPath)) fs.unlinkSync(stored.mediaPath);
          messageStore.delete(storeKey(remoteJid, originalId));
          continue;
        }

        // 🛠️ التقاط التعديلات التي تأتي عبر التحديث (Update)
        let newText = null;
        if (upd.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
          newText = extractText(upd.message.protocolMessage.editedMessage); 
        } else if (upd.message?.editedMessage) {
          newText = extractText(upd.message.editedMessage.message) || extractText(upd.message.editedMessage);
        }

        if (newText) {
          const senderName = stored?.senderName || 'غير معروف';
          const senderPhone = stored?.senderPhone || '';
          const senderJid = stored?.senderJid;
          const oldText = stored?.text || '(الرسالة الأصلية غير متوفرة)';
          const now = new Date();

          addAlert({ id: `${originalId}_edit_${Date.now()}`, type: 'EDITED', sender: `${senderName}${senderPhone ? ` • ${senderPhone}` : ''}`, messageText: `من: ${oldText}\nإلى: ${newText}`, timeText: formatTime(now), remoteJid, timestamp: Date.now() });

          if (canReply(remoteJid)) {
            try {
              const replyText = `🚫 *تم تعديل رسالة من المحادثة*\n\n📱 *المرسل:* ${senderPhone || 'غير معروف'}\n👤 *الاسم:* ${senderName}\n✉ *الرسالة قبل التعديل:* ${oldText}\n📝 *الرسالة الجديدة:* ${newText}\n🕒 *تاريخ الرسالة:*  ${formatDate(now)} *الساعة:* ${formatTime(now)}\n\n⚠ *لا يمكنك تعديل الرسائل بعد إرسالها*`;
              await sock.sendMessage(remoteJid, { text: replyText, mentions: senderJid ? [senderJid] : [] });
            } catch (e) { console.log('Error replying to edit:', e.message); }
          }
          if (stored) { stored.text = newText; messageStore.set(storeKey(remoteJid, originalId), stored); }
        }
      }
    });

    isConnecting = false;
  } catch (err) {
    isConnecting = false;
    console.error('WhatsApp Connection Error:', err);
    setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
  }
}

// ==========================================
// 6. التنبيهات التلقائية (كل 12 ساعة)
// ==========================================
setInterval(async () => {
  if (connectionStatus !== 'connected') return;
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
  
  const expiringUsers = await User.find({
    subscriptionEndDate: { $gte: new Date(), $lte: threeDaysFromNow }
  });

  for (const user of expiringUsers) {
    try {
      const jid = `${user.phone}@s.whatsapp.net`;
      const msg = `⚠️ *تنبيه هام* ⚠️\n\nعزيزي ${user.name}،\nاشتراكك في NOVENT سينتهي بتاريخ ${formatDate(user.subscriptionEndDate)}.\nيرجى التجديد لتجنب انقطاع الخدمة.`;
      await sock.sendMessage(jid, { text: msg });
    } catch (e) { }
  }
}, 12 * 60 * 60 * 1000);

// ==========================================
// 7. المسارات العامة (QR, Health)
// ==========================================
app.post('/api/logout', async (req, res) => {
  try {
    if (sock && connectionStatus === 'connected') { 
      await sock.logout(); 
      connectionStatus = 'disconnected'; 
      linkedPhone = null; 
      await Session.deleteMany({}); // مسح الجلسة من قاعدة البيانات
      res.json({ success: true, message: 'تم فصل الجهاز' }); 
    }
    else res.json({ success: false, message: 'الجهاز غير متصل بالفعل' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, status: connectionStatus }));

app.get('/qr', async (req, res) => {
  if (connectionStatus === 'connected') return res.send(`<html dir="rtl"><body style="text-align:center;padding:40px"><h2 style="color:green">✅ متصل</h2></body></html>`);
  if (!latestQR) return res.send(`<html dir="rtl"><head><meta http-equiv="refresh" content="2"></head><body style="text-align:center;padding:40px;background:#121A25;color:#00E5FF"><h2>⏳ جاري تهيئة الواتساب...</h2></body></html>`);
  
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
  res.json({ status: connectionStatus === 'connected' ? 'متصل' : 'غير متصل', connectionStatus, linkedPhone, deletedCount: alerts.filter((a) => a.type === 'DELETED').length, editedCount: alerts.filter((a) => a.type === 'EDITED').length, alerts: alerts.slice(0, 50) });
});

app.listen(PORT, () => {
  console.log(`🚀 NOVENT SaaS Server listening on port ${PORT}`);
  connectToWhatsApp().catch(console.error);
});
