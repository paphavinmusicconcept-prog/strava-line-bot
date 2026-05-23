CREATE TABLE IF NOT EXISTS user_profiles (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  age INTEGER,
  resting_hr INTEGER,
  max_hr INTEGER,
  max_hr_source TEXT,
  goal_type TEXT,
  training_days_per_week INTEGER,
  hr_zone_method TEXT,
  hr_zones JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_goal_type
  ON user_profiles(goal_type);
