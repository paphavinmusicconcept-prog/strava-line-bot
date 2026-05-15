// ===== สคริปต์สร้าง Rich Menu =====
// รันครั้งเดียวหลังจากได้ LINE Token แล้ว
// node setup-richmenu.js

const axios = require("axios");

const LINE_CHANNEL_ACCESS_TOKEN = "YOUR_LINE_CHANNEL_ACCESS_TOKEN";

const headers = {
  Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
};

async function createRichMenu() {
  // 1. สร้าง Rich Menu
  const richMenu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: "Strava Coach Menu",
    chatBarText: "เมนู 🏃",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 421 },
        action: { type: "postback", data: "action=today", displayText: "🏃 สถิติวันนี้" },
      },
      {
        bounds: { x: 833, y: 0, width: 834, height: 421 },
        action: { type: "postback", data: "action=week", displayText: "📅 สรุปสัปดาห์" },
      },
      {
        bounds: { x: 1667, y: 0, width: 833, height: 421 },
        action: { type: "postback", data: "action=plan", displayText: "🗓️ ตารางซ้อม" },
      },
      {
        bounds: { x: 0, y: 421, width: 833, height: 422 },
        action: { type: "postback", data: "action=recovery", displayText: "📸 วิเคราะห์ Recovery" },
      },
      {
        bounds: { x: 833, y: 421, width: 834, height: 422 },
        action: { type: "postback", data: "action=goal", displayText: "🎯 เป้าหมาย" },
      },
      {
        bounds: { x: 1667, y: 421, width: 833, height: 422 },
        action: { type: "postback", data: "action=chat", displayText: "💬 ถามอิสระ" },
      },
    ],
  };

  try {
    // สร้าง Rich Menu
    const createRes = await axios.post(
      "https://api.line.me/v2/bot/richmenu",
      richMenu,
      { headers }
    );
    const richMenuId = createRes.data.richMenuId;
    console.log("✅ สร้าง Rich Menu สำเร็จ! ID:", richMenuId);

    // ตั้งเป็น default
    await axios.post(
      `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
      {},
      { headers }
    );
    console.log("✅ ตั้ง Rich Menu เป็น default สำเร็จ!");
    console.log("");
    console.log("⚠️  อย่าลืมอัปโหลดรูป Rich Menu ด้วยนะคะ!");
    console.log(`   Rich Menu ID: ${richMenuId}`);
    console.log("   ใช้คำสั่ง: node upload-richmenu-image.js " + richMenuId);

    return richMenuId;
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

createRichMenu();
