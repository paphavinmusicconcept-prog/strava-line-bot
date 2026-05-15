const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ===== CONFIG (ใส่ค่าของคุณตรงนี้) =====
const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  SERVER_URL: "https://strava-line-bot-production.up.railway.app",
};

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ===== STRAVA TOKEN STORE (เก็บ token ของแต่ละ user) =====
// Production ควรใช้ database แทน
const stravaTokens = {};
// stravaTokens[lineUserId] = { access_token, refresh_token, expires_at }

// ===== STRAVA HELPERS =====
async function refreshStravaToken(lineUserId) {
  const tokenData = stravaTokens[lineUserId];
  if (!tokenData) return null;

  // ถ้า token ยังไม่หมดอายุ ใช้ได้เลย
  if (tokenData.expires_at > Date.now() / 1000 + 60) {
    return tokenData.access_token;
  }

  // Refresh token
  try {
    const res = await axios.post("https://www.strava.com/oauth/token", {
      client_id: CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token,
    });
    stravaTokens[lineUserId] = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_at: res.data.expires_at,
    };
    return res.data.access_token;
  } catch (e) {
    console.error("Strava refresh error:", e.message);
    return null;
  }
}

async function getStravaActivities(lineUserId, days = 7) {
  const token = await refreshStravaToken(lineUserId);
  if (!token) return null;

  const after = Math.floor((Date.now() - days * 86400000) / 1000);
  const res = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
    headers: { Authorization: `Bearer ${token}` },
    params: { after, per_page: 50 },
  });
  return res.data;
}

function formatActivities(activities, label) {
  if (!activities || activities.length === 0) {
    return `ไม่มีกิจกรรม${label}ค่ะ 😴`;
  }

  const runs = activities.filter((a) => a.type === "Run");
  const totalDistance = runs.reduce((s, a) => s + a.distance, 0) / 1000;
  const totalTime = runs.reduce((s, a) => s + a.moving_time, 0);
  const avgPace = totalTime / 60 / totalDistance;
  const avgPaceMin = Math.floor(avgPace);
  const avgPaceSec = Math.round((avgPace - avgPaceMin) * 60);

  let msg = `🏃 สรุปการวิ่ง${label}\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `📍 จำนวน: ${runs.length} ครั้ง\n`;
  msg += `📏 รวม: ${totalDistance.toFixed(2)} km\n`;
  msg += `⏱ Pace เฉลี่ย: ${avgPaceMin}:${String(avgPaceSec).padStart(2, "0")} /km\n`;
  msg += `🔥 แคลอรี่: ${runs.reduce((s, a) => s + (a.kilojoules || 0), 0).toFixed(0)} kJ\n\n`;

  msg += `📋 รายละเอียด:\n`;
  runs.slice(0, 5).forEach((a) => {
    const dist = (a.distance / 1000).toFixed(2);
    const pace = a.moving_time / 60 / (a.distance / 1000);
    const pMin = Math.floor(pace);
    const pSec = Math.round((pace - pMin) * 60);
    const date = new Date(a.start_date_local).toLocaleDateString("th-TH", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    msg += `• ${date}: ${dist}km @ ${pMin}:${String(pSec).padStart(2, "0")}/km\n`;
  });

  return msg;
}

// ===== CLAUDE HELPERS =====
async function analyzeWithClaude(prompt, imageBase64 = null) {
  const messages = [];

  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: imageBase64,
          },
        },
        { type: "text", text: prompt },
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: `คุณเป็น AI Coach นักวิ่งผู้เชี่ยวชาญ ตอบภาษาไทยเสมอ 
ให้คำแนะนำที่เป็นประโยชน์ กระชับ และ motivate ผู้ใช้
ถ้าวิเคราะห์รูป Recovery จาก Zepp App ให้อ่านค่าต่างๆ แล้วแนะนำแผนซ้อมวันนี้ที่เหมาะสม`,
    messages,
  });

  return res.content[0].text;
}

async function generateTrainingPlan(stravaData, userPrefs = {}) {
  const prompt = `จากข้อมูล Strava ของนักวิ่งด้านล่าง ช่วยสร้างตารางซ้อมสัปดาห์หน้าให้หน่อยค่ะ

ข้อมูลการวิ่ง 4 สัปดาห์ที่ผ่านมา:
${stravaData}

${userPrefs.goal ? `เป้าหมาย: ${userPrefs.goal}` : ""}
${userPrefs.daysPerWeek ? `ซ้อมได้: ${userPrefs.daysPerWeek} วัน/สัปดาห์` : ""}

สร้างตารางซ้อม 7 วัน พร้อมอธิบายสั้นๆ ว่าทำไมถึงแนะนำแบบนี้`;

  return await analyzeWithClaude(prompt);
}

// ===== LINE MESSAGING =====
async function replyMessage(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` },
    }
  );
}

