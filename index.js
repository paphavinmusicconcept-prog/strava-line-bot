const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY || "054178c360msh11b2a814097d9e9p1eb967jsn28a2218f2488",
  SERVER_URL: "https://strava-line-bot-production.up.railway.app",
};

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ===== DATA STORE =====
const userSessions = {};
const userChallenges = {};
const userActivities = {}; // เก็บ stat จากรูป/GPX
const userPRs = {};
const stravaTokens = {}; // เก็บ Strava token ของ user ที่เชื่อมไว้

// ===== HELPERS =====
function hasStrava(userId) {
  return !!stravaTokens[userId];
}

function saveActivity(userId, activity) {
  if (!userActivities[userId]) userActivities[userId] = [];
  userActivities[userId].unshift(activity);
  if (userActivities[userId].length > 200) userActivities[userId].pop();
}

function getRecentActivities(userId, days = 7) {
  if (!userActivities[userId]) return [];
  const cutoff = Date.now() - days * 86400000;
  return userActivities[userId].filter(a => new Date(a.date).getTime() > cutoff);
}

function calcStatsFromActivities(activities) {
  if (!activities || activities.length === 0) return null;
  const totalDistance = activities.reduce((s, a) => s + (a.distance || 0), 0);
  const totalCalories = activities.reduce((s, a) => s + (a.calories || 0), 0);
  const paces = activities.filter(a => a.pace).map(a => a.pace);
  const avgPaceDecimal = paces.length > 0 ? paces.reduce((s, p) => s + p, 0) / paces.length : 0;
  const avgPaceMin = Math.floor(avgPaceDecimal);
  const avgPaceSec = Math.round((avgPaceDecimal - avgPaceMin) * 60);
  return { count: activities.length, totalDistance, totalCalories, avgPaceMin, avgPaceSec, activities };
}

// ===== STRAVA HELPERS =====
async function refreshStravaToken(lineUserId) {
  const tokenData = stravaTokens[lineUserId];
  if (!tokenData) return null;
  if (tokenData.expires_at > Date.now() / 1000 + 60) return tokenData.access_token;
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

function convertStravaToActivities(stravaData) {
  return stravaData
    .filter(a => a.type === "Run")
    .map(a => {
      const dist = a.distance / 1000;
      const pace = (a.moving_time / 60) / dist;
      return {
        date: a.start_date_local,
        distance: parseFloat(dist.toFixed(2)),
        pace: parseFloat(pace.toFixed(4)),
        duration: parseFloat((a.moving_time / 60).toFixed(1)),
        calories: a.kilojoules || 0,
        elevGain: a.total_elevation_gain || 0,
        source: "Strava",
        name: a.name,
      };
    });
}

async function getActivitiesForUser(userId, days = 7) {
  if (hasStrava(userId)) {
    const stravaData = await getStravaActivities(userId, days);
    if (stravaData) return convertStravaToActivities(stravaData);
  }
  return getRecentActivities(userId, days);
}

// ===== PR CHECKER =====
function checkPR(userId, activity) {
  if (!userPRs[userId]) userPRs[userId] = { longestRun: 0, fastestPace: 9999 };
  const pr = userPRs[userId];
  const prs = [];
  if (activity.distance && activity.distance > pr.longestRun) {
    prs.push(`🏅 PR ระยะทาง! ${activity.distance.toFixed(2)}km (เดิม ${pr.longestRun.toFixed(2)}km)`);
    pr.longestRun = activity.distance;
  }
  if (activity.pace && activity.pace > 0 && activity.pace < pr.fastestPace) {
    const pMin = Math.floor(activity.pace);
    const pSec = Math.round((activity.pace - pMin) * 60);
    const oldMin = Math.floor(pr.fastestPace);
    const oldSec = Math.round((pr.fastestPace - oldMin) * 60);
    prs.push(`⚡ PR Pace! ${pMin}:${String(pSec).padStart(2,"0")}/km (เดิม ${oldMin}:${String(oldSec).padStart(2,"0")}/km)`);
    pr.fastestPace = activity.pace;
  }
  return prs.length > 0 ? prs : null;
}

// ===== GPX PARSER =====
function parseGPX(xmlText) {
  try {
    const points = [];
    const trkptRegex = /<trkpt lat="([\d.-]+)" lon="([\d.-]+)"[^>]*>[\s\S]*?<ele>([\d.]+)<\/ele>[\s\S]*?<time>([^<]+)<\/time>/g;
    let match;
    while ((match = trkptRegex.exec(xmlText)) !== null) {
      points.push({ lat: parseFloat(match[1]), lon: parseFloat(match[2]), ele: parseFloat(match[3]), time: new Date(match[4]) });
    }
    if (points.length < 2) return null;
    let totalDist = 0, totalElevGain = 0;
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i-1], p2 = points[i];
      const R = 6371;
      const dLat = (p2.lat - p1.lat) * Math.PI / 180;
      const dLon = (p2.lon - p1.lon) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(p1.lat*Math.PI/180)*Math.cos(p2.lat*Math.PI/180)*Math.sin(dLon/2)**2;
      totalDist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      if (p2.ele > p1.ele) totalElevGain += p2.ele - p1.ele;
    }
    const duration = (points[points.length-1].time - points[0].time) / 1000 / 60;
    const pace = duration / totalDist;
    return {
      date: points[0].time.toISOString(),
      distance: parseFloat(totalDist.toFixed(2)),
      pace: parseFloat(pace.toFixed(4)),
      duration: parseFloat(duration.toFixed(1)),
      elevGain: parseFloat(totalElevGain.toFixed(0)),
      calories: 0,
      source: "GPX",
    };
  } catch (e) {
    console.error("GPX parse error:", e.message);
    return null;
  }
}

// ===== CLAUDE HELPERS =====
async function analyzeWithClaude(prompt, imageBase64 = null) {
  const messages = [];
  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
        { type: "text", text: prompt },
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    system: `คุณเป็น AI Coach นักวิ่งผู้เชี่ยวชาญ ตอบภาษาไทยเสมอ
ให้คำแนะนำที่เป็นประโยชน์ กระชับ และ motivate ผู้ใช้
เมื่อวิเคราะห์รูปผลการวิ่ง ให้อ่านข้อมูลและ return JSON ในรูปแบบนี้ก่อนเสมอ:
{"distance": 8.5, "pace": 5.5, "duration": 46.75, "calories": 420, "elevGain": 120, "date": "2026-05-16"}
โดย pace ให้เป็นตัวเลขทศนิยม เช่น 5:30/km = 5.5
แล้วค่อยให้ feedback เป็นภาษาไทย`,
    messages,
  });
  return res.content[0].text;
}

function extractActivityFromResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*?"distance"[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]);
    if (!data.distance) return null;
    return {
      date: data.date || new Date().toISOString(),
      distance: parseFloat(data.distance) || 0,
      pace: parseFloat(data.pace) || 0,
      duration: parseFloat(data.duration) || 0,
      calories: parseFloat(data.calories) || 0,
      elevGain: parseFloat(data.elevGain) || 0,
      source: "Screenshot",
    };
  } catch (e) { return null; }
}

// ===== FLEX MESSAGE BUILDERS =====
function buildStatsFlexMessage(stats, label) {
  if (!stats) return null;
  const { count, totalDistance, avgPaceMin, avgPaceSec, totalCalories, activities } = stats;
  const activityRows = activities.slice(0, 5).map((a) => {
    const date = new Date(a.date).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });
    const pMin = Math.floor(a.pace || 0);
    const pSec = Math.round(((a.pace || 0) - pMin) * 60);
    return {
      type: "box", layout: "horizontal", paddingTop: "4px",
      contents: [
        { type: "text", text: date, size: "sm", color: "#555555", flex: 3 },
        { type: "text", text: `${(a.distance||0).toFixed(2)}km`, size: "sm", color: "#111111", flex: 2, align: "center" },
        { type: "text", text: a.pace ? `${pMin}:${String(pSec).padStart(2,"0")}/km` : "-", size: "sm", color: "#E8703A", flex: 3, align: "end" },
      ],
    };
  });
  return {
    type: "flex", altText: `🏃 สรุปการวิ่ง${label}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#E8703A", paddingAll: "16px",
        contents: [
          { type: "text", text: "🏃 อาจารย์นักวิ่ง", color: "#ffffff", size: "sm", weight: "bold" },
          { type: "text", text: `สรุปการวิ่ง${label}`, color: "#ffffff99", size: "xs" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          {
            type: "box", layout: "horizontal",
            contents: [
              { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
                { type: "text", text: `${totalDistance.toFixed(1)}`, size: "xl", weight: "bold", color: "#E8703A", align: "center" },
                { type: "text", text: "km รวม", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
                { type: "text", text: `${count}`, size: "xl", weight: "bold", color: "#E8703A", align: "center" },
                { type: "text", text: "ครั้ง", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
                { type: "text", text: avgPaceMin > 0 ? `${avgPaceMin}:${String(avgPaceSec).padStart(2,"0")}` : "-", size: "xl", weight: "bold", color: "#E8703A", align: "center" },
                { type: "text", text: "pace /km", size: "xs", color: "#888888", align: "center" },
              ]},
            ],
            paddingBottom: "12px",
          },
          { type: "separator" },
          {
            type: "box", layout: "horizontal", paddingTop: "12px", paddingBottom: "4px",
            contents: [
              { type: "text", text: "วันที่", size: "xs", color: "#888888", flex: 3 },
              { type: "text", text: "ระยะ", size: "xs", color: "#888888", flex: 2, align: "center" },
              { type: "text", text: "Pace", size: "xs", color: "#888888", flex: 3, align: "end" },
            ],
          },
          ...activityRows,
          { type: "separator", margin: "12px" },
          {
            type: "box", layout: "horizontal", paddingTop: "8px",
            contents: [
              { type: "text", text: "🔥 แคลอรี่รวม", size: "sm", color: "#555555" },
              { type: "text", text: `${totalCalories.toFixed(0)} kcal`, size: "sm", color: "#E8703A", align: "end", weight: "bold" },
            ],
          },
        ],
      },
    },
  };
}

function buildCarouselMessage(activities) {
  const runs = activities.slice(0, 5);
  if (runs.length === 0) return null;
  const bubbles = runs.map((a) => {
    const pMin = Math.floor(a.pace || 0);
    const pSec = Math.round(((a.pace || 0) - pMin) * 60);
    const date = new Date(a.date).toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "short" });
    return {
      type: "bubble", size: "kilo",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#E8703A", paddingAll: "12px",
        contents: [
          { type: "text", text: `📍 ${a.source || "Manual"}`, color: "#ffffff", size: "xs" },
          { type: "text", text: date, color: "#ffffff", size: "sm", weight: "bold", wrap: true },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "12px",
        contents: [
          {
            type: "box", layout: "horizontal", paddingBottom: "8px",
            contents: [
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: `${(a.distance||0).toFixed(2)}`, size: "xxl", weight: "bold", color: "#E8703A", align: "center" },
                { type: "text", text: "km", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: a.pace ? `${pMin}:${String(pSec).padStart(2,"0")}` : "-", size: "xl", weight: "bold", color: "#333333", align: "center" },
                { type: "text", text: "/km", size: "xs", color: "#888888", align: "center" },
              ]},
            ],
          },
          { type: "separator" },
          {
            type: "box", layout: "horizontal", paddingTop: "8px",
            contents: [
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: a.duration ? `${Math.floor(a.duration)}` : "-", size: "sm", color: "#333333", align: "center" },
                { type: "text", text: "นาที", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: a.elevGain ? `${a.elevGain}m` : "-", size: "sm", color: "#333333", align: "center" },
                { type: "text", text: "elevation", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: a.calories ? `${a.calories}` : "-", size: "sm", color: "#333333", align: "center" },
                { type: "text", text: "kcal", size: "xs", color: "#888888", align: "center" },
              ]},
            ],
          },
        ],
      },
    };
  });
  return { type: "flex", altText: "📋 ประวัติวิ่ง 5 ครั้งล่าสุด", contents: { type: "carousel", contents: bubbles } };
}

function buildChallengeFlexMessage(userId, currentKm) {
  const challenge = userChallenges[userId];
  if (!challenge) return null;
  const progress = Math.min((currentKm / challenge.goal) * 100, 100);
  const remaining = Math.max(challenge.goal - currentKm, 0);
  const daysLeft = Math.max(Math.ceil((new Date(challenge.deadline) - new Date()) / 86400000), 0);
  const progressBar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));
  const color = progress >= 100 ? "#27AE60" : progress >= 50 ? "#E8703A" : "#E74C3C";
  return {
    type: "flex", altText: `🎯 Challenge: ${challenge.goal}km`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: color, paddingAll: "16px",
        contents: [
          { type: "text", text: "🎯 Challenge ของคุณ", color: "#ffffff", size: "sm", weight: "bold" },
          { type: "text", text: progress >= 100 ? "🏆 สำเร็จแล้ว!" : `เหลืออีก ${daysLeft} วัน`, color: "#ffffff99", size: "xs" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          {
            type: "box", layout: "horizontal", paddingBottom: "12px",
            contents: [
              { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
                { type: "text", text: `${currentKm.toFixed(1)}`, size: "xxl", weight: "bold", color, align: "center" },
                { type: "text", text: "km วิ่งแล้ว", size: "xs", color: "#888888", align: "center" },
              ]},
              { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
                { type: "text", text: `${challenge.goal}`, size: "xxl", weight: "bold", color: "#333333", align: "center" },
                { type: "text", text: "km เป้าหมาย", size: "xs", color: "#888888", align: "center" },
              ]},
            ],
          },
          { type: "text", text: `${progressBar} ${progress.toFixed(0)}%`, size: "sm", color, align: "center", margin: "md" },
          { type: "separator", margin: "12px" },
          {
            type: "box", layout: "horizontal", paddingTop: "8px",
            contents: [
              { type: "text", text: progress >= 100 ? "🎉 ทำได้แล้วค่ะ!" : `เหลืออีก ${remaining.toFixed(1)} km`, size: "sm", color: "#555555" },
              { type: "text", text: `${daysLeft} วัน`, size: "sm", color, align: "end", weight: "bold" },
            ],
          },
        ],
      },
    },
  };
}

function buildPRFlexMessage(prs, activityName) {
  return {
    type: "flex", altText: "🏅 คุณทำ PR แล้ว!",
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#F39C12", paddingAll: "16px",
        contents: [
          { type: "text", text: "🏅 Personal Record!", color: "#ffffff", size: "md", weight: "bold", align: "center" },
          { type: "text", text: "ยอดเยี่ยมมากค่ะ! 🎉", color: "#ffffff99", size: "sm", align: "center" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px",
        contents: [
          { type: "text", text: activityName, size: "sm", color: "#888888", align: "center" },
          ...prs.map(pr => ({ type: "text", text: pr, size: "sm", color: "#333333", margin: "md", wrap: true, align: "center" })),
          { type: "text", text: "ขอแสดงความยินดีด้วยนะคะ 💪", size: "sm", color: "#E8703A", margin: "lg", align: "center", weight: "bold" },
        ],
      },
    },
  };
}


// ===== UPDATE NOTIFICATION =====
function buildUpdateNotificationFlex() {
  return {
    type: "flex",
    altText: "🆕 อาจารย์นักวิ่ง AI Beta 2.0 - อัปเดตใหม่!",
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#1A1A2E", paddingAll: "16px",
        contents: [
          { type: "text", text: "🏃 อาจารย์นักวิ่ง AI", color: "#E8703A", size: "md", weight: "bold" },
          { type: "text", text: "Beta 2.0 — มีอะไรใหม่บ้าง?", color: "#ffffff", size: "sm" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "md",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "✨", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "Flex Message", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "สถิติแสดงเป็น Card สวยงาม", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "🎯", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "Challenge ตั้งเป้า", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "ตั้งเป้า km/เดือน พร้อม progress bar", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "🏅", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "ตรวจจับ PR อัตโนมัติ", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "แจ้งเตือนทันทีเมื่อทำ Personal Record", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "📸", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "อ่านรูป + ไฟล์ GPX", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "ส่งรูป screenshot หรือไฟล์ .gpx บันทึก stat ได้เลย", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "📊", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "ดึงข้อมูล Strava 6 เดือน", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "เชื่อม Strava ครั้งเดียว ดึงประวัติย้อนหลัง 6 เดือนเลย", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "🌅", size: "sm", flex: 0 },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "แจ้งเตือนวันจันทร์อัตโนมัติ", size: "sm", weight: "bold", color: "#E8703A" },
                { type: "text", text: "รับสรุปสัปดาห์ทุกเช้าวันจันทร์ 8.00น.", size: "xs", color: "#888888", wrap: true },
              ]},
            ],
          },
          { type: "separator", margin: "md" },
          {
            type: "box", layout: "horizontal", paddingTop: "8px",
            contents: [
              { type: "text", text: "💬 พิมพ์ /update เพื่อดูอีกครั้ง", size: "xs", color: "#aaaaaa", align: "center" },
            ],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical", backgroundColor: "#F5F5F5", paddingAll: "12px",
        contents: [
          { type: "text", text: "🏃 อาจารย์นักวิ่ง AI Beta 2.0", size: "xs", color: "#888888", align: "center" },
        ],
      },
    },
  };
}


// ===== EXERCISE DATABASE (built-in) =====
const EXERCISES = {
  // ===== CHEST =====
  chest: [
    { name: "Barbell Bench Press", equipment: "barbell", target: "Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Bench_Press_-_Medium_Grip/0.jpg" },
    { name: "Dumbbell Bench Press", equipment: "dumbbell", target: "Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Bench_Press/0.jpg" },
    { name: "Dumbbell Flyes", equipment: "dumbbell", target: "Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Flyes/0.jpg" },
    { name: "Push-Up", equipment: "body only", target: "Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pushups/0.jpg" },
    { name: "Wide Push-Up", equipment: "body only", target: "Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Wide-Grip_Barbell_Bench_Press/0.jpg" },
    { name: "Incline Dumbbell Press", equipment: "dumbbell", target: "Upper Chest", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Incline_Dumbbell_Bench_Press/0.jpg" },
  ],
  // ===== SHOULDERS =====
  shoulders: [
    { name: "Dumbbell Shoulder Press", equipment: "dumbbell", target: "Shoulders", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Shoulder_Press/0.jpg" },
    { name: "Barbell Overhead Press", equipment: "barbell", target: "Shoulders", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Shoulder_Press/0.jpg" },
    { name: "Dumbbell Lateral Raise", equipment: "dumbbell", target: "Side Delts", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Lateral_Raise/0.jpg" },
    { name: "Dumbbell Front Raise", equipment: "dumbbell", target: "Front Delts", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Front_Raise/0.jpg" },
    { name: "Pike Push-Up", equipment: "body only", target: "Shoulders", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pike_Push-up/0.jpg" },
  ],
  // ===== TRICEPS =====
  triceps: [
    { name: "Barbell Skull Crusher", equipment: "barbell", target: "Triceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Lying_Triceps_Extension_Skull_Crusher/0.jpg" },
    { name: "Dumbbell Tricep Kickback", equipment: "dumbbell", target: "Triceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Kickback/0.jpg" },
    { name: "Diamond Push-Up", equipment: "body only", target: "Triceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Diamond_Push-up/0.jpg" },
    { name: "Tricep Dips", equipment: "body only", target: "Triceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Tricep_Dips/0.jpg" },
    { name: "Dumbbell Overhead Tricep Extension", equipment: "dumbbell", target: "Triceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_One_Arm_Triceps_Extension/0.jpg" },
  ],
  // ===== BACK =====
  back: [
    { name: "Pull-Up", equipment: "body only", target: "Lats", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Pullups/0.jpg" },
    { name: "Chin-Up", equipment: "body only", target: "Lats & Biceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Chin-up/0.jpg" },
    { name: "Barbell Bent Over Row", equipment: "barbell", target: "Back", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Bent_Over_Row/0.jpg" },
    { name: "Dumbbell One Arm Row", equipment: "dumbbell", target: "Back", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_One-Arm_Row/0.jpg" },
    { name: "Superman", equipment: "body only", target: "Lower Back", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Superman/0.jpg" },
  ],
  // ===== BICEPS =====
  biceps: [
    { name: "Barbell Curl", equipment: "barbell", target: "Biceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Curl/0.jpg" },
    { name: "Dumbbell Alternate Curl", equipment: "dumbbell", target: "Biceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Alternate_Bicep_Curl/0.jpg" },
    { name: "Dumbbell Hammer Curl", equipment: "dumbbell", target: "Biceps", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Alternate_Hammer_Curl/0.jpg" },
    { name: "Inverted Row", equipment: "body only", target: "Biceps & Back", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Inverted_Row_with_Straps/0.jpg" },
  ],
  // ===== QUADS =====
  quads: [
    { name: "Barbell Squat", equipment: "barbell", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Full_Squat/0.jpg" },
    { name: "Dumbbell Goblet Squat", equipment: "dumbbell", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Goblet_Squat/0.jpg" },
    { name: "Bodyweight Squat", equipment: "body only", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bodyweight_Squat/0.jpg" },
    { name: "Jump Squat", equipment: "body only", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Squat_Jumps/0.jpg" },
    { name: "Dumbbell Lunge", equipment: "dumbbell", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Lunge/0.jpg" },
    { name: "Walking Lunge", equipment: "body only", target: "Quads", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Bodyweight_Walking_Lunge/0.jpg" },
  ],
  // ===== HAMSTRINGS =====
  hamstrings: [
    { name: "Barbell Romanian Deadlift", equipment: "barbell", target: "Hamstrings", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Romanian_Deadlift/0.jpg" },
    { name: "Dumbbell Romanian Deadlift", equipment: "dumbbell", target: "Hamstrings", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Romanian_Deadlift/0.jpg" },
    { name: "Nordic Hamstring Curl", equipment: "body only", target: "Hamstrings", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Natural_Glute_Ham_Raise/0.jpg" },
    { name: "Glute Bridge", equipment: "body only", target: "Hamstrings & Glutes", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Glute_Bridge/0.jpg" },
  ],
  // ===== GLUTES =====
  glutes: [
    { name: "Barbell Hip Thrust", equipment: "barbell", target: "Glutes", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Hip_Thrust/0.jpg" },
    { name: "Dumbbell Bulgarian Split Squat", equipment: "dumbbell", target: "Glutes", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Bulgarian_Split_Squat/0.jpg" },
    { name: "Donkey Kick", equipment: "body only", target: "Glutes", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Donkey_Kicks/0.jpg" },
    { name: "Single Leg Glute Bridge", equipment: "body only", target: "Glutes", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Glute_Bridge/0.jpg" },
  ],
  // ===== CALVES =====
  calves: [
    { name: "Standing Calf Raise", equipment: "body only", target: "Calves", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Standing_Calf_Raises/0.jpg" },
    { name: "Dumbbell Calf Raise", equipment: "dumbbell", target: "Calves", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Calf_Raise/0.jpg" },
    { name: "Jump Rope", equipment: "body only", target: "Calves", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Jump_Rope/0.jpg" },
  ],
  // ===== ABS / CORE =====
  abs: [
    { name: "Plank", equipment: "body only", target: "Core", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Plank/0.jpg" },
    { name: "Crunches", equipment: "body only", target: "Abs", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Crunches/0.jpg" },
    { name: "Leg Raise", equipment: "body only", target: "Lower Abs", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Flat_Bench_Leg_Pull-In/0.jpg" },
    { name: "Russian Twist", equipment: "body only", target: "Obliques", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Russian_Twist/0.jpg" },
    { name: "Mountain Climber", equipment: "body only", target: "Core", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Mountain_Climbers/0.jpg" },
    { name: "Bicycle Crunch", equipment: "body only", target: "Obliques", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Air_Bike/0.jpg" },
    { name: "Dumbbell Side Bend", equipment: "dumbbell", target: "Obliques", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Dumbbell_Side_Bend/0.jpg" },
    { name: "Barbell Rollout", equipment: "barbell", target: "Core", gifUrl: "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Ab_Rollout/0.jpg" },
  ],
};

const WORKOUT_SPLITS = {
  push: { name: "Push Day 💪", muscles: ["chest", "shoulders", "triceps"], color: "#E74C3C" },
  pull: { name: "Pull Day 🦾", muscles: ["back", "biceps"], color: "#2980B9" },
  legs: { name: "Leg Day 🦵", muscles: ["quads", "hamstrings", "glutes", "calves"], color: "#27AE60" },
  upper: { name: "Upper Body 🏋️", muscles: ["chest", "back", "shoulders"], color: "#8E44AD" },
  core: { name: "Core Day 🔥", muscles: ["abs"], color: "#E8703A" },
};

const EXERCISE_PRESCRIPTION = {
  strength: { sets: 4, reps: "6-8", rest: "2-3 นาที" },
  hypertrophy: { sets: 4, reps: "10-12", rest: "60-90 วิ" },
  endurance: { sets: 3, reps: "15-20", rest: "30-45 วิ" },
};

function getExercisesForSplit(splitType) {
  const split = WORKOUT_SPLITS[splitType] || WORKOUT_SPLITS.push;
  let exercises = [];
  for (const muscle of split.muscles) {
    const list = EXERCISES[muscle] || [];
    // สุ่มท่าจากแต่ละกลุ่ม
    const shuffled = list.sort(() => Math.random() - 0.5);
    exercises = exercises.concat(shuffled.slice(0, 2));
    if (exercises.length >= 6) break;
  }
  return exercises.slice(0, 6);
}

function buildWeightTrainingCarousel(splitType = "push", goal = "hypertrophy") {
  const split = WORKOUT_SPLITS[splitType] || WORKOUT_SPLITS.push;
  const prescription = EXERCISE_PRESCRIPTION[goal] || EXERCISE_PRESCRIPTION.hypertrophy;
  const exercises = getExercisesForSplit(splitType);

  if (exercises.length === 0) return null;

  // Header bubble
  const headerBubble = {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "vertical", backgroundColor: split.color, paddingAll: "16px",
      contents: [
        { type: "text", text: "🏋️ Weight Training", color: "#ffffff", size: "xs" },
        { type: "text", text: split.name, color: "#ffffff", size: "lg", weight: "bold" },
        { type: "text", text: `${exercises.length} ท่า | ${prescription.sets} sets × ${prescription.reps} reps`, color: "#ffffff99", size: "xs" },
      ],
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
      contents: [
        { type: "text", text: "กลุ่มกล้ามเนื้อวันนี้:", size: "sm", color: "#555555", weight: "bold" },
        ...split.muscles.map(m => ({
          type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            { type: "text", text: "•", size: "sm", color: split.color, flex: 0 },
            { type: "text", text: m.charAt(0).toUpperCase() + m.slice(1), size: "sm", color: "#333333" },
          ],
        })),
        { type: "separator", margin: "md" },
        { type: "text", text: "👉 เลื่อนดูท่าออกกำลังกายได้เลยค่ะ →", size: "xs", color: "#888888", wrap: true, margin: "md" },
      ],
    },
  };

  // Exercise bubbles
  const bubbles = exercises.map((ex, i) => ({
    type: "bubble", size: "kilo",
    hero: {
      type: "image",
      url: ex.gifUrl,
      size: "full",
      aspectRatio: "4:3",
      aspectMode: "cover",
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
      contents: [
        { type: "text", text: `${i + 1}. ${ex.name}`, size: "sm", weight: "bold", color: split.color, wrap: true },
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "💪", size: "xs", flex: 0 },
            { type: "text", text: ex.target, size: "xs", color: "#555555", margin: "sm" },
            { type: "text", text: `🏋️ ${ex.equipment}`, size: "xs", color: "#555555", align: "end" },
          ],
        },
        { type: "separator" },
        {
          type: "box", layout: "horizontal", paddingTop: "8px",
          contents: [
            { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
              { type: "text", text: `${prescription.sets}`, size: "xl", weight: "bold", color: split.color, align: "center" },
              { type: "text", text: "sets", size: "xs", color: "#888888", align: "center" },
            ]},
            { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
              { type: "text", text: prescription.reps, size: "md", weight: "bold", color: split.color, align: "center" },
              { type: "text", text: "reps", size: "xs", color: "#888888", align: "center" },
            ]},
            { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
              { type: "text", text: prescription.rest, size: "xs", weight: "bold", color: split.color, align: "center", wrap: true },
              { type: "text", text: "พัก", size: "xs", color: "#888888", align: "center" },
            ]},
          ],
        },
      ],
    },
  }));

  return {
    type: "flex",
    altText: `🏋️ ${split.name} - ${exercises.length} ท่าวันนี้`,
    contents: { type: "carousel", contents: [headerBubble, ...bubbles] },
  };
}


// ===== BUILD WEIGHT TRAINING BY EQUIPMENT =====
async function fetchExercisesFromRapidAPI(bodyPart, equipment) {
  try {
    // equipment mapping ตรงกับ ExerciseDB API
    const equipMap = {
      "body only": "body weight",
      "dumbbell": "dumbbell",
      "barbell": "barbell",
    };
    const equipQuery = equipMap[equipment] || equipment;

    console.log(`Fetching: bodyPart=${bodyPart}, equipment=${equipQuery}`);

    const res = await axios.get(
      `https://exercisedb.p.rapidapi.com/exercises/bodyPart/${encodeURIComponent(bodyPart)}`,
      {
        headers: {
          "X-RapidAPI-Key": CONFIG.RAPIDAPI_KEY,
          "X-RapidAPI-Host": "exercisedb.p.rapidapi.com",
        },
        params: { limit: 100, offset: 0 },
        timeout: 10000,
      }
    );

    const exercises = Array.isArray(res.data) ? res.data : [];
    console.log(`Got ${exercises.length} exercises for ${bodyPart}`);

    // กรองตาม equipment
    const filtered = exercises.filter(ex =>
      ex.equipment && ex.equipment.toLowerCase() === equipQuery.toLowerCase()
    );
    console.log(`Filtered to ${filtered.length} exercises for equipment: ${equipQuery}`);

    if (filtered.length === 0) return null;

    // สุ่ม 5 ท่า
    const shuffled = [...filtered].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 5).map(ex => ({
      name: ex.name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      equipment: ex.equipment,
      target: ex.target,
      gifUrl: ex.gifUrl,
    }));
  } catch (e) {
    console.error("RapidAPI ExerciseDB error:", e.message, e.response?.status);
    return null;
  }
}

