const http = require("http");

const PORT = process.env.PORT || 3000;

let linkedPhone = null;

const alerts = [
  {
    id: "1",
    type: "DELETED",
    sender: "صرافة الأمل • 771234567",
    messageText: "تم استلام حوالة بمبلغ 120,000 ريال يمني - رقم المرجع #9041",
    timeText: "12:15 ص"
  },
  {
    id: "2",
    type: "EDITED",
    sender: "مجموعة الأسعار • 734567890",
    messageText: "قبل التعديل: سعر الصرف 536 ← بعد التعديل: سعر الصرف 532",
    timeText: "12:50 ص"
  }
];

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/api/dashboard") {
    const deletedCount = alerts.filter((a) => a.type === "DELETED").length;
    const editedCount = alerts.filter((a) => a.type === "EDITED").length;

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "متصل",
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
          res.end(
            JSON.stringify({
              ok: false,
              message: "يرجى إدخال رقم هاتف صحيح"
            })
          );
          return;
        }

        linkedPhone = phone;

        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: true,
            linkedPhone,
            message: `تم ربط الرقم ${linkedPhone} بنجاح`
          })
        );
      } catch (err) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            ok: false,
            message: "صيغة البيانات المرسلة غير صالحة"
          })
        );
      }
    });
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({ app: "NOVENT", online: true, linkedPhone }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NOVENT Cloud Server running on port ${PORT}`);
});
