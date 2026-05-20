const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,
  SERVER_URL: process.env.SERVER_URL || "https://strava-line-bot-production.up.railway.app",
};

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ===== PostgreSQL DATABASE =====
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false},
});

async function initDB() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TIMESTAMP NOT NULL,
        distance FLOAT,
        pace FLOAT,
        duration FLOAT,
        calories FLOAT,
        elev_gain FLOAT,
        cadence INT,
        source TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_challenges (
        user_id TEXT PRIMARY KEY,
        goal FLOAT,
        deadline DATE,
        start_date DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_prs (
        user_id TEXT PRIMARY KEY,
        longest_run FLOAT DEFAULT 0,
        fastest_pace FLOAT DEFAULT 9999,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS strava_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversation_history (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        user_id TEXT PRIMARY KEY,
        goal TEXT,
        target_distance FLOAT,
        target_pace FLOAT,
        running_level TEXT,
        injury_note TEXT,
        available_days TEXT,
        motivation_style TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_memory (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        memory_type TEXT,
        content TEXT NOT NULL,
        importance INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_history_user_id_created_at ON conversation_history(user_id, created_at DESC);
    `);
    console.log("✅ Database initialized");

    const tokens = await db.query(`SELECT * FROM strava_tokens`);
    for (const row of tokens.rows) {
      stravaTokens[row.user_id] = {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: parseInt(row.expires_at),
      };
    }

    const prs = await db.query(`SELECT * FROM user_prs`);
    for (const row of prs.rows) {
      userPRs[row.user_id] = {
        longestRun: parseFloat(row.longest_run),
        fastestPace: parseFloat(row.fastest_pace),
      };
    }

    const challenges = await db.query(`SELECT * FROM user_challenges`);
    for (const row of challenges.rows) {
      userChallenges[row.user_id] = {
        goal: parseFloat(row.goal),
        deadline: row.deadline,
        startDate: row.start_date,
      };
    }

  } catch (e) {
    console.error("❌ DB init error:", e.message);
  }
}

initDB();

// ===== DB HELPERS =====
async function dbSaveActivity(userId, activity) {
  try {
    await db.query(
      `INSERT INTO activities (user_id, date, distance, pace, duration, calories, elev_gain, cadence, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        activity.date || new Date().toISOString(),
        activity.distance || 0,
        activity.pace || 0,
        activity.duration || 0,
        activity.calories || 0,
        activity.elevGain || 0,
        estimateCadence(activity.pace),
        activity.source || "manual",
      ]
    );
  } catch (e) {
    console.error("DB save activity error:", e.message);
    saveActivity(userId, activity);
  }
}

async function dbGetActivities(userId, days = 7) {
  try {
    const res = await db.query(
      `SELECT * FROM activities WHERE user_id = $1 AND date > NOW() - INTERVAL '${days} days' ORDER BY date DESC`,
      [userId]
    );
    return res.rows.map(r => ({
      date: r.date,
      distance: parseFloat(r.distance),
      pace: parseFloat(r.pace),
      duration: parseFloat(r.duration),
      calories: parseFloat(r.calories),
      elevGain: parseFloat(r.elev_gain),
      source: r.source,
    }));
  } catch (e) {
    console.error("DB get activities error:", e.message);
    return getRecentActivities(userId, days);
  }
}

async function dbSaveChallenge(userId, challenge) {
  try {
    await db.query(
      `INSERT INTO user_challenges (user_id, goal, deadline, start_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET goal=$2, deadline=$3, start_date=$4`,
      [userId, challenge.goal, challenge.deadline, challenge.startDate]
    );
  } catch (e) {
    console.error("DB save challenge error:", e.message);
  }
}

async function dbGetChallenge(userId) {
  try {
    const res = await db.query(`SELECT * FROM user_challenges WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { goal: r.goal, deadline: r.deadline, startDate: r.start_date };
  } catch (e) {
    console.error("DB get challenge error:", e.message);
    return userChallenges[userId] || null;
  }
}

async function dbSavePR(userId, prs) {
  try {
    await db.query(
      `INSERT INTO user_prs (user_id, longest_run, fastest_pace)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET longest_run=$2, fastest_pace=$3, updated_at=NOW()`,
      [userId, prs.longestRun, prs.fastestPace]
    );
  } catch (e) {
    console.error("DB save PR error:", e.message);
  }
}

async function dbGetPR(userId) {
  try {
    const res = await db.query(`SELECT * FROM user_prs WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) return null;
    return {
      longestRun: parseFloat(res.rows[0].longest_run),
      fastestPace: parseFloat(res.rows[0].fastest_pace),
    };
  } catch (e) {
    return userPRs[userId] || null;
  }
}

async function dbSaveStravaToken(userId, tokenData) {
  try {
    await db.query(
      `INSERT INTO strava_tokens (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET access_token=$2, refresh_token=$3, expires_at=$4, updated_at=NOW()`,
      [userId, tokenData.access_token, tokenData.refresh_token, tokenData.expires_at]
    );
    stravaTokens[userId] = tokenData;
  } catch (e) {
    console.error("DB save strava token error:", e.message);
    stravaTokens[userId] = tokenData;
  }
}

async function dbGetStravaToken(userId) {
  try {
    const res = await db.query(`SELECT * FROM strava_tokens WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: parseInt(r.expires_at),
    };
  } catch (e) {
    return stravaTokens[userId] || null;
  }
}

// ===== AI MEMORY / CONTEXT HELPERS =====
async function saveConversation(userId, role, content) {
  if (!userId || !content) return;

  try {
    await db.query(
      `INSERT INTO conversation_history (user_id, role, content)
       VALUES ($1, $2, $3)`,
      [userId, role, String(content).slice(0, 8000)]
    );

    await db.query(
      `DELETE FROM conversation_history
       WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM conversation_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 50
       )`,
      [userId]
    );
  } catch (e) {
    console.error("saveConversation error:", e.message);
  }
}

async function getConversationHistory(userId, limit = 12) {
  try {
    const res = await db.query(
      `SELECT role, content
       FROM conversation_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return res.rows.reverse().map(h => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));
  } catch (e) {
    console.error("getConversationHistory error:", e.message);
    return [];
  }
}

