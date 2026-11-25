const http = require("http");

const PORT = process.env.PORT || 3000;

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

  if (req.url === "/api/dashboard") {
    const deletedCount = alerts.filter((a) => a.type === "DELETED").length;
    const editedCount = alerts.filter((a) => a.type === "EDITED").length;

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "متصل",
        deletedCount,
        editedCount,
        alerts
      })
    );
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({ app: "NOVENT", online: true }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NOVENT Cloud Server running on port ${PORT}`);
});
