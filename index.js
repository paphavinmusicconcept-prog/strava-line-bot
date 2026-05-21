const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");
const logger = require("./src/logger");
const { createConfig, createDbSsl, validateConfig } = require("./src/config");
const { createTokenCrypto } = require("./src/security/tokenCrypto");
const { isLineSignatureValid } = require("./src/security/lineSignature");
const { createLineService } = require("./src/services/lineService");
const { createClaudeService } = require("./src/services/claudeService");
const { runMigrations } = require("./src/db/migrations");
const { createActivityRepository } = require("./src/repositories/activityRepository");
const { assertRateLimit } = require("./src/services/rateLimitService");
const { withRetry } = require("./src/utils/retry");
const {
  createActivityFingerprint,
  createContentFingerprint,
} = require("./src/utils/activityFingerprint");

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  },
}));

const CONFIG = createConfig();
const dbSsl = createDbSsl();

const { encryptTokenData, decryptTokenData } = createTokenCrypto({
  encryptionKey: CONFIG.TOKEN_ENCRYPTION_KEY,
});

function normalizeLookbackDays(days, fallback = 7) {
  const parsed = Number.parseInt(days, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 365);
}

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ===== PostgreSQL DATABASE =====
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: dbSsl,
});

const activityRepo = createActivityRepository(db, {
  estimateCadence,
  normalizeLookbackDays,
});