async function dbSaveUserProfile(userId, profile = {}) {
  try {
    await db.query(
      `INSERT INTO user_profile
       (user_id, goal, target_distance, target_pace, running_level, injury_note, available_days, motivation_style)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET
         goal = COALESCE($2, user_profile.goal),
         target_distance = COALESCE($3, user_profile.target_distance),
         target_pace = COALESCE($4, user_profile.target_pace),
         running_level = COALESCE($5, user_profile.running_level),
         injury_note = COALESCE($6, user_profile.injury_note),
         available_days = COALESCE($7, user_profile.available_days),
         motivation_style = COALESCE($8, user_profile.motivation_style),
         updated_at = NOW()`,
      [
        userId,
        profile.goal || null,
        profile.target_distance || null,
        profile.target_pace || null,
        profile.running_level || null,
        profile.injury_note || null,
        profile.available_days || null,
        profile.motivation_style || null,
      ]
    );
  } catch (e) {
    console.error("dbSaveUserProfile error:", e.message);
  }
}

async function dbGetUserProfile(userId) {
  try {
    const res = await db.query(
      `SELECT *
       FROM user_profile
       WHERE user_id = $1`,
      [userId]
    );
    return res.rows[0] || null;
  } catch (e) {
    console.error("dbGetUserProfile error:", e.message);
    return null;
  }
}

async function dbSaveUserMemory(userId, memory) {
  if (!memory || !memory.content) return;

  try {
    await db.query(
      `INSERT INTO user_memory (user_id, memory_type, content, importance)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        memory.memory_type || "note",
        String(memory.content).slice(0, 1000),
        memory.importance || 1,
      ]
    );
  } catch (e) {
    console.error("dbSaveUserMemory error:", e.message);
  }
}

async function dbGetUserMemories(userId, limit = 20) {
  try {
    const res = await db.query(
      `SELECT memory_type, content, importance, created_at
       FROM user_memory
       WHERE user_id = $1
       ORDER BY importance DESC, created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.rows || [];
  } catch (e) {
    console.error("dbGetUserMemories error:", e.message);
    return [];
  }
}

async function loadUserContext(userId) {
  const [
    recent7,
    recent30,
    challenge,
    pr,
    profile,
    memories,
    history,
  ] = await Promise.all([
    dbGetActivities(userId, 7),
    dbGetActivities(userId, 30),
    dbGetChallenge(userId),
    dbGetPR(userId),
    dbGetUserProfile(userId),
    dbGetUserMemories(userId, 20),
    getConversationHistory(userId, 12),
  ]);

  const stats7 = calcStatsFromActivities(recent7);
  const stats30 = calcStatsFromActivities(recent30);

  let context = `=== USER CONTEXT ===\n`;

  if (profile) {
    context += `\n=== PROFILE ===\n`;
    context += `Goal: ${profile.goal || "-"}\n`;
    context += `Target Distance: ${profile.target_distance || "-"} km\n`;
    context += `Target Pace: ${profile.target_pace || "-"} /km\n`;
    context += `Running Level: ${profile.running_level || "-"}\n`;
    context += `Injury Note: ${profile.injury_note || "-"}\n`;
    context += `Available Days: ${profile.available_days || "-"}\n`;
    context += `Motivation Style: ${profile.motivation_style || "-"}\n`;
  }

  if (memories.length > 0) {
    context += `\n=== IMPORTANT MEMORIES ===\n`;
    for (const m of memories) {
      context += `- [${m.memory_type}] ${m.content}\n`;
    }
  }

  if (stats7) {
    context += `\n=== LAST 7 DAYS ===\n`;
    context += `Runs: ${stats7.count}\n`;
    context += `Distance: ${stats7.totalDistance.toFixed(2)} km\n`;
    context += `Calories: ${stats7.totalCalories.toFixed(0)} kcal\n`;
    context += `Avg Pace: ${stats7.avgPaceMin}:${String(stats7.avgPaceSec).padStart(2, "0")} /km\n`;
  }

  if (stats30) {
    context += `\n=== LAST 30 DAYS ===\n`;
    context += `Runs: ${stats30.count}\n`;
    context += `Distance: ${stats30.totalDistance.toFixed(2)} km\n`;
    context += `Calories: ${stats30.totalCalories.toFixed(0)} kcal\n`;
  }

  if (challenge) {
    context += `\n=== CURRENT CHALLENGE ===\n`;
    context += `Goal: ${challenge.goal} km\n`;
    context += `Deadline: ${challenge.deadline}\n`;
    context += `Start Date: ${challenge.startDate}\n`;
  }

  if (pr) {
    context += `\n=== PERSONAL RECORD ===\n`;
    context += `Longest Run: ${pr.longestRun} km\n`;
    context += `Fastest Pace: ${pr.fastestPace} /km\n`;
  }

  return { context, history, profile, memories, recent7, recent30, challenge, pr };
}

async function extractMemoryFromChat(userId, userText, assistantText) {
  try {
    const prompt = `
อ่านข้อความต่อไปนี้ แล้วดึงข้อมูลระยะยาวที่ควรจำเกี่ยวกับนักวิ่งคนนี้

User:
${userText}

Assistant:
${assistantText}

ให้ตอบเป็น JSON เท่านั้น ห้ามมีคำอธิบายอื่น

Schema:
{
  "profile": {
    "goal": null,
    "target_distance": null,
    "target_pace": null,
    "running_level": null,
    "injury_note": null,
    "available_days": null,
    "motivation_style": null
  },
  "memories": [
    {
      "memory_type": "goal|injury|preference|schedule|motivation|note",
      "content": "ข้อความที่ควรจำ",
      "importance": 1
    }
  ]
}

กติกา:
- เก็บเฉพาะข้อมูลที่น่าจะใช้ได้นาน
- อย่าเก็บข้อความทั่วไป
- ถ้าไม่มีข้อมูลใหม่ ให้ profile ทุกช่องเป็น null และ memories เป็น []
`;

    const raw = await analyzeWithClaude(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]);

    if (data.profile) {
      await dbSaveUserProfile(userId, data.profile);
    }

    if (Array.isArray(data.memories)) {
      for (const m of data.memories) {
        if (!m || !m.content) continue;
        await dbSaveUserMemory(userId, m);
      }
    }
  } catch (e) {
    console.error("extractMemoryFromChat error:", e.message);
  }
}

