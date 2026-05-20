function mapActivityRow(row) {
  return {
    date: row.date,
    distance: parseFloat(row.distance),
    pace: parseFloat(row.pace),
    duration: parseFloat(row.duration),
    calories: parseFloat(row.calories),
    elevGain: parseFloat(row.elev_gain),
    source: row.source,
    sourceActivityId: row.source_activity_id,
  };
}

function createActivityRepository(db, helpers = {}) {
  const { estimateCadence, normalizeLookbackDays } = helpers;

  async function save(userId, activity) {
    await db.query(
      `INSERT INTO activities
        (user_id, date, distance, pace, duration, calories, elev_gain, cadence, source, source_activity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, source, source_activity_id)
       WHERE source_activity_id IS NOT NULL
       DO UPDATE SET
         date = EXCLUDED.date,
         distance = EXCLUDED.distance,
         pace = EXCLUDED.pace,
         duration = EXCLUDED.duration,
         calories = EXCLUDED.calories,
         elev_gain = EXCLUDED.elev_gain,
         cadence = EXCLUDED.cadence`,
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
        activity.sourceActivityId ? String(activity.sourceActivityId) : null,
      ]
    );
  }

  async function findRecent(userId, days = 7) {
    const safeDays = normalizeLookbackDays(days);
    const res = await db.query(
      `SELECT *
       FROM activities
       WHERE user_id = $1
         AND date > NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY date DESC`,
      [userId, safeDays]
    );

    return res.rows.map(mapActivityRow);
  }

  return { save, findRecent };
}

module.exports = { createActivityRepository };
