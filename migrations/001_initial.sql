CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS track_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('recording','paused','finished')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  pause_started_at TEXT,
  active_seconds INTEGER,
  paused_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK(is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS ix_tracks_user ON track_sessions(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_track_per_user ON track_sessions(user_id) WHERE status IN ('recording','paused');

CREATE TABLE IF NOT EXISTS track_points (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES track_sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lon REAL NOT NULL CHECK(lon BETWEEN -180 AND 180),
  accuracy REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(track_id,client_id)
);
CREATE INDEX IF NOT EXISTS ix_points_track_time ON track_points(track_id,ts);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  track_id TEXT UNIQUE REFERENCES track_sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '其他',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft','pending_review','published','rejected','withdrawn','unpublished')),
  distance_m INTEGER NOT NULL DEFAULT 0 CHECK(distance_m>=0),
  elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_seconds>=0),
  moving_seconds INTEGER NOT NULL DEFAULT 0 CHECK(moving_seconds>=0),
  public_geometry TEXT NOT NULL DEFAULT '[]',
  cover_photo_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK(is_demo IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_routes_public ON routes(status,published_at DESC);
CREATE INDEX IF NOT EXISTS ix_routes_owner ON routes(user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS route_segments (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('步行','地铁','公交','骑行','打车','自驾','其他')),
  start_label TEXT NOT NULL DEFAULT '',
  end_label TEXT NOT NULL DEFAULT '',
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('track','manual','demo')),
  UNIQUE(route_id,position)
);

CREATE TABLE IF NOT EXISTS route_checkpoints (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('美食','景点','摄影','休息','购物','其他')),
  note TEXT NOT NULL DEFAULT '',
  recommended TEXT NOT NULL DEFAULT '',
  spend INTEGER NOT NULL DEFAULT 0 CHECK(spend>=0),
  stay_minutes INTEGER NOT NULL DEFAULT 0 CHECK(stay_minutes>=0),
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lon REAL NOT NULL CHECK(lon BETWEEN -180 AND 180),
  segment_id TEXT REFERENCES route_segments(id) ON DELETE SET NULL,
  location_source TEXT NOT NULL CHECK(location_source IN ('live','track','manual','demo')),
  created_at TEXT NOT NULL,
  UNIQUE(route_id,position)
);

CREATE TABLE IF NOT EXISTS route_photos (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  checkpoint_id TEXT REFERENCES route_checkpoints(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('cover','checkpoint')),
  stored_name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 8388608),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_photos_route ON route_photos(route_id);

CREATE TABLE IF NOT EXISTS route_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  route_version INTEGER NOT NULL,
  UNIQUE(user_id,route_id)
);

CREATE TABLE IF NOT EXISTS follow_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  route_version INTEGER NOT NULL,
  title_snapshot TEXT NOT NULL,
  geometry_snapshot TEXT NOT NULL,
  segments_snapshot TEXT NOT NULL,
  checkpoints_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  pause_started_at TEXT,
  paused_seconds INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_follow_user ON follow_sessions(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS follow_checkpoints (
  id TEXT PRIMARY KEY,
  follow_id TEXT NOT NULL REFERENCES follow_sessions(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL,
  arrived_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(follow_id,checkpoint_id)
);

CREATE TABLE IF NOT EXISTS route_reports (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_reports_status ON route_reports(status,created_at);

CREATE TABLE IF NOT EXISTS moderation_logs (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