// ===== DATA STORE =====
const userSessions = {};
const userChallenges = {};
const userActivities = {};
const userPRs = {};
const stravaTokens = {};

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

  const avgPaceDecimal =
    paces.length > 0 ? paces.reduce((s, p) => s + p, 0) / paces.length : 0;

  const avgPaceMin = Math.floor(avgPaceDecimal);
  const avgPaceSec = Math.round((avgPaceDecimal - avgPaceMin) * 60);

  return {
    count: activities.length,
    totalDistance,
    totalCalories,
    avgPaceMin,
    avgPaceSec,
    activities,
  };
}

function paceDecimalToText(pace) {
  if (!pace || pace <= 0) return "-";
  const min = Math.floor(pace);
  const sec = Math.round((pace - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function durationMinToText(duration) {
  if (!duration || duration <= 0) return "-";
  const totalSeconds = Math.round(duration * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ===== STRAVA HELPERS =====
async function refreshStravaToken(lineUserId) {
  const tokenData = await dbGetStravaToken(lineUserId);
  if (!tokenData) return null;

  if (tokenData.expires_at > Date.now() / 1000 + 60) {
    return tokenData.access_token;
  }

  try {
    const res = await axios.post("https://www.strava.com/oauth/token", {
      client_id: CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token,
    });

    const newTokenData = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_at: res.data.expires_at,
    };

    await dbSaveStravaToken(lineUserId, newTokenData);
    return res.data.access_token;
  } catch (e) {
    console.error("Strava refresh error:", e.message);
    return null;
  }
}

const stravaCache = {};

async function getStravaActivities(lineUserId, days = 7) {
  const cacheKey = `${lineUserId}_${days}`;
  const cached = stravaCache[cacheKey];

  if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000) {
    return cached.data;
  }

  const token = await refreshStravaToken(lineUserId);
  if (!token) return null;

  try {
    const after = Math.floor((Date.now() - days * 86400000) / 1000);

    const res = await axios.get("https://www.strava.com/api/v3/athlete/activities", {
      headers: { Authorization: `Bearer ${token}` },
      params: { after, per_page: 50 },
      timeout: 10000,
    });

    stravaCache[cacheKey] = { data: res.data, timestamp: Date.now() };
    return res.data;
  } catch (e) {
    console.error("Strava activities error:", e.message);
    return null;
  }
}

function convertStravaToActivities(stravaData) {
  return stravaData
    .filter(a => a.type === "Run")
    .map(a => {
      const dist = a.distance / 1000;
      const pace = dist > 0 ? (a.moving_time / 60) / dist : 0;

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

    if (stravaData) {
      const converted = convertStravaToActivities(stravaData);

      for (const a of converted) {
        await dbSaveActivity(userId, a);
      }

      return converted;
    }
  }

  const dbActivities = await dbGetActivities(userId, days);
  if (dbActivities.length > 0) return dbActivities;

  return getRecentActivities(userId, days);
}

// ===== PR CHECKER =====
function checkPR(userId, activity) {
  if (!userPRs[userId]) userPRs[userId] = { longestRun: 0, fastestPace:null };

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

    prs.push(
      `⚡ PR Pace! ${pMin}:${String(pSec).padStart(2, "0")}/km (เดิม ${oldMin}:${String(oldSec).padStart(2, "0")}/km)`
    );

    pr.fastestPace = activity.pace;
  }

  dbSavePR(userId, pr);

  return prs.length > 0 ? prs : null;
}

// ===== GPX PARSER =====
function parseGPX(xmlText) {
  try {
    const points = [];
    const trkptRegex =
      /<trkpt lat="([\d.-]+)" lon="([\d.-]+)"[^>]*>[\s\S]*?<ele>([\d.]+)<\/ele>[\s\S]*?<time>([^<]+)<\/time>/g;

    let match;

    while ((match = trkptRegex.exec(xmlText)) !== null) {
      points.push({
        lat: parseFloat(match[1]),
        lon: parseFloat(match[2]),
        ele: parseFloat(match[3]),
        time: new Date(match[4]),
      });
    }

    if (points.length < 2) return null;

    let totalDist = 0;
    let totalElevGain = 0;

    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];

      const R = 6371;
      const dLat = (p2.lat - p1.lat) * Math.PI / 180;
      const dLon = (p2.lon - p1.lon) * Math.PI / 180;

      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(p1.lat * Math.PI / 180) *
          Math.cos(p2.lat * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;

      totalDist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      if (p2.ele > p1.ele) {
        totalElevGain += p2.ele - p1.ele;
      }
    }

    const duration =
      (points[points.length - 1].time - points[0].time) / 1000 / 60;

    const pace = totalDist > 0 ? duration / totalDist : 0;

    return {
      date: points[0].time.toISOString(),
      distance: parseFloat(totalDist.toFixed(2)),
      pace: parseFloat(pace.toFixed(4)),
      duration: parseFloat(duration.toFixed(1)),
      elevGain: parseFloat(totalElevGain.toFixed(0)),
      calories: Math.round(totalDist * 60),
      source: "GPX",
    };
  } catch (e) {
    console.error("GPX parse error:", e.message);
    return null;
  }
}
// ===== CLAUDE HELPERS =====
async function analyzeWithClaudeWithHistory(prompt, history = []) {
  try {
    const safeHistory = Array.isArray(history)
      ? history.filter(m => m.role && m.content).slice(-12)
      : [];

    const messages = [
      ...safeHistory,
      { role: "user", content: prompt },
    ];

    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: `คุณคืออาจารย์นักวิ่ง AI ผู้ชายที่มีประสบการณ์สูง ผ่านการแข่งมาราธอนและอัลตร้ามาราธอนมาแล้วนับไม่ถ้วน

บุคลิก:
- เป็นกันเอง สนุก เฮฮา
- ใช้คำว่า "เฮ้ย", "โอ้โห", "เจ๋งมาก!" บ้างเป็นครั้งคราว
- เรียกตัวเองว่า "อาจารย์" หรือ "ผม"
- ตอบภาษาไทยเป็นหลัก
- motivate ผู้ใช้เสมอ
- ถ้าขี้เกียจให้แซวเบา ๆ ไม่ดุ
- ใช้ข้อมูล user context ให้มากที่สุด
- ถ้าข้อมูลไม่พอ ให้ถามต่อแบบธรรมชาติ`,
      messages,
    });

    return res.content?.[0]?.text || "ขอโทษครับ อาจารย์ยังตอบไม่ได้ตอนนี้";
  } catch (e) {
    console.error("Claude with history error:", e.message);
    return await analyzeWithClaude(prompt);
  }
}