async function buildWeightTrainingByEquipment(muscles, equipment) {
  const equipmentMap = {
    "body only": "Body Weight 🤸",
    "dumbbell": "Dumbbell 🏋️",
    "barbell": "Barbell 🔩",
  };
  const equipLabel = equipmentMap[equipment] || equipment;
  const splitColor = equipment === "body only" ? "#27AE60" : equipment === "dumbbell" ? "#2980B9" : "#E74C3C";
  const prescription = { sets: 4, reps: "10-12", rest: "60-90 วิ" };

  // bodyPart mapping สำหรับ RapidAPI (ต้องตรงกับ API จริงๆ)
  const bodyPartMap = {
    chest: "chest",
    shoulders: "shoulders",
    triceps: "upper arms",
    back: "back",
    biceps: "upper arms",
    quads: "upper legs",
    hamstrings: "upper legs",
    glutes: "upper legs",
    calves: "lower legs",
    abs: "waist",
  };

  // ลองดึงจาก RapidAPI ก่อน
  let exercises = [];
  const triedParts = new Set();

  for (const muscle of muscles) {
    const bodyPart = bodyPartMap[muscle];
    if (!bodyPart || triedParts.has(bodyPart)) continue;
    triedParts.add(bodyPart);

    const fetched = await fetchExercisesFromRapidAPI(bodyPart, equipment);
    if (fetched && fetched.length > 0) {
      exercises = exercises.concat(fetched);
      if (exercises.length >= 5) break;
    }
  }

  // Fallback: ใช้ local database ถ้า API ไม่ตอบ
  if (exercises.length === 0) {
    console.log("Falling back to local exercise database");
    for (const muscle of muscles) {
      const list = EXERCISES[muscle] || [];
      const filtered = list.filter(ex => ex.equipment === equipment);
      if (filtered.length === 0) continue;
      const shuffled = [...filtered].sort(() => Math.random() - 0.5);
      exercises = exercises.concat(shuffled.slice(0, 2));
      if (exercises.length >= 5) break;
    }
  }

  if (exercises.length === 0) return null;
  exercises = exercises.slice(0, 5);

  // Header bubble
  const headerBubble = {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "vertical", backgroundColor: splitColor, paddingAll: "16px",
      contents: [
        { type: "text", text: "🏋️ Weight Training", color: "#ffffff", size: "xs" },
        { type: "text", text: equipLabel, color: "#ffffff", size: "lg", weight: "bold" },
        { type: "text", text: `${exercises.length} ท่า | ${prescription.sets} sets × ${prescription.reps} reps`, color: "#ffffff99", size: "xs" },
      ],
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
      contents: [
        { type: "text", text: "อุปกรณ์:", size: "sm", color: "#555555", weight: "bold" },
        { type: "text", text: equipLabel, size: "md", color: splitColor, weight: "bold" },
        { type: "separator", margin: "md" },
        { type: "text", text: "👉 เลื่อนดูท่าได้เลยค่ะ →", size: "xs", color: "#888888", wrap: true, margin: "md" },
      ],
    },
  };

  // Exercise bubbles
  const bubbles = exercises.map((ex, i) => {
    const hasImage = !!ex.gifUrl;
    const bodyContents = [
      { type: "text", text: `${i + 1}. ${ex.name}`, size: "sm", weight: "bold", color: splitColor, wrap: true },
      {
        type: "box", layout: "horizontal",
        contents: [
          { type: "text", text: "💪", size: "xs", flex: 0 },
          { type: "text", text: ex.target, size: "xs", color: "#555555", margin: "sm", flex: 1 },
          { type: "text", text: `🏋️ ${ex.equipment}`, size: "xs", color: "#555555", align: "end" },
        ],
      },
      { type: "separator" },
      {
        type: "box", layout: "horizontal", paddingTop: "8px",
        contents: [
          { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
            { type: "text", text: `${prescription.sets}`, size: "xl", weight: "bold", color: splitColor, align: "center" },
            { type: "text", text: "sets", size: "xs", color: "#888888", align: "center" },
          ]},
          { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
            { type: "text", text: prescription.reps, size: "md", weight: "bold", color: splitColor, align: "center" },
            { type: "text", text: "reps", size: "xs", color: "#888888", align: "center" },
          ]},
          { type: "box", layout: "vertical", flex: 1, alignItems: "center", contents: [
            { type: "text", text: prescription.rest, size: "xs", weight: "bold", color: splitColor, align: "center", wrap: true },
            { type: "text", text: "พัก", size: "xs", color: "#888888", align: "center" },
          ]},
        ],
      },
    ];

    const bubble = {
      type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: bodyContents },
    };

    if (hasImage) {
      bubble.hero = {
        type: "image",
        url: ex.gifUrl,
        size: "full",
        aspectRatio: "4:3",
        aspectMode: "cover",
      };
    } else {
      bubble.hero = {
        type: "box", layout: "vertical", height: "150px",
        backgroundColor: splitColor + "33",
        justifyContent: "center", alignItems: "center",
        contents: [
          { type: "text", text: "🏋️", size: "xxl", align: "center" },
          { type: "text", text: ex.name, size: "xs", color: splitColor, align: "center", wrap: true },
        ],
      };
    }

    return bubble;
  });

  return {
    type: "flex",
    altText: `🏋️ ${equipLabel} - ${exercises.length} ท่าวันนี้`,
    contents: { type: "carousel", contents: [headerBubble, ...bubbles] },
  };
}