async function pushMessage(userId, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text }],
    },
    {
      headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` },
    }
  );
}

// ===== USER SESSION (เก็บ state การคุย) =====
const userSessions = {};

// ===== WEBHOOK HANDLER =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];

  for (const event of events) {
    const userId = event.source?.userId;
    const replyToken = event.replyToken;

    try {
      // ---- Handle Postback (Rich Menu buttons) ----
      if (event.type === "postback") {
        const data = event.postback.data;

        if (data === "action=today") {
          await pushMessage(userId, "⏳ กำลังดึงข้อมูลจาก Strava...");
          const activities = await getStravaActivities(userId, 1);
          if (!activities) {
            await pushMessage(userId, "❌ ยังไม่ได้เชื่อม Strava นะคะ\nพิมพ์ /connect เพื่อเชื่อมต่อค่ะ");
          } else {
            await pushMessage(userId, formatActivities(activities, "วันนี้"));
          }
        } else if (data === "action=week") {
          await pushMessage(userId, "⏳ กำลังดึงข้อมูลสัปดาห์นี้...");
          const activities = await getStravaActivities(userId, 7);
          if (!activities) {
            await pushMessage(userId, "❌ ยังไม่ได้เชื่อม Strava นะคะ\nพิมพ์ /connect เพื่อเชื่อมต่อค่ะ");
          } else {
            await pushMessage(userId, formatActivities(activities, "สัปดาห์นี้"));
          }
        } else if (data === "action=plan") {
          await pushMessage(userId, "⏳ กำลังสร้างตารางซ้อม...");
          const activities = await getStravaActivities(userId, 28);
          if (!activities) {
            await pushMessage(userId, "❌ ยังไม่ได้เชื่อม Strava นะคะ\nพิมพ์ /connect เพื่อเชื่อมต่อค่ะ");
          } else {
            const summary = formatActivities(activities, "4 สัปดาห์ที่ผ่านมา");
            const plan = await generateTrainingPlan(summary);
            await pushMessage(userId, plan);
          }
        } else if (data === "action=recovery") {
          userSessions[userId] = { waitingFor: "recovery_image" };
          await pushMessage(userId, "📸 ส่งรูป screenshot จาก Zepp App มาได้เลยค่ะ\nจะวิเคราะห์ Recovery และแนะนำแผนซ้อมวันนี้ให้นะคะ 💪");
        } else if (data === "action=goal") {
          userSessions[userId] = { waitingFor: "goal_input" };
          await pushMessage(userId, "🎯 พิมพ์เป้าหมายของคุณได้เลยค่ะ\nเช่น: อยากวิ่ง 100km ต่อเดือน หรือ เตรียมแข่ง Half Marathon ธันวาคมนี้");
        } else if (data === "action=chat") {
          userSessions[userId] = { waitingFor: "free_chat" };
          await pushMessage(userId, "💬 ถามอะไรเกี่ยวกับการวิ่งได้เลยค่ะ! 🏃");
        }
      }

      // ---- Handle Message ----
      if (event.type === "message") {
        const session = userSessions[userId] || {};

        // รูปภาพ → วิเคราะห์ Recovery
        if (event.message.type === "image") {
          await pushMessage(userId, "⏳ กำลังวิเคราะห์ Recovery ของคุณ...");

          // ดึงรูปจาก LINE
          const imgRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
            {
              headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` },
              responseType: "arraybuffer",
            }
          );

          const imageBase64 = Buffer.from(imgRes.data).toString("base64");
          const analysis = await analyzeWithClaude(
            `วิเคราะห์รูป Recovery จาก Zepp App นี้ให้หน่อยค่ะ 
อ่านค่าต่างๆ เช่น Readiness score, BioCharge, HRV, Sleep score หรืออะไรก็ตามที่เห็นในรูป
แล้วแนะนำว่าวันนี้ควรซ้อมแบบไหน หนักหรือเบา หรือควรพัก
ตอบเป็นภาษาไทยนะคะ`,
            imageBase64
          );

          await pushMessage(userId, analysis);
          userSessions[userId] = {};
        }

        // ข้อความ
        else if (event.message.type === "text") {
          const text = event.message.text.trim();

          // Command: เชื่อม Strava
          if (text === "/connect") {
            const authUrl = `https://www.strava.com/oauth/authorize?client_id=${CONFIG.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(`${CONFIG.SERVER_URL}/strava/callback?lineUserId=${userId}`)}&approval_prompt=force&scope=activity:read_all`;
            await pushMessage(userId, `🔗 คลิกลิงก์นี้เพื่อเชื่อม Strava นะคะ:\n${authUrl}`);
          }

          // รอ Goal input
          else if (session.waitingFor === "goal_input") {
            userSessions[userId] = { goal: text };
            const activities = await getStravaActivities(userId, 28);
            const summary = activities ? formatActivities(activities, "4 สัปดาห์ที่ผ่านมา") : "ยังไม่มีข้อมูล Strava";
            const plan = await generateTrainingPlan(summary, { goal: text });
            await pushMessage(userId, plan);
            userSessions[userId] = {};
          }

          // Free chat
          else {
            const response = await analyzeWithClaude(text);
            await pushMessage(userId, response);
          }
        }
      }
   } catch (err) {
  console.error("Event error:", err.message);
  console.error("Event error detail:", JSON.stringify(err.response?.data));
    }
  }
});

// ===== STRAVA OAUTH CALLBACK =====
app.get("/strava/callback", async (req, res) => {
  const { code, lineUserId } = req.query;

  try {
    const tokenRes = await axios.post("https://www.strava.com/oauth/token", {
      client_id: CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    });

    stravaTokens[lineUserId] = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_at: tokenRes.data.expires_at,
    };

    await pushMessage(lineUserId, `✅ เชื่อม Strava สำเร็จแล้วค่ะ!\nยินดีต้อนรับ ${tokenRes.data.athlete.firstname} 🎉\nตอนนี้ใช้ Rich Menu ด้านล่างได้เลยนะคะ 🏃`);

    res.send("<h2>✅ เชื่อม Strava สำเร็จแล้ว! กลับไปที่ LINE ได้เลยค่ะ</h2>");
  } catch (err) {
    console.error("Strava OAuth error:", err.message);
    res.send("<h2>❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง</h2>");
  }
});

// ===== START SERVER =====
app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`🚀 Bot running on port ${process.env.PORT || 3000}`);
});