async function analyzeWithClaude(prompt, imageBase64 = null) {
  try {
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
      messages.push({
        role: "user",
        content: prompt,
      });
    }

    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: `คุณคืออาจารย์นักวิ่ง AI ผู้ชายที่มีประสบการณ์สูง มีความรู้ลึกด้านการวิ่ง โภชนาการ และการฝึกซ้อม

บุคลิก:
- เป็นกันเอง สนุก เฮฮา
- ใช้ภาษาไทยเป็นหลัก
- เรียกตัวเองว่า "อาจารย์" หรือ "ผม"
- ชอบ motivate และฉลองความสำเร็จเล็ก ๆ
- ถ้าผู้ใช้ส่งรูปผลการวิ่ง ให้อ่านค่าและคืน JSON บรรทัดแรกเสมอ แต่ห้ามอธิบาย JSON ให้ user เห็น

เมื่อวิเคราะห์รูปผลการวิ่ง ให้ return JSON แบบนี้ในบรรทัดแรก:
{"distance": 8.5, "pace": 5.5, "duration": 46.75, "calories": 420, "elevGain": 120, "date": "2026-05-16"}

pace เป็นตัวเลขทศนิยม เช่น 5:30/km = 5.5`,
      messages,
    });

    return res.content?.[0]?.text || "";
  } catch (e) {
    console.error("Claude error:", e.message);
    return "ขอโทษครับ ตอนนี้ AI วิเคราะห์ไม่ได้ชั่วคราว ลองใหม่อีกครั้งนะครับ";
  }
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
  } catch (e) {
    return null;
  }
}

// ===== RUNNING ESTIMATION HELPERS =====
function estimateHRZones(paceDecimal) {
  if (!paceDecimal || paceDecimal <= 0) {
    return { z1: 10, z2: 40, z3: 35, z4: 15 };
  }

  if (paceDecimal < 4.5) {
    return { z1: 5, z2: 15, z3: 30, z4: 50 };
  }

  if (paceDecimal < 5.5) {
    return { z1: 5, z2: 25, z3: 45, z4: 25 };
  }

  if (paceDecimal < 6.5) {
    return { z1: 10, z2: 45, z3: 35, z4: 10 };
  }

  if (paceDecimal < 7.5) {
    return { z1: 15, z2: 55, z3: 25, z4: 5 };
  }

  return { z1: 20, z2: 60, z3: 15, z4: 5 };
}

function estimateCadence(paceDecimal) {
  if (!paceDecimal || paceDecimal <= 0) return 160;
  if (paceDecimal < 4.5) return 185;
  if (paceDecimal < 5.5) return 178;
  if (paceDecimal < 6.5) return 170;
  if (paceDecimal < 7.5) return 163;
  return 155;
}

