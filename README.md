# 🏃 Strava Coach LINE Bot

LINE Bot เชื่อม Strava + วิเคราะห์ด้วย Claude AI

---

## Features
- 🏃 ดูสถิติวันนี้ / สัปดาห์นี้
- 🗓️ สร้างตารางซ้อมอัตโนมัติ
- 📸 ส่งรูป Zepp → วิเคราะห์ Recovery
- 🎯 ติดตามเป้าหมาย
- 💬 ถามตอบอิสระ

---

## วิธีติดตั้ง

### 1. ติดตั้ง dependencies
```bash
npm install
```

### 2. ตั้งค่า Environment Variables
```bash
cp .env.example .env
# แล้วแก้ไขค่าใน .env ให้ครบ
```

### 3. Deploy ขึ้น Render
1. ไปที่ render.com → New Web Service → Build and deploy from GitHub
2. ใส่ Environment Variables จาก .env
3. จะได้ URL เช่น https://strava-line-bot.onrender.com

### 4. ตั้ง Webhook ใน LINE
1. ไปที่ LINE Developers Console
2. Messaging API → Webhook URL
3. ใส่: `https://strava-line-bot.onrender.com/webhook`
4. กด Verify ✅

### 5. สร้าง Rich Menu
```bash
node setup-richmenu.js
```
แล้วอัปโหลดรูป Rich Menu ใน LINE Developers Console

### 6. เชื่อม Strava
- เปิด LINE Bot แล้วพิมพ์ `/connect`
- กดลิงก์ที่ได้ เพื่ออนุญาต Strava
- เสร็จแล้วใช้งานได้เลย! 🎉

---

## โครงสร้างไฟล์
```
strava-line-bot/
├── index.js          # Main server
├── setup-richmenu.js # สร้าง Rich Menu
├── package.json
├── .env.example      # Template ค่า config
└── README.md
```

---

## API Keys ที่ต้องการ

| Key | ได้จากไหน | ฟรีไหม |
|-----|-----------|--------|
| LINE_CHANNEL_ACCESS_TOKEN | developers.line.biz | ✅ ฟรี |
| LINE_CHANNEL_SECRET | developers.line.biz | ✅ ฟรี |
| ANTHROPIC_API_KEY | console.anthropic.com | 💰 จ่ายตามใช้ |
| STRAVA_CLIENT_ID | strava.com/settings/api | ✅ ฟรี |
| STRAVA_CLIENT_SECRET | strava.com/settings/api | ✅ ฟรี |