// ===== LINE MESSAGING =====
function makeQuickReply(items) {
  return { items: items.map(i => ({ type: "action", action: { type: "message", label: i.label, text: i.text } })) };
}

async function pushMessage(userId, text, quickReply = null) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [{ type: "text", text, ...(quickReply ? { quickReply } : {}) }] },
    { headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` } }
  );
}

async function pushFlexMessage(userId, flexContent) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [flexContent] },
    { headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` } }
  );
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  for (const event of events) {
    const userId = event.source?.userId || event.source?.groupId || event.source?.roomId;
    console.log("userId:", userId, "event type:", event.type);

    try {
      // Follow
      if (event.type === "follow") {
        const msg = hasStrava(userId)
          ? `🏃 ยินดีต้อนรับกลับมานะคะ!\nเชื่อม Strava ไว้แล้ว ใช้ Rich Menu ได้เลยค่ะ 💪`
          : `🏃 สวัสดีค่ะ! ยินดีต้อนรับสู่ อาจารย์นักวิ่ง!\n\n📌 วิธีใช้งาน:\n• ส่ง 📸 รูป screenshot ผลการวิ่งจากแอปใดก็ได้\n• ส่ง 📁 ไฟล์ .gpx จาก GPS watch\n• พิมพ์ /connect เพื่อเชื่อม Strava (ไม่บังคับ)\n\nเริ่มได้เลยค่ะ! 💪`;
        await pushMessage(userId, msg);
        await pushFlexMessage(userId, buildUpdateNotificationFlex());
      }

      // Postback
      if (event.type === "postback") {
        const data = event.postback.data;

        if (data === "action=today") {
          await pushMessage(userId, "⏳ กำลังดึงข้อมูล...");
          const activities = await getActivitiesForUser(userId, 1);
          const stats = calcStatsFromActivities(activities);
          if (!stats) {
            await pushMessage(userId, "ยังไม่มีกิจกรรมวันนี้ค่ะ 😴\n\nลองส่งรูปผลการวิ่งมาได้เลยนะคะ 📸");
          } else {
            const flex = buildStatsFlexMessage(stats, "วันนี้");
            if (flex) await pushFlexMessage(userId, flex);
          }

        } else if (data === "action=week") {
          await pushMessage(userId, "⏳ กำลังดึงข้อมูล...");
          const activities = await getActivitiesForUser(userId, 7);
          const stats = calcStatsFromActivities(activities);
          if (!stats) {
            await pushMessage(userId, "ยังไม่มีกิจกรรมสัปดาห์นี้ค่ะ 😴\n\nลองส่งรูปผลการวิ่งมาได้เลยนะคะ 📸");
          } else {
            const flex = buildStatsFlexMessage(stats, "สัปดาห์นี้");
            if (flex) await pushFlexMessage(userId, flex);
          }

        } else if (data === "action=plan") {
          await pushMessage(userId, "⏳ กำลังสร้างตารางซ้อม...");
          const activities = await getActivitiesForUser(userId, 28);
          const stats = calcStatsFromActivities(activities);
          if (!stats) {
            await pushMessage(userId, "ยังไม่มีข้อมูลการวิ่งค่ะ 😴\n\nส่งรูปผลการวิ่งมาก่อนได้เลยนะคะ 📸");
          } else {
            const summary = `วิ่ง ${stats.count} ครั้ง รวม ${stats.totalDistance.toFixed(1)}km ใน 4 สัปดาห์ที่ผ่านมา`;
            const plan = await analyzeWithClaude(`สร้างตารางซ้อม 7 วันจากข้อมูลนี้: ${summary} ตอบภาษาไทย`);
            await pushMessage(userId, plan);
          }

        } else if (data === "action=recovery") {
          // Weight Training flow - Step 1: เลือกส่วนร่างกาย
          userSessions[userId] = { waitingFor: "weight_body_part" };
          const qrBodyPart = makeQuickReply([
            { label: "💪 Upper Body", text: "weight_upper" },
            { label: "🔥 Core", text: "weight_core" },
            { label: "🦵 Lower Body", text: "weight_lower" },
          ]);
          await pushMessage(userId, "🏋️ Weight Training วันนี้!\n\nStep 1: อยากเล่นส่วนไหนคะ?", qrBodyPart);

        } else if (data === "action=goal") {
          if (userChallenges[userId]) {
            const activities = await getActivitiesForUser(userId, 30);
            const stats = calcStatsFromActivities(activities);
            const currentKm = stats ? stats.totalDistance : 0;
            const flex = buildChallengeFlexMessage(userId, currentKm);
            if (flex) await pushFlexMessage(userId, flex);
            await pushMessage(userId, "อยากตั้ง Challenge ใหม่ไหมคะ? พิมพ์ /challenge ได้เลยค่ะ");
          } else {
            userSessions[userId] = { waitingFor: "challenge_km" };
            const qr = makeQuickReply([
              { label: "50 km", text: "50" }, { label: "100 km", text: "100" },
              { label: "150 km", text: "150" }, { label: "200 km", text: "200" },
            ]);
            await pushMessage(userId, "🎯 มาตั้ง Challenge กันเลยค่ะ!\n\nอยากวิ่งกี่ km ภายในเดือนนี้คะ?", qr);
          }

        } else if (data === "action=chat") {
          userSessions[userId] = { waitingFor: "free_chat" };
          const qr = makeQuickReply([
            { label: "🏃 วิธีเพิ่ม pace", text: "จะเพิ่ม pace ยังไงดีคะ" },
            { label: "💪 ซ้อมก่อนแข่ง", text: "ควรซ้อมยังไงก่อนวันแข่ง" },
            { label: "😴 พักฟื้นยังไง", text: "ควรพักฟื้นยังไงหลังวิ่ง" },
          ]);
          await pushMessage(userId, "💬 ถามอะไรเกี่ยวกับการวิ่งได้เลยค่ะ! 🏃", qr);
        }
      }

      // Message
      if (event.type === "message") {
        const session = userSessions[userId] || {};

        // รูปภาพ
        if (event.message.type === "image") {
          const imgRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
            { headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` }, responseType: "arraybuffer" }
          );
          const imageBase64 = Buffer.from(imgRes.data).toString("base64");

          if (session.waitingFor === "recovery_image") {
            await pushMessage(userId, "⏳ กำลังวิเคราะห์ Recovery...");
            const analysis = await analyzeWithClaude(
              `วิเคราะห์รูป Recovery จากแอปออกกำลังกายนี้ให้หน่อยค่ะ อ่านค่าต่างๆ เช่น Readiness, HRV, Sleep แล้วแนะนำแผนซ้อมวันนี้ ตอบภาษาไทย (ไม่ต้อง return JSON)`,
              imageBase64
            );
            await pushMessage(userId, analysis);
            userSessions[userId] = {};
          } else {
            await pushMessage(userId, "⏳ กำลังอ่านผลการวิ่ง...");
            const analysis = await analyzeWithClaude(
              `อ่านผลการวิ่งจากรูปนี้แล้ว return JSON ในบรรทัดแรกก่อนเลยค่ะ:
{"distance": X.XX, "pace": X.XX, "duration": X.X, "calories": XXX, "elevGain": XX, "date": "YYYY-MM-DD"}
แล้วค่อยให้ feedback การวิ่งเป็นภาษาไทย`,
              imageBase64
            );
            const activity = extractActivityFromResponse(analysis);
            if (activity) {
              saveActivity(userId, activity);
              const prs = checkPR(userId, activity);
              if (prs) await pushFlexMessage(userId, buildPRFlexMessage(prs, "การวิ่งล่าสุด"));
              if (userChallenges[userId]) {
                const allAct = await getActivitiesForUser(userId, 30);
                const stats = calcStatsFromActivities(allAct);
                if (stats) {
                  const flex = buildChallengeFlexMessage(userId, stats.totalDistance);
                  if (flex) await pushFlexMessage(userId, flex);
                }
              }
            }
            const feedbackText = analysis.replace(/\{[\s\S]*?\}/, "").trim();
            await pushMessage(userId, feedbackText || analysis);
          }

        // ไฟล์
        } else if (event.message.type === "file") {
          const fileName = event.message.fileName || "";
          await pushMessage(userId, `⏳ กำลังประมวลผลไฟล์ ${fileName}...`);
          const fileRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
            { headers: { Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}` }, responseType: "arraybuffer" }
          );
          if (fileName.toLowerCase().endsWith(".gpx")) {
            const xmlText = Buffer.from(fileRes.data).toString("utf-8");
            const gpxData = parseGPX(xmlText);
            if (gpxData) {
              saveActivity(userId, gpxData);
              const prs = checkPR(userId, gpxData);
              if (prs) await pushFlexMessage(userId, buildPRFlexMessage(prs, "การวิ่งจาก GPX"));
              const pMin = Math.floor(gpxData.pace);
              const pSec = Math.round((gpxData.pace - pMin) * 60);
              await pushMessage(userId, `✅ บันทึกการวิ่งสำเร็จค่ะ!\n📏 ${gpxData.distance}km | ⏱ ${pMin}:${String(pSec).padStart(2,"0")}/km | ⏰ ${Math.floor(gpxData.duration)} นาที | ⛰ ${gpxData.elevGain}m`);
              const analysis = await analyzeWithClaude(`วิเคราะห์การวิ่งนี้ให้หน่อยค่ะ: ${gpxData.distance}km pace ${pMin}:${String(pSec).padStart(2,"0")}/km เวลา ${Math.floor(gpxData.duration)} นาที elevation ${gpxData.elevGain}m ตอบภาษาไทย`);
              await pushMessage(userId, analysis);
            } else {
              await pushMessage(userId, "❌ ไม่สามารถอ่านไฟล์ GPX ได้ค่ะ ลองส่งรูป screenshot แทนได้เลยนะคะ 📸");
            }
          } else {
            await pushMessage(userId, "⚠️ รองรับเฉพาะไฟล์ .gpx ค่ะ\nหรือส่งเป็นรูป screenshot ได้เลยนะคะ 📸");
          }

        // ข้อความ
        } else if (event.message.type === "text") {
          const text = event.message.text.trim();

          if (text === "/update") {
            await pushFlexMessage(userId, buildUpdateNotificationFlex());

          } else if (text.startsWith("weight_") && session.waitingFor === "weight_body_part") {
            // Step 2: เลือกอุปกรณ์
            const bodyPartMap = {
              weight_upper: { label: "Upper Body 💪", muscles: ["chest", "shoulders", "triceps", "back", "biceps"] },
              weight_core: { label: "Core 🔥", muscles: ["abs"] },
              weight_lower: { label: "Lower Body 🦵", muscles: ["quads", "hamstrings", "glutes", "calves"] },
            };
            const bodyPart = bodyPartMap[text] || bodyPartMap.weight_upper;
            userSessions[userId] = { waitingFor: "weight_equipment", bodyPart };
            const qrEquipment = makeQuickReply([
              { label: "🤸 Body Weight", text: "equip_bodyweight" },
              { label: "🏋️ Dumbbell", text: "equip_dumbbell" },
              { label: "🔩 Barbell", text: "equip_barbell" },
            ]);
            await pushMessage(userId, `✅ ${bodyPart.label}

Step 2: ใช้อุปกรณ์อะไรคะ?`, qrEquipment);

          } else if (text.startsWith("equip_") && session.waitingFor === "weight_equipment") {
            // Step 3: แสดง Carousel GIF
            const equipMap = {
              equip_bodyweight: "body only",
              equip_dumbbell: "dumbbell",
              equip_barbell: "barbell",
            };
            const equipment = equipMap[text] || "dumbbell";
            const bodyPart = session.bodyPart || { label: "Upper Body", muscles: ["chest", "shoulders"] };
            userSessions[userId] = {};
            await pushMessage(userId, `⏳ กำลังสร้างโปรแกรม ${bodyPart.label}...`);
            const carousel = await buildWeightTrainingByEquipment(bodyPart.muscles, equipment);
            if (carousel) {
              await pushFlexMessage(userId, carousel);
            } else {
              await pushMessage(userId, "❌ ไม่มีท่าที่ตรงกับอุปกรณ์นี้ค่ะ ลองเลือกใหม่ได้เลยนะคะ");
            }

          } else if (text === "/weight" || text.startsWith("/weight ")) {
            const parts = text.trim().split(" ");
            const splitType = parts[1] || "push";
            const goal = parts[2] || "hypertrophy";
            const validSplits = ["push", "pull", "legs", "upper", "core"];
            if (!validSplits.includes(splitType)) {
              const qr = makeQuickReply([
                { label: "💪 Push Day", text: "/weight push" },
                { label: "🦾 Pull Day", text: "/weight pull" },
                { label: "🦵 Leg Day", text: "/weight legs" },
                { label: "🏋️ Upper Body", text: "/weight upper" },
                { label: "🔥 Core Day", text: "/weight core" },
              ]);
              await pushMessage(userId, "เลือก Weight Training วันนี้ได้เลยค่ะ 👇", qr);
            } else {
              await pushMessage(userId, `⏳ กำลังสร้างโปรแกรม ${splitType.toUpperCase()} วันนี้...`);
              const carousel = await buildWeightTrainingCarousel(splitType, goal);
              if (carousel) {
                await pushFlexMessage(userId, carousel);
              } else {
                await pushMessage(userId, "❌ ไม่สามารถสร้างโปรแกรมได้ค่ะ ลองใหม่อีกครั้งนะคะ");
              }
            }

          } else if (text === "/connect") {
            const authUrl = `https://www.strava.com/oauth/authorize?client_id=${CONFIG.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(`${CONFIG.SERVER_URL}/strava/callback?lineUserId=${userId}`)}&approval_prompt=force&scope=activity:read_all`;
            await pushMessage(userId, `🔗 กดลิงก์นี้เพื่อเชื่อม Strava ได้เลยค่ะ:\n${authUrl}`);

          } else if (text === "/disconnect") {
            delete stravaTokens[userId];
            await pushMessage(userId, "✅ ยกเลิกการเชื่อม Strava แล้วค่ะ\nตอนนี้ใช้การส่งรูป/ไฟล์แทนได้เลยนะคะ 📸");

          } else if (text === "/history") {
            const activities = await getActivitiesForUser(userId, 30);
            if (!activities || activities.length === 0) {
              await pushMessage(userId, "ยังไม่มีประวัติการวิ่งค่ะ 😴");
            } else {
              const carousel = buildCarouselMessage(activities);
              if (carousel) await pushFlexMessage(userId, carousel);
            }

          } else if (text === "/challenge") {
            userSessions[userId] = { waitingFor: "challenge_km" };
            const qr = makeQuickReply([
              { label: "50 km", text: "50" }, { label: "100 km", text: "100" },
              { label: "150 km", text: "150" }, { label: "200 km", text: "200" },
            ]);
            await pushMessage(userId, "🎯 ตั้ง Challenge ใหม่เลยค่ะ!\n\nอยากวิ่งกี่ km ภายในเดือนนี้คะ?", qr);

          } else if (session.waitingFor === "challenge_km") {
            const km = parseFloat(text);
            if (isNaN(km) || km <= 0) {
              await pushMessage(userId, "❌ กรุณาใส่ตัวเลขนะคะ เช่น 100");
            } else {
              const now = new Date();
              const deadline = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
              userChallenges[userId] = { goal: km, deadline, startDate: now.toISOString().split("T")[0] };
              userSessions[userId] = {};
              await pushMessage(userId, `✅ ตั้ง Challenge สำเร็จแล้วค่ะ!\n🎯 เป้าหมาย: วิ่ง ${km}km ภายใน ${deadline}\n\nกดปุ่ม "เป้าหมาย" เพื่อดู progress ได้เลยนะคะ 💪`);
            }

          } else {
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
  if (!code || !lineUserId) {
    res.send("<h2>❌ ข้อมูลไม่ครบ กรุณาลองใหม่ค่ะ</h2>");
    return;
  }
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
    // โหลด PR จาก Strava
    const activitiesRes = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      params: { per_page: 20 },
    });
    if (activitiesRes.data.length > 0) {
      convertStravaToActivities(activitiesRes.data).forEach(a => checkPR(lineUserId, a));
    }
    await pushMessage(lineUserId, `✅ เชื่อม Strava สำเร็จแล้วค่ะ!\nยินดีต้อนรับ ${tokenRes.data.athlete.firstname} 🎉\n\nตอนนี้ Bot จะดึงข้อมูลจาก Strava อัตโนมัติเลยค่ะ 🏃\nพิมพ์ /disconnect ถ้าอยากยกเลิกการเชื่อมต่อนะคะ`);
    res.send("<h2>✅ เชื่อม Strava สำเร็จแล้ว! กลับไปที่ LINE ได้เลยค่ะ</h2>");
  } catch (err) {
    console.error("Strava OAuth error:", err.message);
    res.send("<h2>❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง</h2>");
  }
});

