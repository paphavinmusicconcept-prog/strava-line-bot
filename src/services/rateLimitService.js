const DEFAULT_LIMITS = {
  message: { perMinute: 12, perDay: 80 },
  ai: { perMinute: 8, perDay: 50 },
  media: { perMinute: 4, perDay: 25 },
};

const buckets = new Map();

function bucketKey(userId, action) {
  return `${userId}:${action}`;
}

function consumeMemoryBucket(userId, action, limit) {
  const now = Date.now();
  const key = bucketKey(userId, action);
  const bucket = buckets.get(key) || { count: 0, resetAt: now + 60000 };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  return bucket.count <= limit;
}

async function consumeDailyUsage(db, userId, action, limit) {
  const res = await db.query(
    `INSERT INTO user_usage_daily (user_id, action, usage_date, count)
     VALUES ($1, $2, CURRENT_DATE, 1)
     ON CONFLICT (user_id, action, usage_date)
     DO UPDATE SET count = user_usage_daily.count + 1, updated_at = NOW()
     RETURNING count`,
    [userId, action]
  );

  return Number(res.rows[0].count) <= limit;
}

async function assertRateLimit(db, userId, action, overrides = {}) {
  const limits = { ...(DEFAULT_LIMITS[action] || DEFAULT_LIMITS.message), ...overrides };

  if (!consumeMemoryBucket(userId, action, limits.perMinute)) {
    return {
      allowed: false,
      reason: "minute",
      message: "ส่งถี่ไปนิดครับ พักสักครู่แล้วลองใหม่อีกครั้งนะครับ",
    };
  }

  const dailyOk = await consumeDailyUsage(db, userId, action, limits.perDay);
  if (!dailyOk) {
    return {
      allowed: false,
      reason: "daily",
      message: "วันนี้ใช้โควตาครบแล้วครับ พรุ่งนี้ค่อยกลับมาคุยกันใหม่นะครับ",
    };
  }

  return { allowed: true };
}

module.exports = {
  assertRateLimit,
  DEFAULT_LIMITS,
};
