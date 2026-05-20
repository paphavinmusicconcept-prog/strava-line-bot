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
  source_activity_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS source_activity_id TEXT;

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

CREATE TABLE IF NOT EXISTS user_usage_daily (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  usage_date DATE NOT NULL,
  count INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, action, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_history_user_id_created_at
  ON conversation_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_user_id_date
  ON activities(user_id, date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_unique_source_activity
  ON activities(user_id, source, source_activity_id)
  WHERE source_activity_id IS NOT NULL;