async function initDB() {
  try {
    await runMigrations(db);
    logger.info("Database initialized");

    const tokens = await db.query(`SELECT * FROM strava_tokens`);
    for (const row of tokens.rows) {
      const tokenData = decryptTokenData(row);
      stravaTokens[row.user_id] = tokenData;

      if (
        CONFIG.TOKEN_ENCRYPTION_KEY &&
        (!String(row.access_token || "").startsWith("enc:v1:") ||
          !String(row.refresh_token || "").startsWith("enc:v1:"))
      ) {
        await dbSaveStravaToken(row.user_id, tokenData);
      }
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
    logger.error("DB init error", { error: e.message });
    throw e;
  }
}

// ===== DB HELPERS =====
async function dbSaveActivity(userId, activity) {
  try {
    await activityRepo.save(userId, activity);
  } catch (e) {
    logger.error("DB save activity error", { error: e.message, userId });
    saveActivity(userId, activity);
  }
}

async function dbGetActivities(userId, days = 7) {
  try {
    return await activityRepo.findRecent(userId, days);
  } catch (e) {
    logger.error("DB get activities error", { error: e.message, userId, days });
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
    const encryptedTokenData = encryptTokenData(tokenData);
    await db.query(
      `INSERT INTO strava_tokens (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET access_token=$2, refresh_token=$3, expires_at=$4, updated_at=NOW()`,
      [
        userId,
        encryptedTokenData.access_token,
        encryptedTokenData.refresh_token,
        encryptedTokenData.expires_at,
      ]
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
    return decryptTokenData(res.rows[0]);
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

const WORKFLOW_SESSION_MEMORY_TYPE = "workflow_session";
const WORKFLOW_SESSION_TTL_MS = 30 * 60 * 1000;

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

    await db.query(
      `DELETE FROM user_memory
       WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM user_memory
         WHERE user_id = $1
         ORDER BY importance DESC, created_at DESC
         LIMIT 100
       )`,
      [userId]
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
       AND memory_type <> $3
       ORDER BY importance DESC, created_at DESC
       LIMIT $2`,
      [userId, limit, WORKFLOW_SESSION_MEMORY_TYPE]
    );
    return res.rows || [];
  } catch (e) {
    console.error("dbGetUserMemories error:", e.message);
    return [];
  }
}

function isWorkflowSessionFresh(session) {
  return !!(
    session &&
    session.flow &&
    (!session.expiresAt || Number(session.expiresAt) > Date.now())
  );
}

async function dbSaveWorkflowSession(userId, session) {
  if (!userId || !session) return null;

  const stored = {
    ...session,
    updatedAt: Date.now(),
    expiresAt: Date.now() + WORKFLOW_SESSION_TTL_MS,
  };

  userSessions[userId] = stored;

  try {
    await db.query(
      `DELETE FROM user_memory
       WHERE user_id = $1 AND memory_type = $2`,
      [userId, WORKFLOW_SESSION_MEMORY_TYPE]
    );

    await db.query(
      `INSERT INTO user_memory (user_id, memory_type, content, importance)
       VALUES ($1, $2, $3, $4)`,
      [userId, WORKFLOW_SESSION_MEMORY_TYPE, JSON.stringify(stored), 0]
    );
  } catch (e) {
    console.error("dbSaveWorkflowSession error:", e.message);
  }

  return stored;
}

async function dbGetWorkflowSession(userId) {
  if (!userId) return null;

  if (isWorkflowSessionFresh(userSessions[userId])) {
    return userSessions[userId];
  }

  try {
    const res = await db.query(
      `SELECT content
       FROM user_memory
       WHERE user_id = $1 AND memory_type = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, WORKFLOW_SESSION_MEMORY_TYPE]
    );

    if (res.rows.length === 0) {
      delete userSessions[userId];
      return null;
    }

    const session = JSON.parse(res.rows[0].content);
    if (!isWorkflowSessionFresh(session)) {
      await dbDeleteWorkflowSession(userId);
      return null;
    }

    userSessions[userId] = session;
    return session;
  } catch (e) {
    console.error("dbGetWorkflowSession error:", e.message);
    return isWorkflowSessionFresh(userSessions[userId]) ? userSessions[userId] : null;
  }
}

async function dbDeleteWorkflowSession(userId) {
  delete userSessions[userId];

  try {
    await db.query(
      `DELETE FROM user_memory
       WHERE user_id = $1 AND memory_type = $2`,
      [userId, WORKFLOW_SESSION_MEMORY_TYPE]
    );
  } catch (e) {
    console.error("dbDeleteWorkflowSession error:", e.message);
  }
}

async function dbGetLatestWeightTrainingFeedback(userId) {
  try {
    const res = await db.query(
      `SELECT content
       FROM user_memory
       WHERE user_id = $1 AND memory_type = 'weight_training_feedback'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    return res.rows[0]?.content || "";
  } catch (e) {
    console.error("dbGetLatestWeightTrainingFeedback error:", e.message);
    return "";
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
async function hasStrava(userId) {
  return !!(stravaTokens[userId] || await dbGetStravaToken(userId));
}

function saveActivity(userId, activity) {
  if (!userActivities[userId]) userActivities[userId] = [];
  userActivities[userId].unshift(activity);
  if (userActivities[userId].length > 200) userActivities[userId].pop();
}

function getRecentActivities(userId, days = 7) {
  if (!userActivities[userId]) return [];
  const safeDays = normalizeLookbackDays(days);
  const cutoff = Date.now() - safeDays * 86400000;
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
    const res = await withRetry(
      () => axios.post(
        "https://www.strava.com/oauth/token",
        {
          client_id: CONFIG.STRAVA_CLIENT_ID,
          client_secret: CONFIG.STRAVA_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: tokenData.refresh_token,
        },
        { timeout: 10000 }
      ),
      {
        onRetry: (error, meta) => logger.warn("Retrying Strava token refresh", {
          error: error.message,
          ...meta,
        }),
      }
    );

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
  const safeDays = normalizeLookbackDays(days);
  const cacheKey = `${lineUserId}_${safeDays}`;
  const cached = stravaCache[cacheKey];

  if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000) {
    return cached.data;
  }

  const token = await refreshStravaToken(lineUserId);
  if (!token) return null;

  try {
    const after = Math.floor((Date.now() - safeDays * 86400000) / 1000);

    const res = await withRetry(
      () => axios.get("https://www.strava.com/api/v3/athlete/activities", {
        headers: { Authorization: `Bearer ${token}` },
        params: { after, per_page: 50 },
        timeout: 10000,
      }),
      {
        onRetry: (error, meta) => logger.warn("Retrying Strava activities fetch", {
          error: error.message,
          ...meta,
        }),
      }
    );

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
        sourceActivityId: a.id,
        name: a.name,
      };
    });
}

async function getActivitiesForUser(userId, days = 7) {
  const safeDays = normalizeLookbackDays(days);

  if (await hasStrava(userId)) {
    const stravaData = await getStravaActivities(userId, safeDays);

    if (stravaData) {
      const converted = convertStravaToActivities(stravaData);

      for (const a of converted) {
        await dbSaveActivity(userId, a);
      }

      return converted;
    }
  }

  const dbActivities = await dbGetActivities(userId, safeDays);
  if (dbActivities.length > 0) return dbActivities;

  return getRecentActivities(userId, safeDays);
}

// ===== PR CHECKER =====
function checkPR(userId, activity) {
  if (!userPRs[userId]) {
    userPRs[userId] = { longestRun: 0, fastestPace: null };
  }

  const pr = userPRs[userId];
  const prs = [];

  if (activity.distance && activity.distance > pr.longestRun) {
    if (pr.longestRun && pr.longestRun > 0) {
      prs.push(`🏅 PR ระยะทาง! ${activity.distance.toFixed(2)}km (เดิม ${pr.longestRun.toFixed(2)}km)`);
    } else {
      prs.push(`🏅 PR ระยะทางครั้งแรก! ${activity.distance.toFixed(2)}km`);
    }

    pr.longestRun = activity.distance;
  }

  if (
    activity.pace &&
    activity.pace > 0 &&
    (!pr.fastestPace || activity.pace < pr.fastestPace)
  ) {
    const pMin = Math.floor(activity.pace);
    const pSec = Math.round((activity.pace - pMin) * 60);

    if (pr.fastestPace && pr.fastestPace > 0 && pr.fastestPace < 9999) {
      const oldMin = Math.floor(pr.fastestPace);
      const oldSec = Math.round((pr.fastestPace - oldMin) * 60);

      prs.push(
        `⚡ PR Pace! ${pMin}:${String(pSec).padStart(2, "0")}/km (เดิม ${oldMin}:${String(oldSec).padStart(2, "0")}/km)`
      );
    } else {
      prs.push(
        `⚡ PR Pace ครั้งแรก! ${pMin}:${String(pSec).padStart(2, "0")}/km`
      );
    }

    pr.fastestPace = activity.pace;
  }

  dbSavePR(userId, pr);

  return prs.length > 0 ? prs : null;
}
// ===== GPX PARSER =====
function getXmlAttribute(tagAttributes, name) {
  const match = tagAttributes.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : null;
}

function getXmlChildText(xmlBlock, tagName) {
  const match = xmlBlock.match(
    new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "i")
  );
  return match ? match[1].trim() : null;
}

function extractGpxPoints(xmlText, pointTagName) {
  const points = [];
  const pointRegex = new RegExp(
    `<((?:\\w+:)?${pointTagName})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`,
    "gi"
  );

  let match;
  while ((match = pointRegex.exec(xmlText)) !== null) {
    const lat = parseFloat(getXmlAttribute(match[2], "lat"));
    const lon = parseFloat(getXmlAttribute(match[2], "lon"));
    const eleText = getXmlChildText(match[3], "ele");
    const timeText = getXmlChildText(match[3], "time");
    const ele = eleText === null ? null : parseFloat(eleText);
    const time = timeText ? new Date(timeText) : null;

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !time ||
      Number.isNaN(time.getTime())
    ) {
      continue;
    }

    points.push({
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
      time,
    });
  }

  return points;
}

function distanceKmBetweenPoints(p1, p2) {
  const R = 6371;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * Math.PI / 180) *
      Math.cos(p2.lat * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGPX(xmlText) {
  try {
    const points = extractGpxPoints(xmlText, "trkpt");

    if (points.length < 2) return null;

    let totalDist = 0;
    let totalElevGain = 0;

    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];

      totalDist += distanceKmBetweenPoints(p1, p2);

      if (Number.isFinite(p1.ele) && Number.isFinite(p2.ele) && p2.ele > p1.ele) {
        totalElevGain += p2.ele - p1.ele;
      }
    }

    const duration =
      (points[points.length - 1].time - points[0].time) / 1000 / 60;

    const pace = totalDist > 0 ? duration / totalDist : 0;
    if (duration <= 0 || pace <= 0) return null;

    return {
      date: points[0].time.toISOString(),
      distance: parseFloat(totalDist.toFixed(2)),
      pace: parseFloat(pace.toFixed(4)),
      duration: parseFloat(duration.toFixed(1)),
      elevGain: parseFloat(totalElevGain.toFixed(0)),
      calories: Math.round(totalDist * 60),
      source: "GPX",
      sourceActivityId: createContentFingerprint("gpx", xmlText),
    };
  } catch (e) {
    console.error("GPX parse error:", e.message);
    return null;
  }
}
const { analyzeWithClaudeWithHistory, analyzeWithClaude } = createClaudeService({
  anthropic,
  logger,
  withRetry,
});

function extractActivityFromResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*?"distance"[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const data = JSON.parse(jsonMatch[0]);
    if (!data.distance) return null;

    const activity = {
      date: data.date || new Date().toISOString(),
      distance: parseFloat(data.distance) || 0,
      pace: parseFloat(data.pace) || 0,
      duration: parseFloat(data.duration) || 0,
      calories: parseFloat(data.calories) || 0,
      elevGain: parseFloat(data.elevGain) || 0,
      source: "Screenshot",
    };
    activity.sourceActivityId = createActivityFingerprint(activity);
    return activity;
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
  const calories =
  activity.calories && activity.calories > 0
    ? Math.round(activity.calories)
    : Math.round((activity.distance || 0) * 60);
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
            margin: "lg",
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

function compactFlexText(value, fallback = "-", maxLength = 260) {
  const text = String(value || fallback).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function stripJsonBlocks(value = "") {
  return String(value)
    .replace(/```(?:json)?[\s\S]*?```/gi, "")
    .replace(/\{[\s\S]*?\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildActivityInsightFallback(activity = {}) {
  const distance = Number(activity.distance || 0);
  const pace = activity.paceText || paceDecimalToText(activity.pace);
  const duration = activity.durationText || durationMinToText(activity.duration);
  const elevGain = Number(activity.elevGain || 0);

  const parts = [];
  if (distance > 0) parts.push(`วิ่ง ${distance.toFixed(2)} กิโลเมตร`);
  if (pace && pace !== "-") parts.push(`pace เฉลี่ย ${pace}/km`);
  if (duration && duration !== "-") parts.push(`ใช้เวลา ${duration}`);
  if (elevGain > 0) parts.push(`ไต่ขึ้น ${Math.round(elevGain)} เมตร`);

  if (parts.length === 0) {
    return "อาจารย์อ่านผลวิ่งให้แล้วครับ เก็บสถิติรอบนี้ไว้เรียบร้อย";
  }

  return `${parts.join(" • ")} ภาพรวมทำได้ดีครับ ค่อย ๆ รักษาความสม่ำเสมอรอบถัดไป`;
}

function cleanAnalysisInsight(analysisText = "", activity = {}) {
  const cleaned = stripJsonBlocks(analysisText)
    .replace(/^[\s"“”'`.,:;!-]+|[\s"“”'`]+$/g, "")
    .trim();

  if (!cleaned || /"\s*distance\s*"/i.test(cleaned) || /[{}]/.test(cleaned)) {
    return buildActivityInsightFallback(activity);
  }

  return cleaned;
}

function formatActivityDateLabel(activity = {}) {
  if (!activity.date) return "ผลการวิ่งล่าสุด";

  const date = new Date(activity.date);
  if (Number.isNaN(date.getTime())) return "ผลการวิ่งล่าสุด";

  return date.toLocaleDateString("th-TH", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function metricValueSize(value) {
  const length = String(value || "-").length;
  if (length >= 8) return "sm";
  if (length >= 5) return "md";
  return "lg";
}

function buildMetricPill(label, value, accentColor = "#E8703A", options = {}) {
  const valueText = String(value || "-");

  return {
    type: "box",
    layout: "vertical",
    flex: options.flex || 1,
    paddingAll: options.paddingAll || "10px",
    backgroundColor: "#F6F7FB",
    cornerRadius: "10px",
    contents: [
      {
        type: "text",
        text: valueText,
        size: options.valueSize || metricValueSize(valueText),
        weight: "bold",
        color: accentColor,
        align: "center",
        maxLines: 1,
      },
      {
        type: "text",
        text: label,
        size: "xxs",
        color: "#667085",
        align: "center",
        margin: "xs",
        maxLines: 2,
      },
    ],
  };
}

function buildRunResultFlexMessage(activity = {}, analysisText = "", options = {}) {
  const distance = Number(activity.distance || 0);
  const pace = activity.paceText || paceDecimalToText(activity.pace);
  const duration = activity.durationText || durationMinToText(activity.duration);
  const calories =
    activity.calories && activity.calories > 0
      ? Math.round(activity.calories)
      : Math.round(distance * 60);
  const cadence = activity.cadence || estimateCadence(activity.pace);
  const elevGain = activity.elevGain || 0;
  const hrZones = activity.hrZones || estimateHRZones(activity.pace);
  const source = options.source || activity.source || "Screenshot";
  const dateLabel = formatActivityDateLabel(activity);
  const title = options.title || "อ่านผลวิ่งเรียบร้อย";
  const insight = compactFlexText(
    cleanAnalysisInsight(analysisText, activity),
    buildActivityInsightFallback(activity),
    300
  );
  const distanceText = distance > 0 ? distance.toFixed(2) : "-";
  const altPace = pace && pace !== "-" ? ` pace ${pace}/km` : "";

  return {
    type: "flex",
    altText: `🏃 ${title}: ${distanceText} km${altPace}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: "#111827",
        contents: [
          {
            type: "text",
            text: title,
            size: "lg",
            weight: "bold",
            color: "#FFFFFF",
            maxLines: 1,
          },
          {
            type: "text",
            text: `${source} • ${dateLabel}`,
            size: "xs",
            color: "#D1D5DB",
            margin: "xs",
            maxLines: 1,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 5,
                contents: [
                  {
                    type: "text",
                    text: distanceText,
                    size: "4xl",
                    weight: "bold",
                    color: "#E8703A",
                    maxLines: 1,
                  },
                  {
                    type: "text",
                    text: "กิโลเมตร",
                    size: "xs",
                    color: "#667085",
                    margin: "xs",
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                flex: 4,
                spacing: "sm",
                contents: [
                  buildMetricPill("pace /km", pace || "-", "#111827", {
                    paddingAll: "9px",
                    valueSize: "sm",
                  }),
                  buildMetricPill("เวลา", duration || "-", "#111827", {
                    paddingAll: "9px",
                    valueSize: "sm",
                  }),
                ],
              },
            ],
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              buildMetricPill("kcal", calories, "#E8703A"),
              buildMetricPill("cadence", cadence, "#0F766E"),
              buildMetricPill("elev", `${elevGain}m`, "#2563EB"),
              buildMetricPill(
                "HR zone",
                Object.entries(hrZones).sort((a, b) => b[1] - a[1])[0][0].toUpperCase(),
                "#B91C1C"
              ),
            ],
          },
          {
            type: "box",
            layout: "vertical",
            paddingAll: "14px",
            backgroundColor: "#FFF7ED",
            cornerRadius: "10px",
            contents: [
              {
                type: "text",
                text: "AI insight",
                size: "xs",
                weight: "bold",
                color: "#C2410C",
              },
              {
                type: "text",
                text: insight,
                size: "sm",
                color: "#43302B",
                wrap: true,
                margin: "xs",
                maxLines: 5,
              },
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#06C755",
            action: {
              type: "postback",
              label: "ขอคำแนะนำต่อ",
              data: "action=today_recommendation",
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "ดูสรุปสัปดาห์",
              data: "action=weekly_summary",
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
          { type: "separator", margin: "md" },
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
          { type: "separator", margin: "md" },
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

const {
  makeQuickReply,
  pushMessage,
  replyMessage,
  pushFlexMessage,
  replyText,
  replyFlex,
} = createLineService({
  axios,
  channelAccessToken: CONFIG.LINE_CHANNEL_ACCESS_TOKEN,
  logger,
  withRetry,
});

// ===== MAIN AI CHAT FLOW =====
async function handleAIChat(userId, text, replyToken) {
  const aiLimit = await assertRateLimit(db, userId, "ai");
  if (!aiLimit.allowed) {
    await replyText(replyToken, aiLimit.message);
    return;
  }

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

function normalizeMenuAction(value = "") {
  const text = String(value).trim();
  const lower = text.toLowerCase();

  const aliases = {
    "action=today": "today",
    "action=today_stats": "today",
    "action=week": "week",
    "action=weekly_summary": "week",
    "action=goal": "goal",
    "action=chat": "chat",
    "action=plan": "plan",
    "action=recovery": "weight_training",
    "action=today_recommendation": "today_recommendation", "action=wt_done": "wt_done", "action=wt_lighter": "wt_lighter", "action=wt_heavier": "wt_heavier",
    "/today": "today",
    "/summary": "week",
    "/history": "history",
    "/update": "update",
    "สถิติวันนี้": "today",
    "สรุปสัปดาห์": "week",
    "สรุปประจำสัปดาห์": "week",
    "เป้าหมาย": "goal",
    "ตารางซ้อม": "plan",
    "ถามตอบอาจารย์นักวิ่ง": "chat",
  };

  if (aliases[lower]) return aliases[lower];

  if (text.includes("สถิติวันนี้")) return "today";
  if (text.includes("สรุป") && text.includes("สัปดาห์")) return "week";
  if (text.includes("เป้าหมาย")) return "goal";
  if (text.includes("ตารางซ้อม")) return "plan";
  if (lower.includes("weight") || lower.includes("recovery") || text.includes("เวท")) return "weight_training";
  if (text.includes("ถามตอบ") || text.includes("ถามอาจารย์")) return "chat";

  return null;
}

function weightTrainingQuickReply(options) { return makeQuickReply(options.map(option => ({ label: option.label, text: option.text, }))); } function startWeightTrainingFlow(userId, replyToken) { userSessions[userId] = { flow: "weight_training", step: "focus", data: { intensity: "normal", }, }; return replyText( replyToken, "\u0e27\u0e31\u0e19\u0e19\u0e35\u0e49\u0e2d\u0e22\u0e32\u0e01\u0e40\u0e25\u0e48\u0e19\u0e40\u0e27\u0e17\u0e41\u0e1a\u0e1a\u0e44\u0e2b\u0e19\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "\u0e02\u0e32", text: "\u0e02\u0e32" }, { label: "core", text: "core" }, { label: "\u0e01\u0e31\u0e19\u0e40\u0e08\u0e47\u0e1a", text: "\u0e01\u0e31\u0e19\u0e40\u0e08\u0e47\u0e1a" }, { label: "full body", text: "full body" }, ]) ); } function getWeightTrainingSession(userId) { const session = userSessions[userId]; if (!session || session.flow !== "weight_training") return null; return session; } function matchWeightTrainingChoice(text, choices) { const lower = String(text || "").trim().toLowerCase(); return choices.find(choice => lower === choice.key || lower === String(choice.label).toLowerCase() || lower === String(choice.text).toLowerCase() ); } function getWeightTrainingExercises(data = {}) { const focus = data.focus || "full_body"; const equipment = data.equipment || "none"; const intensity = data.intensity || "normal"; const reps = intensity === "lighter" ? "8-10" : intensity === "heavier" ? "12-15" : "10-12"; const sets = intensity === "lighter" ? "2" : intensity === "heavier" ? "4" : "3"; const equipmentNote = { none: "bodyweight", dumbbell: "dumbbell", band: "resistance band", gym: "gym machine/free weight", }[equipment] || "bodyweight"; const templates = { legs: ["Squat", "Reverse lunge", "Glute bridge", "Calf raise", "Single-leg RDL"], core: ["Dead bug", "Plank", "Side plank", "Bird dog", "Mountain climber"], injury: ["Clamshell", "Glute bridge", "Single-leg balance", "Calf raise", "Hip airplane"], full_body: ["Squat", "Push-up", "Dead bug", "Reverse lunge", "Glute bridge"], }; return (templates[focus] || templates.full_body).map(name => `${name} - ${sets} sets x ${reps} reps (${equipmentNote})` ); } function buildWeightTrainingFlexMessage(data = {}) { const focusLabel = { legs: "\u0e02\u0e32", core: "core", injury: "\u0e01\u0e31\u0e19\u0e40\u0e08\u0e47\u0e1a", full_body: "full body", }[data.focus] || "full body"; const equipmentLabel = { none: "\u0e44\u0e21\u0e48\u0e21\u0e35\u0e2d\u0e38\u0e1b\u0e01\u0e23\u0e13\u0e4c", dumbbell: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25", band: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14", gym: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a", }[data.equipment] || "\u0e44\u0e21\u0e48\u0e21\u0e35\u0e2d\u0e38\u0e1b\u0e01\u0e23\u0e13\u0e4c"; const duration = data.duration || "20"; const exercises = getWeightTrainingExercises(data); return { type: "flex", altText: "Weight Training", contents: { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [ { type: "text", text: "Weight Training", weight: "bold", size: "xl", color: "#111111", }, { type: "text", text: `${focusLabel} | ${duration} \u0e19\u0e32\u0e17\u0e35 | ${equipmentLabel}`, size: "sm", color: "#666666", wrap: true, }, { type: "separator", margin: "md", }, ...exercises.map(exercise => ({ type: "text", text: exercise, size: "sm", color: "#333333", wrap: true, })), ], }, footer: { type: "box", layout: "vertical", spacing: "sm", contents: [ { type: "button", style: "primary", color: "#06C755", action: { type: "postback", label: "\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e27\u0e48\u0e32\u0e17\u0e33\u0e41\u0e25\u0e49\u0e27", data: "action=wt_done", }, }, { type: "box", layout: "horizontal", spacing: "sm", contents: [ { type: "button", style: "secondary", action: { type: "postback", label: "\u0e40\u0e1a\u0e32\u0e25\u0e07", data: "action=wt_lighter", }, }, { type: "button", style: "secondary", action: { type: "postback", label: "\u0e2b\u0e19\u0e31\u0e01\u0e02\u0e36\u0e49\u0e19", data: "action=wt_heavier", }, }, ], }, ], }, }, }; } async function sendWeightTrainingPlan(userId, replyToken) { const session = getWeightTrainingSession(userId); if (!session) { await startWeightTrainingFlow(userId, replyToken); return true; } session.step = "plan_sent"; await replyFlex(replyToken, buildWeightTrainingFlexMessage(session.data)); return true; } async function handleWeightTrainingPostback(userId, action, replyToken) { const session = getWeightTrainingSession(userId); if (action === "wt_done") { const activeSession = session || { flow: "weight_training", step: "feedback", data: {}, }; activeSession.step = "feedback"; userSessions[userId] = activeSession; await replyText( replyToken, "\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e41\u0e25\u0e49\u0e27\u0e04\u0e23\u0e31\u0e1a \u0e27\u0e31\u0e19\u0e19\u0e35\u0e49\u0e23\u0e39\u0e49\u0e2a\u0e36\u0e01\u0e22\u0e31\u0e07\u0e44\u0e07", weightTrainingQuickReply([ { label: "\u0e40\u0e1a\u0e32\u0e44\u0e1b", text: "\u0e40\u0e1a\u0e32\u0e44\u0e1b" }, { label: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35", text: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35" }, { label: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b", text: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b" }, ]) ); return true; } if (action === "wt_lighter" || action === "wt_heavier") { if (!session) { await startWeightTrainingFlow(userId, replyToken); return true; } session.data.intensity = action === "wt_lighter" ? "lighter" : "heavier"; await sendWeightTrainingPlan(userId, replyToken); return true; } return false; } async function handleWeightTrainingText(userId, text, replyToken) { const session = getWeightTrainingSession(userId); if (!session) return false; if (session.step === "focus") { const choice = matchWeightTrainingChoice(text, [ { key: "legs", label: "\u0e02\u0e32", text: "\u0e02\u0e32" }, { key: "core", label: "core", text: "core" }, { key: "injury", label: "\u0e01\u0e31\u0e19\u0e40\u0e08\u0e47\u0e1a", text: "\u0e01\u0e31\u0e19\u0e40\u0e08\u0e47\u0e1a" }, { key: "full_body", label: "full body", text: "full body" }, ]); if (!choice) { await startWeightTrainingFlow(userId, replyToken); return true; } session.data.focus = choice.key; session.step = "duration"; await replyText( replyToken, "\u0e21\u0e35\u0e40\u0e27\u0e25\u0e32\u0e01\u0e35\u0e48\u0e19\u0e32\u0e17\u0e35\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "10", text: "10" }, { label: "20", text: "20" }, { label: "30", text: "30" }, ]) ); return true; } if (session.step === "duration") { const choice = matchWeightTrainingChoice(text, [ { key: "10", label: "10", text: "10" }, { key: "20", label: "20", text: "20" }, { key: "30", label: "30", text: "30" }, ]); if (!choice) { await replyText( replyToken, "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e40\u0e27\u0e25\u0e32\u0e2a\u0e31\u0e49\u0e19 \u0e46 \u0e01\u0e48\u0e2d\u0e19\u0e19\u0e30\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "10", text: "10" }, { label: "20", text: "20" }, { label: "30", text: "30" }, ]) ); return true; } session.data.duration = choice.key; session.step = "equipment"; await replyText( replyToken, "\u0e27\u0e31\u0e19\u0e19\u0e35\u0e49\u0e21\u0e35\u0e2d\u0e38\u0e1b\u0e01\u0e23\u0e13\u0e4c\u0e2d\u0e30\u0e44\u0e23\u0e1a\u0e49\u0e32\u0e07\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "\u0e44\u0e21\u0e48\u0e21\u0e35", text: "\u0e44\u0e21\u0e48\u0e21\u0e35" }, { label: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25", text: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25" }, { label: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14", text: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14" }, { label: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a", text: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a" }, ]) ); return true; } if (session.step === "equipment") { const choice = matchWeightTrainingChoice(text, [ { key: "none", label: "\u0e44\u0e21\u0e48\u0e21\u0e35", text: "\u0e44\u0e21\u0e48\u0e21\u0e35" }, { key: "dumbbell", label: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25", text: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25" }, { key: "band", label: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14", text: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14" }, { key: "gym", label: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a", text: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a" }, ]); if (!choice) { await replyText( replyToken, "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e2d\u0e38\u0e1b\u0e01\u0e23\u0e13\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e19\u0e30\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "\u0e44\u0e21\u0e48\u0e21\u0e35", text: "\u0e44\u0e21\u0e48\u0e21\u0e35" }, { label: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25", text: "\u0e14\u0e31\u0e21\u0e40\u0e1a\u0e25" }, { label: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14", text: "\u0e22\u0e32\u0e07\u0e22\u0e37\u0e14" }, { label: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a", text: "\u0e1f\u0e34\u0e15\u0e40\u0e19\u0e2a" }, ]) ); return true; } session.data.equipment = choice.key; await sendWeightTrainingPlan(userId, replyToken); return true; } if (session.step === "feedback") { const choice = matchWeightTrainingChoice(text, [ { key: "too_light", label: "\u0e40\u0e1a\u0e32\u0e44\u0e1b", text: "\u0e40\u0e1a\u0e32\u0e44\u0e1b" }, { key: "good", label: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35", text: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35" }, { key: "too_heavy", label: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b", text: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b" }, ]); if (!choice) { await replyText( replyToken, "\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e04\u0e27\u0e32\u0e21\u0e23\u0e39\u0e49\u0e2a\u0e36\u0e01\u0e2b\u0e25\u0e31\u0e07\u0e40\u0e25\u0e48\u0e19\u0e40\u0e27\u0e17\u0e2b\u0e19\u0e48\u0e2d\u0e22\u0e04\u0e23\u0e31\u0e1a", weightTrainingQuickReply([ { label: "\u0e40\u0e1a\u0e32\u0e44\u0e1b", text: "\u0e40\u0e1a\u0e32\u0e44\u0e1b" }, { label: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35", text: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e14\u0e35" }, { label: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b", text: "\u0e2b\u0e19\u0e31\u0e01\u0e44\u0e1b" }, ]) ); return true; } const data = session.data || {}; await dbSaveUserMemory(userId, { memory_type: "weight_training_feedback", content: `weight_training focus=${data.focus || "-"} duration=${data.duration || "-"} equipment=${data.equipment || "-"} intensity=${data.intensity || "normal"} feedback=${choice.key}`, importance: 2, }); delete userSessions[userId]; await replyText(replyToken, "\u0e40\u0e01\u0e47\u0e1a feedback \u0e41\u0e25\u0e49\u0e27\u0e04\u0e23\u0e31\u0e1a \u0e04\u0e23\u0e31\u0e49\u0e07\u0e2b\u0e19\u0e49\u0e32\u0e08\u0e30\u0e43\u0e0a\u0e49\u0e1b\u0e23\u0e31\u0e1a\u0e42\u0e1b\u0e23\u0e41\u0e01\u0e23\u0e21\u0e40\u0e27\u0e17\u0e43\u0e2b\u0e49\u0e40\u0e02\u0e49\u0e32\u0e01\u0e31\u0e1a\u0e15\u0e31\u0e27\u0e04\u0e38\u0e13\u0e21\u0e32\u0e01\u0e02\u0e36\u0e49\u0e19"); return true; } return false; }  async function handleMenuAction(userId, action, replyToken) {
  if (action === "update") {
    await replyFlex(replyToken, buildUpdateNotificationFlex());
    return true;
  }

  if (action === "today") {
    const activities = await getActivitiesForUser(userId, 7);
    const latest = activities[0];

    if (!latest) {
      await replyText(replyToken, "ยังไม่มีข้อมูลการวิ่งล่าสุดครับ ส่ง screenshot หรือเชื่อม Strava ก่อนได้เลย");
      return true;
    }

    await replyFlex(replyToken, buildTodayStatsFlexMessage(latest));
    return true;
  }

  if (action === "week") {
    const activities = await getActivitiesForUser(userId, 7);
    const stats = calcStatsFromActivities(activities);

    if (!stats) {
      await replyText(replyToken, "ยังไม่มีข้อมูลสัปดาห์นี้ครับ");
      return true;
    }

    await replyFlex(replyToken, buildStatsFlexMessage(stats, "สัปดาห์นี้"));
    return true;
  }

  if (action === "history") {
    const activities = await getActivitiesForUser(userId, 30);
    const carousel = buildCarouselMessage(activities);

    if (!carousel) {
      await replyText(replyToken, "ยังไม่มีประวัติการวิ่งครับ");
      return true;
    }

    await replyFlex(replyToken, carousel);
    return true;
  }

  if (action === "goal") {
    await replyText(replyToken, "ส่งเป้าหมายการวิ่งมาได้เลยครับ เช่น เดือนนี้ 80 km หรือ 10K ต่ำกว่า 60 นาที");
    return true;
  }

  if (action === "chat") {
    await replyText(replyToken, "ถามอาจารย์ได้เลยครับ เรื่องการซ้อม เป้าหมาย recovery หรือข้อมูลการวิ่งล่าสุด");
    return true;
  }

  if (action === "plan") {
    await handleAIChat(userId, "ช่วยสร้างตารางซ้อมจากข้อมูลการวิ่งล่าสุดของผม", replyToken);
    return true;
  }

  if (action && action.startsWith("wt_")) { return handleWeightTrainingPostback(userId, action, replyToken); } if (action === "weight_training") { await startWeightTrainingFlow(userId, replyToken); return true; } if (false) {
    await handleAIChat(userId, "ช่วยแนะนำ recovery และ weight training จากข้อมูลการวิ่งล่าสุดของผม", replyToken);
    return true;
  }

  if (action === "today_recommendation") {
    await handleAIChat(userId, "ช่วยแนะนำการซ้อมวันนี้จากสถิติล่าสุดของผม", replyToken);
    return true;
  }

  return false;
}

function analyzeRunningLoadForWeightTraining(activities = [], feedbackText = "") {
  const totalDistance = activities.reduce((sum, a) => sum + Number(a.distance || 0), 0);
  const totalDuration = activities.reduce((sum, a) => sum + Number(a.duration || 0), 0);
  const runCount = activities.length;
  const longRun = activities.reduce((max, a) => Math.max(max, Number(a.distance || 0)), 0);
  const hardRuns = activities.filter(a => Number(a.pace || 0) > 0 && Number(a.pace) < 5.75).length;
  const tooHeavy = /too_heavy|หนักไป/i.test(feedbackText);
  const tooLight = /too_light|เบาไป/i.test(feedbackText);

  let level = "normal";
  let intensity = "normal";
  let note = "โหลดซ้อมปกติ เล่นเวทเสริมได้แบบคุมฟอร์ม";

  if (totalDistance >= 35 || runCount >= 5 || hardRuns >= 2 || longRun >= 18 || tooHeavy) {
    level = "high";
    intensity = "lighter";
    note = "ช่วงนี้โหลดวิ่งค่อนข้างสูง โปรแกรมเวทจะลด volume และเน้นกันเจ็บ";
  } else if (totalDistance <= 12 && runCount <= 2 && tooLight) {
    level = "fresh";
    intensity = "heavier";
    note = "โหลดวิ่งยังไม่สูงและ feedback ล่าสุดเบาไป เพิ่มแรงต้านได้เล็กน้อย";
  } else if (totalDistance <= 12 && runCount <= 2) {
    level = "fresh";
    note = "โหลดวิ่งยังเบา เล่นเวทได้เต็มกว่าปกตินิดหน่อย";
  }

  return {
    level,
    intensity,
    note,
    totalDistance: Number(totalDistance.toFixed(1)),
    totalDuration: Math.round(totalDuration),
    runCount,
    longRun: Number(longRun.toFixed(1)),
    hardRuns,
  };
}

function weightTrainingQuickReply(options) {
  return makeQuickReply(options.map(option => ({
    label: option.label,
    text: option.text,
  })));
}

async function startWeightTrainingFlow(userId, replyToken) {
  const [activities, feedbackText] = await Promise.all([
    getActivitiesForUser(userId, 7),
    dbGetLatestWeightTrainingFeedback(userId),
  ]);
  const runningLoad = analyzeRunningLoadForWeightTraining(activities, feedbackText);

  await dbSaveWorkflowSession(userId, {
    flow: "weight_training",
    step: "focus",
    data: {
      intensity: runningLoad.intensity,
      runningLoad,
      lastFeedback: feedbackText || "",
    },
  });

  return replyText(
    replyToken,
    `วันนี้อยากเล่นเวทแบบไหนครับ\n${runningLoad.note}`,
    weightTrainingQuickReply([
      { label: "ขา", text: "ขา" },
      { label: "core", text: "core" },
      { label: "กันเจ็บ", text: "กันเจ็บ" },
      { label: "full body", text: "full body" },
    ])
  );
}

async function getWeightTrainingSession(userId) {
  const session = await dbGetWorkflowSession(userId);
  if (!session || session.flow !== "weight_training") return null;
  return session;
}

function matchWeightTrainingChoice(text, choices) {
  const lower = String(text || "").trim().toLowerCase();
  return choices.find(choice =>
    lower === choice.key ||
    lower === String(choice.label).toLowerCase() ||
    lower === String(choice.text).toLowerCase()
  );
}

function getWeightTrainingExercises(data = {}) {
  const focus = data.focus || "full_body";
  const equipment = data.equipment || "none";
  const intensity = data.intensity || "normal";
  const loadLevel = data.runningLoad?.level || "normal";
  const reps = intensity === "lighter" ? "8-10" : intensity === "heavier" ? "12-15" : "10-12";
  const sets = intensity === "lighter" || loadLevel === "high" ? "2" : intensity === "heavier" ? "4" : "3";
  const equipmentNote = {
    none: "bodyweight",
    dumbbell: "dumbbell",
    band: "resistance band",
    gym: "gym machine/free weight",
  }[equipment] || "bodyweight";

  const templates = {
    legs: ["Squat", "Reverse lunge", "Glute bridge", "Calf raise", "Single-leg RDL"],
    core: ["Dead bug", "Plank", "Side plank", "Bird dog", "Pallof press"],
    injury: ["Clamshell", "Glute bridge", "Single-leg balance", "Calf raise", "Hip airplane"],
    full_body: ["Squat", "Push-up", "Dead bug", "Reverse lunge", "Glute bridge"],
  };

  return (templates[focus] || templates.full_body).map(name =>
    `${name} - ${sets} sets x ${reps} reps (${equipmentNote})`
  );
}

function buildWeightTrainingFlexMessage(data = {}) {
  const focusLabel = {
    legs: "ขา",
    core: "core",
    injury: "กันเจ็บ",
    full_body: "full body",
  }[data.focus] || "full body";
  const equipmentLabel = {
    none: "ไม่มีอุปกรณ์",
    dumbbell: "ดัมเบล",
    band: "ยางยืด",
    gym: "ฟิตเนส",
  }[data.equipment] || "ไม่มีอุปกรณ์";
  const duration = data.duration || "20";
  const runningLoad = data.runningLoad || {};
  const exercises = getWeightTrainingExercises(data);

  return {
    type: "flex",
    altText: "Weight Training",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "Weight Training",
            weight: "bold",
            size: "xl",
            color: "#111111",
          },
          {
            type: "text",
            text: `${focusLabel} | ${duration} นาที | ${equipmentLabel}`,
            size: "sm",
            color: "#666666",
            wrap: true,
          },
          {
            type: "text",
            text: `โหลดวิ่ง 7 วัน: ${runningLoad.totalDistance || 0} km | ${runningLoad.note || "คุมฟอร์มเป็นหลัก"}`,
            size: "xs",
            color: "#0F766E",
            wrap: true,
          },
          {
            type: "separator",
            margin: "md",
          },
          ...exercises.map(exercise => ({
            type: "text",
            text: exercise,
            size: "sm",
            color: "#333333",
            wrap: true,
          })),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#06C755",
            action: {
              type: "postback",
              label: "บันทึกว่าทำแล้ว",
              data: "action=wt_done",
            },
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "postback",
                  label: "เบาลง",
                  data: "action=wt_lighter",
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "postback",
                  label: "หนักขึ้น",
                  data: "action=wt_heavier",
                },
              },
            ],
          },
        ],
      },
    },
  };
}

async function sendWeightTrainingPlan(userId, replyToken) {
  const session = await getWeightTrainingSession(userId);
  if (!session) {
    await startWeightTrainingFlow(userId, replyToken);
    return true;
  }

  session.step = "plan_sent";
  await dbSaveWorkflowSession(userId, session);
  await replyFlex(replyToken, buildWeightTrainingFlexMessage(session.data));
  return true;
}

async function handleWeightTrainingPostback(userId, action, replyToken) {
  const session = await getWeightTrainingSession(userId);

  if (action === "wt_done") {
    const activeSession = session || {
      flow: "weight_training",
      step: "feedback",
      data: {},
    };
    activeSession.step = "feedback";
    await dbSaveWorkflowSession(userId, activeSession);

    await replyText(
      replyToken,
      "บันทึกแล้วครับ วันนี้รู้สึกยังไง",
      weightTrainingQuickReply([
        { label: "เบาไป", text: "เบาไป" },
        { label: "กำลังดี", text: "กำลังดี" },
        { label: "หนักไป", text: "หนักไป" },
      ])
    );
    return true;
  }

  if (action === "wt_lighter" || action === "wt_heavier") {
    if (!session) {
      await startWeightTrainingFlow(userId, replyToken);
      return true;
    }

    session.data.intensity = action === "wt_lighter" ? "lighter" : "heavier";
    await dbSaveWorkflowSession(userId, session);
    await sendWeightTrainingPlan(userId, replyToken);
    return true;
  }

  return false;
}

async function handleWeightTrainingText(userId, text, replyToken) {
  const session = await getWeightTrainingSession(userId);
  if (!session) return false;

  if (session.step === "focus") {
    const choice = matchWeightTrainingChoice(text, [
      { key: "legs", label: "ขา", text: "ขา" },
      { key: "core", label: "core", text: "core" },
      { key: "injury", label: "กันเจ็บ", text: "กันเจ็บ" },
      { key: "full_body", label: "full body", text: "full body" },
    ]);

    if (!choice) {
      await startWeightTrainingFlow(userId, replyToken);
      return true;
    }

    session.data.focus = choice.key;
    session.step = "duration";
    await dbSaveWorkflowSession(userId, session);
    await replyText(
      replyToken,
      "มีเวลากี่นาทีครับ",
      weightTrainingQuickReply([
        { label: "10", text: "10" },
        { label: "20", text: "20" },
        { label: "30", text: "30" },
      ])
    );
    return true;
  }

  if (session.step === "duration") {
    const choice = matchWeightTrainingChoice(text, [
      { key: "10", label: "10", text: "10" },
      { key: "20", label: "20", text: "20" },
      { key: "30", label: "30", text: "30" },
    ]);

    if (!choice) {
      await replyText(
        replyToken,
        "เลือกเวลาสั้น ๆ ก่อนนะครับ",
        weightTrainingQuickReply([
          { label: "10", text: "10" },
          { label: "20", text: "20" },
          { label: "30", text: "30" },
        ])
      );
      return true;
    }

    session.data.duration = choice.key;
    session.step = "equipment";
    await dbSaveWorkflowSession(userId, session);
    await replyText(
      replyToken,
      "วันนี้มีอุปกรณ์อะไรบ้างครับ",
      weightTrainingQuickReply([
        { label: "ไม่มี", text: "ไม่มี" },
        { label: "ดัมเบล", text: "ดัมเบล" },
        { label: "ยางยืด", text: "ยางยืด" },
        { label: "ฟิตเนส", text: "ฟิตเนส" },
      ])
    );
    return true;
  }

  if (session.step === "equipment") {
    const choice = matchWeightTrainingChoice(text, [
      { key: "none", label: "ไม่มี", text: "ไม่มี" },
      { key: "dumbbell", label: "ดัมเบล", text: "ดัมเบล" },
      { key: "band", label: "ยางยืด", text: "ยางยืด" },
      { key: "gym", label: "ฟิตเนส", text: "ฟิตเนส" },
    ]);

    if (!choice) {
      await replyText(
        replyToken,
        "เลือกอุปกรณ์ก่อนนะครับ",
        weightTrainingQuickReply([
          { label: "ไม่มี", text: "ไม่มี" },
          { label: "ดัมเบล", text: "ดัมเบล" },
          { label: "ยางยืด", text: "ยางยืด" },
          { label: "ฟิตเนส", text: "ฟิตเนส" },
        ])
      );
      return true;
    }

    session.data.equipment = choice.key;
    await dbSaveWorkflowSession(userId, session);
    await sendWeightTrainingPlan(userId, replyToken);
    return true;
  }

  if (session.step === "feedback") {
    const choice = matchWeightTrainingChoice(text, [
      { key: "too_light", label: "เบาไป", text: "เบาไป" },
      { key: "good", label: "กำลังดี", text: "กำลังดี" },
      { key: "too_heavy", label: "หนักไป", text: "หนักไป" },
    ]);

    if (!choice) {
      await replyText(
        replyToken,
        "เลือกความรู้สึกหลังเล่นเวทหน่อยครับ",
        weightTrainingQuickReply([
          { label: "เบาไป", text: "เบาไป" },
          { label: "กำลังดี", text: "กำลังดี" },
          { label: "หนักไป", text: "หนักไป" },
        ])
      );
      return true;
    }

    const data = session.data || {};
    await dbSaveUserMemory(userId, {
      memory_type: "weight_training_feedback",
      content: `weight_training focus=${data.focus || "-"} duration=${data.duration || "-"} equipment=${data.equipment || "-"} intensity=${data.intensity || "normal"} load=${data.runningLoad?.level || "normal"} feedback=${choice.key}`,
      importance: 2,
    });

    await dbDeleteWorkflowSession(userId);
    await replyText(replyToken, "เก็บ feedback แล้วครับ ครั้งหน้าจะใช้ปรับโปรแกรมเวทให้เข้ากับตัวคุณมากขึ้น");
    return true;
  }

  return false;
}

async function handleMenuAction(userId, action, replyToken) {
  if (action === "update") {
    await replyFlex(replyToken, buildUpdateNotificationFlex());
    return true;
  }

  if (action === "today") {
    const activities = await getActivitiesForUser(userId, 7);
    const latest = activities[0];

    if (!latest) {
      await replyText(replyToken, "ยังไม่มีข้อมูลการวิ่งล่าสุดครับ ส่ง screenshot หรือเชื่อม Strava ก่อนได้เลย");
      return true;
    }

    await replyFlex(replyToken, buildTodayStatsFlexMessage(latest));
    return true;
  }

  if (action === "week") {
    const activities = await getActivitiesForUser(userId, 7);
    const stats = calcStatsFromActivities(activities);

    if (!stats) {
      await replyText(replyToken, "ยังไม่มีข้อมูลสัปดาห์นี้ครับ");
      return true;
    }

    await replyFlex(replyToken, buildStatsFlexMessage(stats, "สัปดาห์นี้"));
    return true;
  }

  if (action === "history") {
    const activities = await getActivitiesForUser(userId, 30);
    const carousel = buildCarouselMessage(activities);

    if (!carousel) {
      await replyText(replyToken, "ยังไม่มีประวัติการวิ่งครับ");
      return true;
    }

    await replyFlex(replyToken, carousel);
    return true;
  }

  if (action === "goal") {
    await replyText(replyToken, "ส่งเป้าหมายการวิ่งมาได้เลยครับ เช่น เดือนนี้ 80 km หรือ 10K ต่ำกว่า 60 นาที");
    return true;
  }

  if (action === "chat") {
    await replyText(replyToken, "ถามอาจารย์ได้เลยครับ เรื่องการซ้อม เป้าหมาย recovery หรือข้อมูลการวิ่งล่าสุด");
    return true;
  }

  if (action === "plan") {
    await handleAIChat(userId, "ช่วยสร้างตารางซ้อมจากข้อมูลการวิ่งล่าสุดของผม", replyToken);
    return true;
  }

  if (action && action.startsWith("wt_")) {
    return handleWeightTrainingPostback(userId, action, replyToken);
  }

  if (action === "weight_training") {
    await startWeightTrainingFlow(userId, replyToken);
    return true;
  }

  if (action === "today_recommendation") {
    await handleAIChat(userId, "ช่วยแนะนำการซ้อมวันนี้จากสถิติล่าสุดของผม", replyToken);
    return true;
  }

  return false;
}

async function enforceEventRateLimit(userId, event) {
  if (event.type === "follow") return true;

  const messageType = event.message?.type;
  const action = messageType === "image" || messageType === "file" ? "media" : "message";
  const limit = await assertRateLimit(db, userId, action);

  if (limit.allowed) return true;

  logger.warn("Rate limit exceeded", {
    userId,
    eventType: event.type,
    messageType,
    reason: limit.reason,
  });

  if (event.replyToken) {
    await replyText(event.replyToken, limit.message);
  }

  return false;
}

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  if (!isLineSignatureValid(req, CONFIG.LINE_CHANNEL_SECRET)) {
    console.warn("Rejected LINE webhook request with invalid signature");
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const events = req.body.events || [];

  for (const event of events) {
    const userId =
      event.source?.userId ||
      event.source?.groupId ||
      event.source?.roomId;

    if (!userId) continue;

    try {
      if (!(await enforceEventRateLimit(userId, event))) {
        continue;
      }

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
        const action = normalizeMenuAction(data);

        logger.info("LINE postback received", {
          userId,
          data,
          action,
        });

        if (await handleMenuAction(userId, action, event.replyToken)) {
          continue;
        }

        await replyText(event.replyToken, "ยังไม่รู้จักเมนูนี้ครับ ลองกดเมนูอื่นหรือพิมพ์ถามอาจารย์ได้เลย");
        continue;
      }

      if (event.type === "message") {
        const message = event.message;

        if (message.type === "text") {
          const text = message.text.trim();
          if (await handleWeightTrainingText(userId, text, event.replyToken)) { continue; } const action = normalizeMenuAction(text);

          if (action) {
            logger.info("LINE menu text received", {
              userId,
              text,
              action,
            });

            await handleMenuAction(userId, action, event.replyToken);
            continue;
          }

          await handleAIChat(userId, text, event.replyToken);
          continue;
        }

        if (message.type === "image") {
          const imageRes = await withRetry(
            () => axios.get(
              `https://api-data.line.me/v2/bot/message/${message.id}/content`,
              {
                headers: {
                  Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
                },
                responseType: "arraybuffer",
                timeout: 10000,
              }
            ),
            {
              onRetry: (error, meta) => logger.warn("Retrying LINE image download", {
                error: error.message,
                ...meta,
              }),
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
              buildRunResultFlexMessage(activity, cleanText, {
                source: "Screenshot",
                title: "อ่านผลวิ่งจากรูปแล้ว",
              }),
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
          logger.info("LINE file received", {
            userId,
            fileName,
            messageId: message.id,
          });

          if (!fileName.toLowerCase().endsWith(".gpx")) {
            await replyText(
              event.replyToken,
              "ตอนนี้รองรับไฟล์ .gpx ครับ หรือส่งรูป screenshot ผลการวิ่งก็ได้ 📸"
            );
            continue;
          }

          const fileRes = await withRetry(
            () => axios.get(
              `https://api-data.line.me/v2/bot/message/${message.id}/content`,
              {
                headers: {
                  Authorization: `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`,
                },
                responseType: "text",
                timeout: 10000,
              }
            ),
            {
              onRetry: (error, meta) => logger.warn("Retrying LINE file download", {
                error: error.message,
                ...meta,
              }),
            }
          );

          const gpxData = parseGPX(fileRes.data);

          if (!gpxData) {
            logger.warn("GPX parse returned no activity", {
              userId,
              fileName,
            });
            await replyText(event.replyToken, "อ่านไฟล์ GPX ไม่ได้ครับ ลองส่งไฟล์ใหม่อีกครั้งนะครับ");
            continue;
          }

          logger.info("GPX parsed successfully", {
            userId,
            fileName,
            distance: gpxData.distance,
            duration: gpxData.duration,
            pace: gpxData.pace,
          });

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
ตอบเป็นข้อความสั้น 1-2 ประโยคเท่านั้น
ห้ามตอบ JSON ห้ามใส่ key/value และไม่ต้องทวนข้อมูลดิบทั้งหมด
`);

          await saveConversation(userId, "user", "[ส่งไฟล์ GPX]");
          await saveConversation(userId, "assistant", analysis);

          const replies = [
            buildRunResultFlexMessage(gpxData, analysis, {
              source: "GPX",
              title: "อ่านไฟล์ GPX แล้ว",
            }),
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

async function startServer() {
  validateConfig(CONFIG);
  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer().catch((e) => {
  console.error("Failed to start server:", e);
  process.exit(1);
});


