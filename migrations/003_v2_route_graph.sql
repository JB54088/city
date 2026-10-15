BEGIN IMMEDIATE;

ALTER TABLE track_sessions ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_track_idempotency
  ON track_sessions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE route_checkpoints ADD COLUMN marker_type TEXT NOT NULL DEFAULT '其他';
ALTER TABLE route_checkpoints ADD COLUMN coordinate_system TEXT NOT NULL DEFAULT 'WGS84';
ALTER TABLE route_photos ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE route_photos ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE routes ADD COLUMN public_geometry_segments TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX IF NOT EXISTS ux_route_photo_content
  ON route_photos(checkpoint_id,content_sha256)
  WHERE checkpoint_id IS NOT NULL AND content_sha256<>'';

CREATE TABLE IF NOT EXISTS route_waypoints (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  order_index INTEGER NOT NULL CHECK(order_index >= 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  marker_type TEXT NOT NULL DEFAULT '其他',
  position_source TEXT NOT NULL CHECK(position_source IN ('live','track','manual','demo')),
  coordinate_system TEXT NOT NULL DEFAULT 'WGS84' CHECK(coordinate_system IN ('WGS84','GCJ-02')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  recommended TEXT NOT NULL DEFAULT '',
  optional_spend REAL NOT NULL DEFAULT 0 CHECK(optional_spend >= 0),
  stay_minutes INTEGER NOT NULL DEFAULT 0 CHECK(stay_minutes >= 0),
  UNIQUE(route_id, order_index)
);
CREATE INDEX IF NOT EXISTS ix_waypoints_route_order ON route_waypoints(route_id, order_index);
INSERT INTO route_waypoints
  (id,route_id,order_index,title,description,latitude,longitude,marker_type,position_source,coordinate_system,created_by,created_at,recommended,optional_spend,stay_minutes)
SELECT id,route_id,position,name,note,lat,lon,marker_type,location_source,coordinate_system,user_id,created_at,recommended,spend,stay_minutes
FROM route_checkpoints;

CREATE TABLE IF NOT EXISTS route_legs (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  from_waypoint_id TEXT NOT NULL REFERENCES route_waypoints(id) ON DELETE CASCADE,
  to_waypoint_id TEXT NOT NULL REFERENCES route_waypoints(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL CHECK(order_index >= 0),
  transport_mode TEXT NOT NULL CHECK(transport_mode IN ('walking','subway','bus','cycling','taxi','driving','other')),
  mode_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(mode_confirmed IN (0,1)),
  actual_duration_seconds INTEGER CHECK(actual_duration_seconds IS NULL OR actual_duration_seconds >= 0),
  notes TEXT NOT NULL DEFAULT '',
  line_info TEXT NOT NULL DEFAULT '',
  track_start_index INTEGER,
  track_end_index INTEGER,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','inherited','demo')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(route_id, order_index),
  UNIQUE(route_id, from_waypoint_id, to_waypoint_id),
  CHECK(from_waypoint_id <> to_waypoint_id),
  CHECK(track_start_index IS NULL OR track_end_index IS NULL OR track_end_index >= track_start_index)
);
CREATE INDEX IF NOT EXISTS ix_legs_route_order ON route_legs(route_id, order_index);

CREATE TABLE IF NOT EXISTS waypoint_photos (
  id TEXT PRIMARY KEY,
  waypoint_id TEXT NOT NULL REFERENCES route_waypoints(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 8388608),
  sort_index INTEGER NOT NULL DEFAULT 0 CHECK(sort_index >= 0),
  content_sha256 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(waypoint_id, sort_index)
);
CREATE INDEX IF NOT EXISTS ix_waypoint_photos_order ON waypoint_photos(waypoint_id,sort_index);
INSERT INTO waypoint_photos(id,waypoint_id,storage_key,mime,size_bytes,sort_index,content_sha256,created_at)
SELECT p.id,p.checkpoint_id,p.stored_name,p.mime,p.size_bytes,
  (SELECT COUNT(*) FROM route_photos q WHERE q.checkpoint_id=p.checkpoint_id
    AND (q.created_at<p.created_at OR (q.created_at=p.created_at AND q.id<p.id))),p.content_sha256,p.created_at
FROM route_photos p WHERE p.checkpoint_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS route_versions (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('pending_review','published','rejected','withdrawn')),
  snapshot_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  access_revoked_at TEXT,
  UNIQUE(route_id, version)
);
CREATE INDEX IF NOT EXISTS ix_route_versions_route_version ON route_versions(route_id,version DESC);

ALTER TABLE follow_sessions ADD COLUMN route_version_id TEXT REFERENCES route_versions(id) ON DELETE SET NULL;
ALTER TABLE follow_sessions ADD COLUMN waypoints_snapshot TEXT NOT NULL DEFAULT '[]';
ALTER TABLE follow_sessions ADD COLUMN legs_snapshot TEXT NOT NULL DEFAULT '[]';
ALTER TABLE follow_sessions ADD COLUMN geometry_segments_snapshot TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS follow_waypoint_progress (
  id TEXT PRIMARY KEY,
  follow_id TEXT NOT NULL REFERENCES follow_sessions(id) ON DELETE CASCADE,
  waypoint_id TEXT NOT NULL,
  arrived_at TEXT NOT NULL,
  confirmation_source TEXT NOT NULL DEFAULT 'manual' CHECK(confirmation_source IN ('manual','gps')),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(follow_id,waypoint_id)
);
CREATE INDEX IF NOT EXISTS ix_follow_waypoint_progress ON follow_waypoint_progress(follow_id,arrived_at);
INSERT OR IGNORE INTO follow_waypoint_progress(id,follow_id,waypoint_id,arrived_at,note)
SELECT id,follow_id,checkpoint_id,arrived_at,note FROM follow_checkpoints;

CREATE TABLE IF NOT EXISTS follow_track_points (
  id TEXT PRIMARY KEY,
  follow_id TEXT NOT NULL REFERENCES follow_sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  lat REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lon REAL NOT NULL CHECK(lon BETWEEN -180 AND 180),
  accuracy REAL NOT NULL CHECK(accuracy BETWEEN 0 AND 10000),
  ts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(follow_id,client_id)
);
CREATE INDEX IF NOT EXISTS ix_follow_track_points_time ON follow_track_points(follow_id,ts,id);

CREATE TRIGGER IF NOT EXISTS tr_waypoints_after_insert
AFTER INSERT ON route_checkpoints
BEGIN
  INSERT INTO route_waypoints(id,route_id,order_index,title,description,latitude,longitude,marker_type,position_source,coordinate_system,created_by,created_at,recommended,optional_spend,stay_minutes)
  VALUES(NEW.id,NEW.route_id,NEW.position,NEW.name,NEW.note,NEW.lat,NEW.lon,NEW.marker_type,NEW.location_source,NEW.coordinate_system,NEW.user_id,NEW.created_at,NEW.recommended,NEW.spend,NEW.stay_minutes);
END;
CREATE TRIGGER IF NOT EXISTS tr_waypoints_after_update
AFTER UPDATE ON route_checkpoints
BEGIN
  UPDATE route_waypoints SET route_id=NEW.route_id,order_index=NEW.position,title=NEW.name,description=NEW.note,
    latitude=NEW.lat,longitude=NEW.lon,marker_type=NEW.marker_type,position_source=NEW.location_source,
    coordinate_system=NEW.coordinate_system,created_by=NEW.user_id,recommended=NEW.recommended,optional_spend=NEW.spend,stay_minutes=NEW.stay_minutes
  WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS tr_waypoints_after_delete
AFTER DELETE ON route_checkpoints
BEGIN
  DELETE FROM route_waypoints WHERE id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS tr_waypoint_photo_after_insert
AFTER INSERT ON route_photos WHEN NEW.checkpoint_id IS NOT NULL
BEGIN
  INSERT INTO waypoint_photos(id,waypoint_id,storage_key,mime,size_bytes,sort_index,content_sha256,created_at)
  VALUES(NEW.id,NEW.checkpoint_id,NEW.stored_name,NEW.mime,NEW.size_bytes,NEW.sort_index,NEW.content_sha256,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS tr_waypoint_photo_after_update
AFTER UPDATE ON route_photos WHEN NEW.checkpoint_id IS NOT NULL
BEGIN
  UPDATE waypoint_photos SET waypoint_id=NEW.checkpoint_id,storage_key=NEW.stored_name,mime=NEW.mime,
    size_bytes=NEW.size_bytes,sort_index=NEW.sort_index,content_sha256=NEW.content_sha256 WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS tr_waypoint_photo_after_delete
AFTER DELETE ON route_photos WHEN OLD.checkpoint_id IS NOT NULL
BEGIN
  DELETE FROM waypoint_photos WHERE id=OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS tr_follow_progress_after_insert
AFTER INSERT ON follow_checkpoints
BEGIN
  INSERT OR IGNORE INTO follow_waypoint_progress(id,follow_id,waypoint_id,arrived_at,note)
  VALUES(NEW.id,NEW.follow_id,NEW.checkpoint_id,NEW.arrived_at,NEW.note);
END;

PRAGMA user_version=3;
COMMIT;
