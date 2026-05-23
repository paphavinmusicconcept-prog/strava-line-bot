function mapProfileRow(row) {
  if (!row) return null;

  return {
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    age: row.age,
    restingHr: row.resting_hr,
    maxHr: row.max_hr,
    maxHrSource: row.max_hr_source,
    goalType: row.goal_type,
    trainingDaysPerWeek: row.training_days_per_week,
    hrZoneMethod: row.hr_zone_method,
    hrZones: row.hr_zones || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createProfileRepository(db) {
  async function save(lineUserId, profile) {
    const res = await db.query(
      `INSERT INTO user_profiles
       (line_user_id, display_name, age, resting_hr, max_hr, max_hr_source, goal_type,
        training_days_per_week, hr_zone_method, hr_zones)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (line_user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         age = EXCLUDED.age,
         resting_hr = EXCLUDED.resting_hr,
         max_hr = EXCLUDED.max_hr,
         max_hr_source = EXCLUDED.max_hr_source,
         goal_type = EXCLUDED.goal_type,
         training_days_per_week = EXCLUDED.training_days_per_week,
         hr_zone_method = EXCLUDED.hr_zone_method,
         hr_zones = EXCLUDED.hr_zones,
         updated_at = NOW()
       RETURNING *`,
      [
        lineUserId,
        profile.displayName,
        profile.age,
        profile.restingHr,
        profile.maxHr,
        profile.maxHrSource,
        profile.goalType,
        profile.trainingDaysPerWeek,
        profile.hrZoneMethod,
        JSON.stringify(profile.hrZones || {}),
      ]
    );

    return mapProfileRow(res.rows[0]);
  }

  async function findByLineUserId(lineUserId) {
    const res = await db.query(
      `SELECT *
       FROM user_profiles
       WHERE line_user_id = $1`,
      [lineUserId]
    );
    return mapProfileRow(res.rows[0]);
  }

  return {
    save,
    findByLineUserId,
  };
}

module.exports = {
  createProfileRepository,
  mapProfileRow,
};
