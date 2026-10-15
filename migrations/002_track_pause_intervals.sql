CREATE TABLE IF NOT EXISTS track_pause_intervals (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES track_sessions(id) ON DELETE CASCADE,
  paused_at_ms INTEGER NOT NULL,
  resumed_at_ms INTEGER,
  CHECK(resumed_at_ms IS NULL OR resumed_at_ms >= paused_at_ms)
);
CREATE INDEX IF NOT EXISTS ix_track_pause_interval ON track_pause_intervals(track_id,paused_at_ms,resumed_at_ms);
