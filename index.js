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
à¸­à¹ˆà¸²à¸™à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸•à¹ˆà¸­à¹„à¸›à¸™à¸µà¹‰ à¹à¸¥à¹‰à¸§à¸”à¸¶à¸‡à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸£à¸°à¸¢à¸°à¸¢à¸²à¸§à¸—à¸µà¹ˆà¸„à¸§à¸£à¸ˆà¸³à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸šà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡à¸„à¸™à¸™à¸µà¹‰

User:
${userText}

Assistant:
${assistantText}

à¹ƒà¸«à¹‰à¸•à¸­à¸šà¹€à¸›à¹‡à¸™ JSON à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™ à¸«à¹‰à¸²à¸¡à¸¡à¸µà¸„à¸³à¸­à¸˜à¸´à¸šà¸²à¸¢à¸­à¸·à¹ˆà¸™

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
      "content": "à¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸—à¸µà¹ˆà¸„à¸§à¸£à¸ˆà¸³",
      "importance": 1
    }
  ]
}

à¸à¸•à¸´à¸à¸²:
- à¹€à¸à¹‡à¸šà¹€à¸‰à¸žà¸²à¸°à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸—à¸µà¹ˆà¸™à¹ˆà¸²à¸ˆà¸°à¹ƒà¸Šà¹‰à¹„à¸”à¹‰à¸™à¸²à¸™
- à¸­à¸¢à¹ˆà¸²à¹€à¸à¹‡à¸šà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¸—à¸±à¹ˆà¸§à¹„à¸›
- à¸–à¹‰à¸²à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹ƒà¸«à¸¡à¹ˆ à¹ƒà¸«à¹‰ profile à¸—à¸¸à¸à¸Šà¹ˆà¸­à¸‡à¹€à¸›à¹‡à¸™ null à¹à¸¥à¸° memories à¹€à¸›à¹‡à¸™ []
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
      prs.push(`ðŸ… PR à¸£à¸°à¸¢à¸°à¸—à¸²à¸‡! ${activity.distance.toFixed(2)}km (à¹€à¸”à¸´à¸¡ ${pr.longestRun.toFixed(2)}km)`);
    } else {
      prs.push(`ðŸ… PR à¸£à¸°à¸¢à¸°à¸—à¸²à¸‡à¸„à¸£à¸±à¹‰à¸‡à¹à¸£à¸! ${activity.distance.toFixed(2)}km`);
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
        `âš¡ PR Pace! ${pMin}:${String(pSec).padStart(2, "0")}/km (à¹€à¸”à¸´à¸¡ ${oldMin}:${String(oldSec).padStart(2, "0")}/km)`
      );
    } else {
      prs.push(
        `âš¡ PR Pace à¸„à¸£à¸±à¹‰à¸‡à¹à¸£à¸! ${pMin}:${String(pSec).padStart(2, "0")}/km`
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
      text: "â¤ï¸ Heart Rate Zones",
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
    altText: "à¸ªà¸–à¸´à¸•à¸´à¸§à¸±à¸™à¸™à¸µà¹‰",
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
            text: "à¸ªà¸–à¸´à¸•à¸´à¸§à¸±à¸™à¸™à¸µà¹‰",
            size: "xl",
            weight: "bold",
            color: "#111111",
          },
          {
            type: "text",
            text: "à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸‚à¸­à¸‡à¸„à¸¸à¸“",
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
                    text: "à¹€à¸§à¸¥à¸²",
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
                  { type: "text", text: "ðŸ”¥", size: "lg", align: "center" },
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
                  { type: "text", text: "ðŸ‘Ÿ", size: "lg", align: "center" },
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
                  { type: "text", text: "â›°ï¸", size: "lg", align: "center" },
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
                text: "à¸§à¸±à¸™à¸™à¸µà¹‰ pace à¸„à¹ˆà¸­à¸™à¸‚à¹‰à¸²à¸‡à¸™à¸´à¹ˆà¸‡à¸”à¸µ à¸¥à¸­à¸‡à¸„à¸¸à¸¡à¹ƒà¸«à¹‰à¸­à¸¢à¸¹à¹ˆà¹‚à¸‹à¸™à¸ªà¸šà¸²à¸¢ à¹† à¹€à¸žà¸·à¹ˆà¸­à¸ªà¸°à¸ªà¸¡à¸„à¸§à¸²à¸¡à¸•à¹ˆà¸­à¹€à¸™à¸·à¹ˆà¸­à¸‡",
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
              label: "à¸”à¸¹à¸„à¸³à¹à¸™à¸°à¸™à¸³à¸§à¸±à¸™à¸™à¸µà¹‰",
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
    altText: `ðŸƒ à¸ªà¸£à¸¸à¸›à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡${label}`,
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
            text: "ðŸƒ à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡",
            color: "#ffffff",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: `à¸ªà¸£à¸¸à¸›à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡${label}`,
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
                    text: "km à¸£à¸§à¸¡",
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
                    text: "spm à¸£à¸­à¸šà¸‚à¸²",
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
                text: "à¸§à¸±à¸™à¸—à¸µà¹ˆ",
                size: "xs",
                color: "#888888",
                flex: 3,
              },
              {
                type: "text",
                text: "à¸£à¸°à¸¢à¸°",
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
                text: "ðŸ”¥ à¹à¸„à¸¥à¸­à¸£à¸µà¹ˆà¸£à¸§à¸¡",
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
            text: `ðŸ“ ${a.source || "Manual"}`,
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
                    text: "à¸™à¸²à¸—à¸µ",
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
    altText: "ðŸ“‹ à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸§à¸´à¹ˆà¸‡ 5 à¸„à¸£à¸±à¹‰à¸‡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”",
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
    "â–ˆ".repeat(Math.floor(progress / 10)) +
    "â–‘".repeat(10 - Math.floor(progress / 10));

  const color =
    progress >= 100 ? "#27AE60" : progress >= 50 ? "#E8703A" : "#E74C3C";

  return {
    type: "flex",
    altText: `ðŸŽ¯ Challenge: ${challenge.goal}km`,
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
            text: "ðŸŽ¯ Challenge à¸‚à¸­à¸‡à¸„à¸¸à¸“",
            color: "#ffffff",
            size: "sm",
            weight: "bold",
          },
          {
            type: "text",
            text: progress >= 100 ? "ðŸ† à¸ªà¸³à¹€à¸£à¹‡à¸ˆà¹à¸¥à¹‰à¸§!" : `à¹€à¸«à¸¥à¸·à¸­à¸­à¸µà¸ ${daysLeft} à¸§à¸±à¸™`,
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
                    text: "km à¸§à¸´à¹ˆà¸‡à¹à¸¥à¹‰à¸§",
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
                    text: "km à¹€à¸›à¹‰à¸²à¸«à¸¡à¸²à¸¢",
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
                    ? "ðŸŽ‰ à¸—à¸³à¹„à¸”à¹‰à¹à¸¥à¹‰à¸§à¸„à¸£à¸±à¸š!"
                    : `à¹€à¸«à¸¥à¸·à¸­à¸­à¸µà¸ ${remaining.toFixed(1)} km`,
                size: "sm",
                color: "#555555",
              },
              {
                type: "text",
                text: `${daysLeft} à¸§à¸±à¸™`,
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
    altText: "ðŸ… à¸„à¸¸à¸“à¸—à¸³ PR à¹à¸¥à¹‰à¸§!",
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
            text: "ðŸ… Personal Record!",
            color: "#ffffff",
            size: "md",
            weight: "bold",
            align: "center",
          },
          {
            type: "text",
            text: "à¸¢à¸­à¸”à¹€à¸¢à¸µà¹ˆà¸¢à¸¡à¸¡à¸²à¸à¸„à¸£à¸±à¸š! ðŸŽ‰",
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
            text: activityName || "à¸à¸´à¸ˆà¸à¸£à¸£à¸¡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”",
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
            text: "à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸‚à¸­à¸›à¸£à¸šà¸¡à¸·à¸­à¹ƒà¸«à¹‰à¹€à¸¥à¸¢ ðŸ’ª",
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
    altText: "ðŸ†• à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡ AI Beta 2.0",
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
            text: "ðŸƒ à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡ AI",
            color: "#E8703A",
            size: "md",
            weight: "bold",
          },
          {
            type: "text",
            text: "Beta 2.0 â€” à¸¡à¸µà¸­à¸°à¹„à¸£à¹ƒà¸«à¸¡à¹ˆà¸šà¹‰à¸²à¸‡?",
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
            text: "âœ¨ AI à¸ˆà¸³à¹€à¸›à¹‰à¸²à¸«à¸¡à¸²à¸¢à¹à¸¥à¸°à¸šà¸£à¸´à¸šà¸—à¸‚à¸­à¸‡à¸„à¸¸à¸“à¹„à¸”à¹‰",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "ðŸ“¸ à¸ªà¹ˆà¸‡ screenshot à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¹ƒà¸«à¹‰ AI à¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œà¹„à¸”à¹‰",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "ðŸ“Š à¸ªà¸£à¸¸à¸›à¸ªà¸–à¸´à¸•à¸´à¸£à¸²à¸¢à¸§à¸±à¸™à¹à¸¥à¸°à¸£à¸²à¸¢à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œ",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "ðŸŽ¯ à¸•à¸±à¹‰à¸‡ Challenge à¸žà¸£à¹‰à¸­à¸¡ Progress Bar",
            size: "sm",
            color: "#333333",
            wrap: true,
          },
          {
            type: "text",
            text: "ðŸ… à¸•à¸£à¸§à¸ˆà¸ˆà¸±à¸š PR à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´",
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

à¸à¸£à¸¸à¸“à¸²à¸•à¸­à¸šà¹€à¸›à¹‡à¸™à¸ à¸²à¸©à¸²à¹„à¸—à¸¢à¹ƒà¸™à¸šà¸—à¸šà¸²à¸—à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡ AI
à¸•à¸­à¸šà¹ƒà¸«à¹‰à¹€à¸«à¸¡à¸²à¸°à¸à¸±à¸šà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ˆà¸£à¸´à¸‡à¸‚à¸­à¸‡ user
à¸–à¹‰à¸²à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸žà¸­ à¹ƒà¸«à¹‰à¸–à¸²à¸¡à¸•à¹ˆà¸­à¹à¸šà¸šà¹€à¸›à¹‡à¸™à¸˜à¸£à¸£à¸¡à¸Šà¸²à¸•à¸´
à¸­à¸¢à¹ˆà¸²à¸•à¸­à¸šà¸¢à¸²à¸§à¹€à¸à¸´à¸™à¹„à¸›
`;

  const answer = await analyzeWithClaudeWithHistory(prompt, history);

  await saveConversation(userId, "assistant", answer);

  extractMemoryFromChat(userId, text, answer);

  await replyText(replyToken, answer);
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
          "ðŸƒ à¸ªà¸§à¸±à¸ªà¸”à¸µà¸„à¸£à¸±à¸š! à¸¢à¸´à¸™à¸”à¸µà¸•à¹‰à¸­à¸™à¸£à¸±à¸šà¸ªà¸¹à¹ˆà¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡ AI\n\nà¸ªà¹ˆà¸‡à¸£à¸¹à¸›à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡, à¹„à¸Ÿà¸¥à¹Œ GPX à¸«à¸£à¸·à¸­à¸žà¸´à¸¡à¸žà¹Œà¸„à¸¸à¸¢à¸à¸±à¸šà¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¹„à¸”à¹‰à¹€à¸¥à¸¢à¸„à¸£à¸±à¸š ðŸ’ª"
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
            await replyText(event.replyToken, "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸„à¸£à¸±à¸š à¸ªà¹ˆà¸‡ screenshot à¸«à¸£à¸·à¸­à¹€à¸Šà¸·à¹ˆà¸­à¸¡ Strava à¸à¹ˆà¸­à¸™à¹„à¸”à¹‰à¹€à¸¥à¸¢");
            continue;
          }

          await replyFlex(event.replyToken, buildTodayStatsFlexMessage(latest));
          continue;
        }

        if (data === "action=today_recommendation") {
          await handleAIChat(userId, "à¸Šà¹ˆà¸§à¸¢à¹à¸™à¸°à¸™à¸³à¸à¸²à¸£à¸‹à¹‰à¸­à¸¡à¸§à¸±à¸™à¸™à¸µà¹‰à¸ˆà¸²à¸à¸ªà¸–à¸´à¸•à¸´à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸‚à¸­à¸‡à¸œà¸¡", event.replyToken);
          continue;
        }

        if (data === "action=weekly_summary") {
          const activities = await getActivitiesForUser(userId, 7);
          const stats = calcStatsFromActivities(activities);

          if (!stats) {
            await replyText(event.replyToken, "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œà¸™à¸µà¹‰à¸„à¸£à¸±à¸š");
            continue;
          }

          await replyFlex(event.replyToken, buildStatsFlexMessage(stats, "à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œà¸™à¸µà¹‰"));
          continue;
        }

        await handleAIChat(userId, `User à¸à¸”à¹€à¸¡à¸™à¸¹: ${data}`, event.replyToken);
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

          if (text === "/today" || text === "à¸ªà¸–à¸´à¸•à¸´à¸§à¸±à¸™à¸™à¸µà¹‰") {
            const activities = await getActivitiesForUser(userId, 7);
            const latest = activities[0];

            if (!latest) {
              await replyText(event.replyToken, "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸„à¸£à¸±à¸š à¸ªà¹ˆà¸‡ screenshot à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸¡à¸²à¸à¹ˆà¸­à¸™à¹„à¸”à¹‰à¹€à¸¥à¸¢ ðŸ“¸");
              continue;
            }

            await replyFlex(event.replyToken, buildTodayStatsFlexMessage(latest));
            continue;
          }

          if (text === "/summary" || text === "à¸ªà¸£à¸¸à¸›à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œ") {
            const activities = await getActivitiesForUser(userId, 7);
            const stats = calcStatsFromActivities(activities);

            if (!stats) {
              await replyText(event.replyToken, "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œà¸™à¸µà¹‰à¸„à¸£à¸±à¸š");
              continue;
            }

            await replyFlex(event.replyToken, buildStatsFlexMessage(stats, "à¸ªà¸±à¸›à¸”à¸²à¸«à¹Œà¸™à¸µà¹‰"));
            continue;
          }

          if (text === "/history" || text === "à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸¥à¹ˆà¸²à¸ªà¸¸à¸”") {
            const activities = await getActivitiesForUser(userId, 30);
            const carousel = buildCarouselMessage(activities);

            if (!carousel) {
              await replyText(event.replyToken, "à¸¢à¸±à¸‡à¹„à¸¡à¹ˆà¸¡à¸µà¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸„à¸£à¸±à¸š");
              continue;
            }

            await replyFlex(event.replyToken, carousel);
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
            "à¸Šà¹ˆà¸§à¸¢à¸­à¹ˆà¸²à¸™à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸ˆà¸²à¸à¸£à¸¹à¸›à¸™à¸µà¹‰ à¸”à¸¶à¸‡ distance, pace, duration, calories, elevation, date à¹à¸¥à¹‰à¸§à¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œà¹€à¸›à¹‡à¸™à¸ à¸²à¸©à¸²à¹„à¸—à¸¢",
            imageBase64
          );

          const activity = extractActivityFromResponse(analysis);

          if (activity) {
            await dbSaveActivity(userId, activity);
            saveActivity(userId, activity);

            const prs = checkPR(userId, activity);

            const cleanText = analysis.replace(/\{[\s\S]*?\}/, "").trim();

            await saveConversation(userId, "user", "[à¸ªà¹ˆà¸‡à¸£à¸¹à¸›à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡]");
            await saveConversation(userId, "assistant", cleanText);

            const replies = [
              {
                type: "text",
                text: cleanText || "à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸­à¹ˆà¸²à¸™à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¹ƒà¸«à¹‰à¹à¸¥à¹‰à¸§à¸„à¸£à¸±à¸š ðŸ’ª",
              },
              buildTodayStatsFlexMessage(activity),
            ];

            if (prs) {
              replies.push(buildPRFlexMessage(prs, activity.name || "à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸¥à¹ˆà¸²à¸ªà¸¸à¸”"));
            }

            await replyMessage(event.replyToken, replies);
          } else {
            await replyText(
              event.replyToken,
              "à¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸¢à¸±à¸‡à¸­à¹ˆà¸²à¸™à¸„à¹ˆà¸²à¸ªà¸–à¸´à¸•à¸´à¸ˆà¸²à¸à¸£à¸¹à¸›à¸™à¸µà¹‰à¹„à¸¡à¹ˆà¸Šà¸±à¸”à¸„à¸£à¸±à¸š à¸¥à¸­à¸‡à¸ªà¹ˆà¸‡ screenshot à¸—à¸µà¹ˆà¹€à¸«à¹‡à¸™à¸£à¸°à¸¢à¸°/pace/à¹€à¸§à¸¥à¸² à¸Šà¸±à¸” à¹† à¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡à¸™à¸°à¸„à¸£à¸±à¸š ðŸ“¸"
            );
          }

          continue;
        }

        if (message.type === "file") {
          const fileName = message.fileName || "";

          if (!fileName.toLowerCase().endsWith(".gpx")) {
            await replyText(
              event.replyToken,
              "à¸•à¸­à¸™à¸™à¸µà¹‰à¸£à¸­à¸‡à¸£à¸±à¸šà¹„à¸Ÿà¸¥à¹Œ .gpx à¸„à¸£à¸±à¸š à¸«à¸£à¸·à¸­à¸ªà¹ˆà¸‡à¸£à¸¹à¸› screenshot à¸œà¸¥à¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸à¹‡à¹„à¸”à¹‰ ðŸ“¸"
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
            await replyText(event.replyToken, "à¸­à¹ˆà¸²à¸™à¹„à¸Ÿà¸¥à¹Œ GPX à¹„à¸¡à¹ˆà¹„à¸”à¹‰à¸„à¸£à¸±à¸š à¸¥à¸­à¸‡à¸ªà¹ˆà¸‡à¹„à¸Ÿà¸¥à¹Œà¹ƒà¸«à¸¡à¹ˆà¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡à¸™à¸°à¸„à¸£à¸±à¸š");
            continue;
          }

          await dbSaveActivity(userId, gpxData);
          saveActivity(userId, gpxData);

          const prs = checkPR(userId, gpxData);

          const analysis = await analyzeWithClaude(`
à¸§à¸´à¹€à¸„à¸£à¸²à¸°à¸«à¹Œà¸à¸²à¸£à¸§à¸´à¹ˆà¸‡à¸™à¸µà¹‰:
à¸£à¸°à¸¢à¸° ${gpxData.distance} km
pace ${paceDecimalToText(gpxData.pace)} /km
à¹€à¸§à¸¥à¸² ${durationMinToText(gpxData.duration)}
elevation ${gpxData.elevGain} m

à¸•à¸­à¸šà¹€à¸›à¹‡à¸™à¸ à¸²à¸©à¸²à¹„à¸—à¸¢à¹à¸šà¸šà¸­à¸²à¸ˆà¸²à¸£à¸¢à¹Œà¸™à¸±à¸à¸§à¸´à¹ˆà¸‡ AI
`);

          await saveConversation(userId, "user", "[à¸ªà¹ˆà¸‡à¹„à¸Ÿà¸¥à¹Œ GPX]");
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
            "à¸‚à¸­à¹‚à¸—à¸©à¸„à¸£à¸±à¸š à¸£à¸°à¸šà¸šà¸¡à¸µà¸›à¸±à¸à¸«à¸²à¸Šà¸±à¹ˆà¸§à¸„à¸£à¸²à¸§ à¸¥à¸­à¸‡à¹ƒà¸«à¸¡à¹ˆà¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡à¸™à¸°à¸„à¸£à¸±à¸š"
          );
        }
      } catch (_) {}
    }
  }
});

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("AI Running Coach LINE Bot is running âœ…");
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
    console.log(`ðŸš€ Server running on port ${PORT}`);
  });
}

startServer().catch((e) => {
  console.error("Failed to start server:", e);
  process.exit(1);
});