// ===== CRON: แจ้งเตือนทุกเช้าวันจันทร์ 8.00น. =====
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 1 || now.getHours() !== 8 || now.getMinutes() !== 0) return;
  console.log("📬 ส่งสรุปประจำสัปดาห์...");
  const allUsers = new Set([...Object.keys(stravaTokens), ...Object.keys(userActivities)]);
  for (const userId of allUsers) {
    try {
      const activities = await getActivitiesForUser(userId, 7);
      const stats = calcStatsFromActivities(activities);
      if (!stats) continue;
      await pushMessage(userId, "🌅 สวัสดีตอนเช้าวันจันทร์ค่ะ! นี่คือสรุปสัปดาห์ที่แล้วค่ะ 💪");
      const flex = buildStatsFlexMessage(stats, "สัปดาห์ที่ผ่านมา");
      if (flex) await pushFlexMessage(userId, flex);
      if (userChallenges[userId]) {
        const allAct = await getActivitiesForUser(userId, 30);
        const allStats = calcStatsFromActivities(allAct);
        if (allStats) {
          const challengeFlex = buildChallengeFlexMessage(userId, allStats.totalDistance);
          if (challengeFlex) await pushFlexMessage(userId, challengeFlex);
        }
      }
    } catch (e) {
      console.error("Cron error:", e.message);
    }
  }
}, 60000);

// ===== START SERVER =====
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log(`🚀 Bot running on port ${process.env.PORT || 3000}`);
});