function buildHRZoneBar(zones) {
  const total = zones.z1 + zones.z2 + zones.z3 + zones.z4;

  const z1w = Math.round((zones.z1 / total) * 10);
  const z2w = Math.round((zones.z2 / total) * 10);
  const z3w = Math.round((zones.z3 / total) * 10);
  const z4w = Math.max(1, 10 - z1w - z2w - z3w);

  const zoneColors = ["#64B5F6", "#81C784", "#FFD54F", "#FF7043"];
  const zoneLabels = ["Z1", "Z2", "Z3", "Z4"];
  const zoneWidths = [z1w, z2w, z3w, z4w];
  const zonePcts = [zones.z1, zones.z2, zones.z3, zones.z4];

  return [
    {
      type: "text",
      text: "❤️ Heart Rate Zones",
      size: "sm",
      color: "#555555",
      weight: "bold",
      margin: "md",
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "sm",
      height: "16px",
      cornerRadius: "4px",
      contents: zoneWidths.map((w, i) => ({
        type: "box",
        layout: "vertical",
        flex: w || 1,
        backgroundColor: zoneColors[i],
        contents: [],
      })),
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "xs",
      contents: zoneLabels.map((label, i) => ({
        type: "box",
        layout: "vertical",
        flex: 1,
        alignItems: "center",
        contents: [
          {
            type: "text",
            text: label,
            size: "xxs",
            color: zoneColors[i],
            weight: "bold",
            align: "center",
          },
          {
            type: "text",
            text: `${zonePcts[i]}%`,
            size: "xxs",
            color: "#888888",
            align: "center",
          },
        ],
      })),
    },
  ];
}

// ===== FLEX MESSAGE BUILDERS =====
function buildTodayStatsFlexMessage(activity = {}) {
  const distance = activity.distance || 0;
  const pace = activity.paceText || paceDecimalToText(activity.pace);
  const duration = activity.durationText || durationMinToText(activity.duration);
  const calories = activity.calories || 0;
  const cadence = activity.cadence || estimateCadence(activity.pace);
  const elevGain = activity.elevGain || 0;

  return {
    type: "flex",
    altText: "สถิติวันนี้",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        backgroundColor: "#FFFFFF",
        contents: [
          {
            type: "text",
            text: "สถิติวันนี้",
            size: "xl",
            weight: "bold",
            color: "#111111",
          },
          {
            type: "text",
            text: "ผลการวิ่งล่าสุดของคุณ",
            size: "sm",
            color: "#8A8A8A",
            margin: "sm",
          },
          {
            type: "box",
            layout: "horizontal",
            margin: "xl",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: `${distance.toFixed ? distance.toFixed(2) : distance}`,
                    size: "xxl",
                    weight: "bold",
                    color: "#111111",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "km",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: pace || "-",
                    size: "xxl",
                    weight: "bold",
                    color: "#111111",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "/km",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: duration || "-",
                    size: "xl",
                    weight: "bold",
                    color: "#111111",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "เวลา",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
            ],
          },
          {
          type: "separator",
          margin: "xl",
          },

          ...buildHRZoneBar(estimateHRZones(activity.pace)),

          {
            type: "separator",
            margin: "xl",
          },
          
          {
            type: "box",
            layout: "horizontal",
            margin: "lg",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  { type: "text", text: "🔥", size: "lg", align: "center" },
                  {
                    type: "text",
                    text: `${calories}`,
                    size: "md",
                    weight: "bold",
                    align: "center",
                    color: "#111111",
                  },
                  {
                    type: "text",
                    text: "kcal",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  { type: "text", text: "👟", size: "lg", align: "center" },
                  {
                    type: "text",
                    text: `${cadence}`,
                    size: "md",
                    weight: "bold",
                    align: "center",
                    color: "#111111",
                  },
                  {
                    type: "text",
                    text: "cadence",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  { type: "text", text: "⛰️", size: "lg", align: "center" },
                  {
                    type: "text",
                    text: `${elevGain}m`,
                    size: "md",
                    weight: "bold",
                    align: "center",
                    color: "#111111",
                  },
                  {
                    type: "text",
                    text: "elev gain",
                    size: "xs",
                    color: "#8A8A8A",
                    align: "center",
                  },
                ],
              },
            ],
          },
          {
            type: "box",
            layout: "vertical",
            margin: "xl",
            paddingAll: "16px",
            cornerRadius: "20px",
            backgroundColor: "#F5F5F7",
            contents: [
              {
                type: "text",
                text: "AI Insight",
                size: "sm",
                weight: "bold",
                color: "#111111",
              },
              {
                type: "text",
                text: "วันนี้ pace ค่อนข้างนิ่งดี ลองคุมให้อยู่โซนสบาย ๆ เพื่อสะสมความต่อเนื่อง",
                size: "sm",
                color: "#555555",
                wrap: true,
                margin: "sm",
              },
            ],
          },
          {
            type: "button",
            margin: "lg",
            style: "primary",
            color: "#06C755",
            action: {
              type: "postback",
              label: "ดูคำแนะนำวันนี้",
              data: "action=today_recommendation",
            },
          },
        ],
      },
    },
  };
}

