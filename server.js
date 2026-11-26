const http = require("http");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;

let linkedPhone = null;
let latestQr = null;
let waStatus = "جاري التهيئة";
let sockInstance = null;

// تخزين آخر الرسائل الواردة مؤقتاً لمعرفة نصها عند الحذف
const messageStore = new Map();

// التنبيهات التي يقرأها تطبيق NOVENT من /api/dashboard
const alerts = [];

function extractMessageText(msg) {
  const m = msg?.message;
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return `[صورة] ${m.imageMessage.caption}`;
  if (m.videoMessage?.caption) return `[فيديو] ${m.videoMessage.caption}`;
  if (m.documentMessage?.caption) return `[مستند] ${m.documentMessage.caption}`;
  return "[رسالة وسائط أو محتوى غير نصي]";
}

function formatTimeNow() {
  return new Date().toLocaleTimeString("ar-YE", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_novent");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["NOVENT", "Chrome", "120.0.0"]
    });

    sockInstance = sock;
    waStatus = "بانتظار مسح الباركود";

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQr = qr;
        waStatus = "بانتظار مسح الباركود";
      }

      if (connection === "open") {
        latestQr = null;
        waStatus = "متصل";
        if (sock.user?.id) {
          linkedPhone = sock.user.id.split(":")[0];
        }
        console.log("NOVENT WhatsApp connected!");
      }

      if (connection === "close") {
        waStatus = "غير متصل";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("WhatsApp connection closed. Reconnect:", shouldReconnect);
        if (shouldReconnect) {
          setTimeout(() => startWhatsApp(), 3000);
        } else {
          latestQr = null;
          waStatus = "تم تسجيل الخروج - أعد المسح";
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.key?.id || !msg.key?.remoteJid) continue;
        if (msg.key.fromMe) continue;

        const chatJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || chatJid;
        const senderNumber = senderJid.split("@")[0];
        const senderName = msg.pushName || senderNumber;
        const text = extractMessageText(msg);

        // حفظ الرسالة قبل أن تُحذف
        messageStore.set(msg.key.id, {
          id: msg.key.id,
          chatJid,
          senderJid,
          senderNumber,
          senderName,
          text,
          timestamp: Date.now()
        });

        // التقاط حدث حذف رسالة (ProtocolMessage نوع 0 = REVOKE)
        const protocolMsg = msg.message?.protocolMessage;
        if (protocolMsg && protocolMsg.type === 0 && protocolMsg.key?.id) {
          const deletedId = protocolMsg.key.id;
          const original = messageStore.get(deletedId);

          const deletedText = original ? original.text : "تعذر العثور على نص الرسالة قبل الحذف";
          const whoName = original ? original.senderName : senderName;
          const whoNumber = original ? original.senderNumber : senderNumber;
          const timeText = formatTimeNow();

          // إضافة تنبيه لتطبيق NOVENT
          alerts.unshift({
            id: String(Date.now()),
            type: "DELETED",
            sender: `${whoName} • ${whoNumber}`,
            messageText: `تم حذف الرسالة: "${deletedText}"`,
            timeText
          });

          // إرسال رد فعلي داخل نفس المحادثة/المجموعة
          try {
            await sock.sendMessage(chatJid, {
              text: `⚡ *NOVENT* كشف حذف رسالة!\nالمُرسِل: *${whoName}*\nالرسالة المحذوفة:\n"${deletedText}"`
            });
          } catch (sendErr) {
            console.error("Failed to send auto-reply:", sendErr);
          }
        }
      }
    });
  } catch (err) {
    waStatus = "خطأ في التهيئة";
    console.error("WhatsApp init error:", err);
    setTimeout(() => startWhatsApp(), 5000);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // صفحة الباركود في المتصفح
  if (req.method === "GET" && req.url === "/qr") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (waStatus === "متصل") {
      res.writeHead(200);
      res.end(`
        <html dir="rtl" lang="ar">
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;">
            <h2>✅ واتساب متصل بنجاح عبر NOVENT</h2>
            <p>الرقم المرتبط: ${linkedPhone || "غير محدد"}</p>
          </body>
        </html>
      `);
      return;
    }

    if (!latestQr) {
      res.writeHead(200);
      res.end(`
        <html dir="rtl" lang="ar">
          <head><meta http-equiv="refresh" content="3"></head>
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff;">
            <h2>⏳ جاري توليد باركود الربط...</h2>
            <p>الحالة الحالية: ${waStatus}</p>
            <p>سيتم تحديث الصفحة تلقائياً كل 3 ثوانٍ</p>
          </body>
        </html>
      `);
      return;
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(latestQr);
      res.writeHead(200);
      res.end(`
        <html dir="rtl" lang="ar">
          <head><meta http-equiv="refresh" content="10"></head>
          <body style="font-family:sans-serif;text-align:center;padding:30px;background:#0f172a;color:#fff;">
            <h2>امسح الباركود لربط واتساب مع NOVENT</h2>
            <p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
            <img src="${qrDataUrl}" style="width:260px;height:260px;background:#fff;padding:12px;border-radius:12px;" />
            <p style="color:#94a3b8;margin-top:16px;">الحالة: ${waStatus}</p>
          </body>
        </html>
      `);
    } catch (e) {
      res.writeHead(500);
      res.end("تعذر عرض الباركود");
    }
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && req.url === "/api/dashboard") {
    const deletedCount = alerts.filter((a) => a.type === "DELETED").length;
    const editedCount = alerts.filter((a) => a.type === "EDITED").length;

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: waStatus,
        linkedPhone,
        deletedCount,
        editedCount,
        alerts
      })
    );
    return;
  }

  if (req.method === "POST" && req.url === "/api/link-number") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const phone = String(parsed.phone || "").trim();

        if (!phone || phone.length < 7) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, message: "يرجى إدخال رقم هاتف صحيح" }));
          return;
        }

        linkedPhone = phone;
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            linkedPhone,
            message: `تم حفظ الرقم ${linkedPhone}، افتح /qr لمسح الباركود`
          })
        );
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, message: "صيغة البيانات المرسلة غير صالحة" }));
      }
    });
    return;
  }

  res.writeHead(200);
  res.end(
    JSON.stringify({
      app: "NOVENT",
      online: true,
      status: waStatus,
      linkedPhone,
      qrPage: "/qr"
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NOVENT Cloud Server running on port ${PORT}`);
  startWhatsApp();
});