function buildStatsFlexMessage(stats, label) {
  if (!stats) return null;

  const { totalDistance, avgPaceMin, avgPaceSec, totalCalories, activities } = stats;

  const avgPaceDecimal = avgPaceMin + avgPaceSec / 60;
  const cadence = estimateCadence(avgPaceDecimal);
  const hrZones = estimateHRZones(avgPaceDecimal);

  const activityRows = activities.slice(0, 5).map((a) => {
    const date = new Date(a.date).toLocaleDateString("th-TH", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

    return {
      type: "box",
      layout: "horizontal",
      paddingTop: "4px",
      contents: [
        {
          type: "text",
          text: date,
          size: "sm",
          color: "#555555",
          flex: 3,
        },
        {
          type: "text",
          text: `${(a.distance || 0).toFixed(2)}km`,
          size: "sm",
          color: "#111111",
          flex: 2,
          align: "center",
        },
        {
          type: "text",
          text: a.pace ? `${paceDecimalToText(a.pace)}/km` : "-",
          size: "sm",
          color: "#E8703A",
          flex: 3,
          align: "end",
        },
      ],
    };
  });

  return {
    type: "flex",
    altText: `🏃 สรุปการวิ่ง${label}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#E8703A",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🏃 อาจารย์นักวิ่ง",
            color: "#ffffff",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: `สรุปการวิ่ง${label}`,
            color: "#ffffff99",
            size: "xs",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: `${totalDistance.toFixed(1)}`,
                    size: "xl",
                    weight: "bold",
                    color: "#E8703A",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "km รวม",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: avgPaceMin > 0 ? `${avgPaceMin}:${String(avgPaceSec).padStart(2, "0")}` : "-",
                    size: "xl",
                    weight: "bold",
                    color: "#E8703A",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "pace /km",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: `${cadence}`,
                    size: "xl",
                    weight: "bold",
                    color: "#E8703A",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "spm รอบขา",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
            ],
            paddingBottom: "12px",
          },
          { type: "separator" },
          ...buildHRZoneBar(hrZones),
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "horizontal",
            paddingTop: "8px",
            paddingBottom: "4px",
            contents: [
              {
                type: "text",
                text: "วันที่",
                size: "xs",
                color: "#888888",
                flex: 3,
              },
              {
                type: "text",
                text: "ระยะ",
                size: "xs",
                color: "#888888",
                flex: 2,
                align: "center",
              },
              {
                type: "text",
                text: "Pace",
                size: "xs",
                color: "#888888",
                flex: 3,
                align: "end",
              },
            ],
          },
          ...activityRows,
          { type: "separator", margin: "12px" },
          {
            type: "box",
            layout: "horizontal",
            paddingTop: "8px",
            contents: [
              {
                type: "text",
                text: "🔥 แคลอรี่รวม",
                size: "sm",
                color: "#555555",
              },
              {
                type: "text",
                text: `${totalCalories.toFixed(0)} kcal`,
                size: "sm",
                color: "#E8703A",
                align: "end",
                weight: "bold",
              },
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
    const date = new Date(a.date).toLocaleDateString("th-TH", {
      weekday: "long",
      day: "numeric",
      month: "short",
    });

    return {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#E8703A",
        paddingAll: "12px",
        contents: [
          {
            type: "text",
            text: `📍 ${a.source || "Manual"}`,
            color: "#ffffff",
            size: "xs",
          },
          {
            type: "text",
            text: date,
            color: "#ffffff",
            size: "sm",
            weight: "bold",
            wrap: true,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            paddingBottom: "8px",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: `${(a.distance || 0).toFixed(2)}`,
                    size: "xxl",
                    weight: "bold",
                    color: "#E8703A",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "km",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: a.pace ? paceDecimalToText(a.pace) : "-",
                    size: "xl",
                    weight: "bold",
                    color: "#333333",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "/km",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
            ],
          },
          { type: "separator" },
          {
            type: "box",
            layout: "horizontal",
            paddingTop: "8px",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: a.duration ? `${Math.floor(a.duration)}` : "-",
                    size: "sm",
                    color: "#333333",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "นาที",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: a.elevGain ? `${a.elevGain}m` : "-",
                    size: "sm",
                    color: "#333333",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "elevation",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: a.calories ? `${a.calories}` : "-",
                    size: "sm",
                    color: "#333333",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "kcal",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  });

  return {
    type: "flex",
    altText: "📋 ประวัติวิ่ง 5 ครั้งล่าสุด",
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
}

function buildChallengeFlexMessage(userId, currentKm) {
  const challenge = userChallenges[userId];
  if (!challenge) return null;

  const progress = Math.min((currentKm / challenge.goal) * 100, 100);
  const remaining = Math.max(challenge.goal - currentKm, 0);
  const daysLeft = Math.max(
    Math.ceil((new Date(challenge.deadline) - new Date()) / 86400000),
    0
  );

  const progressBar =
    "█".repeat(Math.floor(progress / 10)) +
    "░".repeat(10 - Math.floor(progress / 10));

  const color =
    progress >= 100 ? "#27AE60" : progress >= 50 ? "#E8703A" : "#E74C3C";

  return {
    type: "flex",
    altText: `🎯 Challenge: ${challenge.goal}km`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: color,
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🎯 Challenge ของคุณ",
            color: "#ffffff",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: progress >= 100 ? "🏆 สำเร็จแล้ว!" : `เหลืออีก ${daysLeft} วัน`,
            color: "#ffffff99",
            size: "xs",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            paddingBottom: "12px",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: `${currentKm.toFixed(1)}`,
                    size: "xxl",
                    weight: "bold",
                    color,
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "km วิ่งแล้ว",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 1,
                alignItems: "center",
                contents: [
                  {
                    type: "text",
                    text: `${challenge.goal}`,
                    size: "xxl",
                    weight: "bold",
                    color: "#333333",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: "km เป้าหมาย",
                    size: "xs",
                    color: "#888888",
                    align: "center",
                  },
                ],
              },
            ],
          },
          {
            type: "text",
            text: `${progressBar} ${progress.toFixed(0)}%`,
            size: "sm",
            color,
            align: "center",
            margin: "md",
          },
          { type: "separator", margin: "12px" },
          {
            type: "box",
            layout: "horizontal",
            paddingTop: "8px",
            contents: [
              {
                type: "text",
                text:
                  progress >= 100
                    ? "🎉 ทำได้แล้วครับ!"
                    : `เหลืออีก ${remaining.toFixed(1)} km`,
                size: "sm",
                color: "#555555",
              },
              {
                type: "text",
                text: `${daysLeft} วัน`,
                size: "sm",
                color,
                align: "end",
                weight: "bold",
              },
            ],
          },
        ],
      },
    },
  };
}

function buildPRFlexMessage(prs, activityName) {
  return {
    type: "flex",
    altText: "🏅 คุณทำ PR แล้ว!",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#F39C12",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🏅 Personal Record!",
            color: "#ffffff",
            size: "md",
            weight: "bold",
            align: "center",
          },
          {
            type: "text",
            text: "ยอดเยี่ยมมากครับ! 🎉",
            color: "#ffffff99",
            size: "sm",
            align: "center",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: activityName || "กิจกรรมล่าสุด",
            size: "sm",
            color: "#888888",
            align: "center",
          },
          ...prs.map(pr => ({
            type: "text",
            text: pr,
            size: "sm",
            color: "#333333",
            margin: "md",
            wrap: true,
            align: "center",
          })),
          {
            type: "text",
            text: "อาจารย์ขอปรบมือให้เลย 💪",
            size: "sm",
            color: "#E8703A",
            margin: "lg",
            align: "center",
            weight: "bold",
          },
        ],
      },
    },
  };
}

function buildUpdateNotificationFlex() {
  return {
    type: "flex",
    altText: "🆕 อาจารย์นักวิ่ง AI Beta 2.0",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1A1A2E",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "🏃 อาจารย์นักวิ่ง AI",
            color: "#E8703A",
            size: "md",
            weight: "bold",
          },
          {
            type: "text",
            text: "Beta 2.0 — มีอะไรใหม่บ้าง?",
            color: "#ffffff",
            size: "sm",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "✨ AI จำเป้าหมายและบริบทของคุณได้",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "📸 ส่ง screenshot ผลการวิ่งให้ AI วิเคราะห์ได้",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "📊 สรุปสถิติรายวันและรายสัปดาห์",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "🎯 ตั้ง Challenge พร้อม Progress Bar",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "🏅 ตรวจจับ PR อัตโนมัติ",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
        ],
      },
    },
  };
}

// ===== LINE MESSAGING =====
function makeQuickReply(items) {
  return {
    items: items.map(i => ({
      type: "action",
      action: {
        type: "message",
        label: i.label,
        text: i.text,
      },
    })),
  };
}

async function pushMessage(userId, text, quickReply = null) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [
        {
          type: "text",
          text,
          ...(quickReply ? { quickReply } : {}),
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

async function replyMessage(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: Array.isArray(messages) ? messages : [messages],
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

async function pushFlexMessage(userId, flexContent) {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [flexContent],
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
}

async function replyText(replyToken, text, quickReply = null) {
  await replyMessage(replyToken, {
    type: "text",
    text,
    ...(quickReply ? { quickReply } : {}),
  });
}

async function replyFlex(replyToken, flexContent) {
  await replyMessage(replyToken, flexContent);
}

// ===== MAIN AI CHAT FLOW =====
async function handleAIChat(userId, text, replyToken) {
  await saveConversation(userId, "user", text);

  const { context, history } = await loadUserContext(userId);

  const prompt = `
${context}

User message:
${text}

กรุณาตอบเป็นภาษาไทยในบทบาทอาจารย์นักวิ่ง AI
ตอบให้เหมาะกับข้อมูลจริงของ user
ถ้าข้อมูลยังไม่พอ ให้ถามต่อแบบเป็นธรรมชาติ
อย่าตอบยาวเกินไป
`;

  const answer = await analyzeWithClaudeWithHistory(prompt, history);

  await saveConversation(userId, "assistant", answer);

  extractMemoryFromChat(userId, text, answer);

  await replyText(replyToken, answer);
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];

  for (const event of events) {
    const userId =
      event.source?.userId ||
      event.source?.groupId ||
      event.source?.roomId;

    if (!userId) continue;

    try {
      if (event.type === "follow") {
        await pushMessage(
          userId,
          "🏃 สวัสดีครับ! ยินดีต้อนรับสู่อาจารย์นักวิ่ง AI\n\nส่งรูปผลการวิ่ง, ไฟล์ GPX หรือพิมพ์คุยกับอาจารย์ได้เลยครับ 💪"
        );

        await pushFlexMessage(userId, buildUpdateNotificationFlex());
        continue;
      }

      if (event.type === "postback") {
        const data = event.postback?.data || "";

        if (data === "action=today_stats") {
          const activities = await getActivitiesForUser(userId, 7);
          const latest = activities[0];

          if (!latest) {
            await replyText(event.replyToken, "ยังไม่มีข้อมูลการวิ่งล่าสุดครับ ส่ง screenshot หรือเชื่อม Strava ก่อนได้เลย");
            continue;
          }

          await replyFlex(event.replyToken, buildTodayStatsFlexMessage(latest));
          continue;
        }

        if (data === "action=today_recommendation") {
          await handleAIChat(userId, "ช่วยแนะนำการซ้อมวันนี้จากสถิติล่าสุดของผม", event.replyToken);
          continue;
        }

        if (data === "action=weekly_summary") {
          const activities = await getActivitiesForUser(userId, 7);
          const stats = calcStatsFromActivities(activities);

          if (!stats) {
            await replyText(event.replyToken, "ยังไม่มีข้อมูลสัปดาห์นี้ครับ");
            continue;
          }

          await replyFlex(event.replyToken, buildStatsFlexMessage(stats, "สัปดาห์นี้"));
          continue;
        }

        await handleAIChat(userId, `User กดเมนู: ${data}`, event.replyToken);
        continue;
      }

      if (event.type === "message") {
        const message = event.message;

        if (message.type === "text") {
          const text = message.text.trim();

          if (text === "/update") {
            await replyFlex(event.replyToken, buildUpdateNotificationFlex());
            continue;
          }

          if (text === "/today" || text === "สถิติวันนี้") {
            const activities = await getActivitiesForUser(userId, 7);
            const latest = activities[0];

            if (!latest) {
              await replyText(event.replyToken, "ยังไม่มีข้อมูลการวิ่งล่าสุดครับ ส่ง screenshot ผลการวิ่งมาก่อนได้เลย 📸");
              continue;
            }

            await replyFlex(event.replyToken, buildTodayStatsFlexMessage(latest));
            continue;
          }

          if (text === "/summary" || text === "สรุปสัปดาห์") {
            const activities = await getActivitiesForUser(userId, 7);
            const stats = calcStatsFromActivities(activities);

            if (!stats) {
              await replyText(event.replyToken, "ยังไม่มีข้อมูลสัปดาห์นี้ครับ");
              continue;
            }

            await replyFlex(event.replyToken, buildStatsFlexMessage(stats, "สัปดาห์นี้"));
            continue;
          }

          if (text === "/history" || text === "ประวัติล่าสุด") {
            const activities = await getActivitiesForUser(userId, 30);
            const carousel = buildCarouselMessage(activities);

            if (!carousel) {
              await replyText(event.replyToken, "ยังไม่มีประวัติการวิ่งครับ");
              continue;
            }

            await replyFlex(event.replyToken, carousel);
            continue;
          }

          await handleAIChat(userId, text, event.replyToken);
          continue;
        }

        if (message.type === "image") {
          const imageRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${message.id}/content`,
            {
              headers: {
                Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
              },
              responseType: "arraybuffer",
            }
          );

          const imageBase64 = Buffer.from(imageRes.data).toString("base64");

          const analysis = await analyzeWithClaude(
            "ช่วยอ่านผลการวิ่งจากรูปนี้ ดึง distance, pace, duration, calories, elevation, date แล้ววิเคราะห์เป็นภาษาไทย",
            imageBase64
          );

          const activity = extractActivityFromResponse(analysis);

          if (activity) {
            await dbSaveActivity(userId, activity);
            saveActivity(userId, activity);

            const prs = checkPR(userId, activity);

            const cleanText = analysis.replace(/\{[\s\S]*?\}/, "").trim();

            await saveConversation(userId, "user", "[ส่งรูปผลการวิ่ง]");
            await saveConversation(userId, "assistant", cleanText);

            const replies = [
              {
                type: "text",
                text: cleanText || "อาจารย์อ่านผลการวิ่งให้แล้วครับ 💪",
              },
              buildTodayStatsFlexMessage(activity),
            ];

            if (prs) {
              replies.push(buildPRFlexMessage(prs, activity.name || "ผลการวิ่งล่าสุด"));
            }

            await replyMessage(event.replyToken, replies);
          } else {
            await replyText(
              event.replyToken,
              "อาจารย์ยังอ่านค่าสถิติจากรูปนี้ไม่ชัดครับ ลองส่ง screenshot ที่เห็นระยะ/pace/เวลา ชัด ๆ อีกครั้งนะครับ 📸"
            );
          }

          continue;
        }

        if (message.type === "file") {
          const fileName = message.fileName || "";

          if (!fileName.toLowerCase().endsWith(".gpx")) {
            await replyText(
              event.replyToken,
              "ตอนนี้รองรับไฟล์ .gpx ครับ หรือส่งรูป screenshot ผลการวิ่งก็ได้ 📸"
            );
            continue;
          }

          const fileRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${message.id}/content`,
            {
              headers: {
                Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
              },
              responseType: "text",
            }
          );

          const gpxData = parseGPX(fileRes.data);

          if (!gpxData) {
            await replyText(event.replyToken, "อ่านไฟล์ GPX ไม่ได้ครับ ลองส่งไฟล์ใหม่อีกครั้งนะครับ");
            continue;
          }

          await dbSaveActivity(userId, gpxData);
          saveActivity(userId, gpxData);

          const prs = checkPR(userId, gpxData);

          const analysis = await analyzeWithClaude(`
วิเคราะห์การวิ่งนี้:
ระยะ ${gpxData.distance} km
pace ${paceDecimalToText(gpxData.pace)} /km
เวลา ${durationMinToText(gpxData.duration)}
elevation ${gpxData.elevGain} m

ตอบเป็นภาษาไทยแบบอาจารย์นักวิ่ง AI
`);

          await saveConversation(userId, "user", "[ส่งไฟล์ GPX]");
          await saveConversation(userId, "assistant", analysis);

          const replies = [
            {
              type: "text",
              text: analysis,
            },
            buildTodayStatsFlexMessage(gpxData),
          ];

          if (prs) {
            replies.push(buildPRFlexMessage(prs, "GPX Run"));
          }

          await replyMessage(event.replyToken, replies);
          continue;
        }
      }
    } catch (e) {
      console.error("Webhook error:", e);

      try {
        if (event.replyToken) {
          await replyText(
            event.replyToken,
            "ขอโทษครับ ระบบมีปัญหาชั่วคราว ลองใหม่อีกครั้งนะครับ"
          );
        }
      } catch (_) {}
    }
  }
});

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("AI Running Coach LINE Bot is running ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ai-running-coach-line-bot",
    time: new Date().toISOString(),
  });
});

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}); 
