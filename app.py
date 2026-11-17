#!/usr/bin/env python3
"""CityTrace local-first MVP server. Python standard library only."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import secrets
import sqlite3
import ssl
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
APP_MODE = os.environ.get("APP_MODE", "demo").lower()
DATA_DIR = Path(os.environ.get("CITYTRACE_DATA_DIR", ROOT / "data")).expanduser()
MODE_DIR = DATA_DIR / ("demo" if APP_MODE == "demo" else "real")
DB_PATH = Path(os.environ.get("CITYTRACE_DB", MODE_DIR / "citytrace.sqlite3")).expanduser()
UPLOAD_DIR = Path(os.environ.get("CITYTRACE_UPLOAD_DIR", MODE_DIR / "uploads")).expanduser()
COOKIE = "citytrace_session"
MAX_BODY = 11 * 1024 * 1024
TOKEN_TTL = 60 * 60 * 24 * 30
LOCK = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    return db


def pw_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    value = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240_000)
    return base64.b64encode(salt + value).decode()


def check_password(password: str, stored: str) -> bool:
    try:
        raw = base64.b64decode(stored)
        return hmac.compare_digest(raw[16:], hashlib.pbkdf2_hmac("sha256", password.encode(), raw[:16], 240_000))
    except Exception:
        return False


def user_json(user: sqlite3.Row | None) -> dict | None:
    if not user:
        return None
    return {"id": user["id"], "nickname": user["nickname"], "email": user["email"], "role": user["role"]}


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    x = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6_371_000 * 2 * math.atan2(math.sqrt(x), math.sqrt(max(0, 1 - x)))


def track_geometry_stats(points: list[dict], pause_intervals: list[tuple[int, int | None]] | None = None) -> tuple[float, list[list[dict]]]:
    """Clean derived geometry while keeping pauses and long gaps as separate line parts."""
    pauses = pause_intervals or []
    ordered = sorted(points, key=lambda point: (point.get("ts", 0), point.get("client_id", "")))
    paths: list[list[dict]] = []
    distance_total = 0.0
    previous = None
    for point in ordered:
        if not (-90 <= point["lat"] <= 90 and -180 <= point["lon"] <= 180) or point.get("accuracy", 0) > 100:
            continue
        if previous is None:
            paths.append([point])
            previous = point
            continue
        elapsed = (point["ts"] - previous["ts"]) / 1000
        distance = haversine((previous["lat"], previous["lon"]), (point["lat"], point["lon"]))
        crosses_pause = any(
            (end is None and point["ts"] >= start) or
            (previous["ts"] < (end or start) and point["ts"] > start)
            for start, end in pauses
        )
        if elapsed <= 0 or elapsed > 30 or crosses_pause or distance > 2_000 or distance / max(elapsed, 0.001) > 45:
            paths.append([point])
            previous = point
            continue
        if distance >= 2:
            distance_total += distance
        paths[-1].append(point)
        previous = point
    return distance_total, [path for path in paths if path]


def path_stats(points: list[dict]) -> tuple[float, list[dict]]:
    """Compatibility helper for callers that expect one flat coordinate sequence."""
    distance, paths = track_geometry_stats(points)
    return distance, [point for path in paths for point in path]


def clipped_paths(paths: list[list[dict]], trim_m: float = 150) -> list[list[list[float]]]:
    public=[]
    for path in paths:
        if len(path)<2:
            continue
        coords=clipped_path(path,trim_m)
        if len(coords)>=2:
            public.append(coords)
    return public


def moving_time_seconds(points: list[dict], pause_intervals: list[tuple[int, int | None]] | None = None) -> int:
    """Estimate moving time from plausible adjacent GPS intervals; do not bridge long gaps."""
    total = 0.0
    valid = [p for p in points if p.get("accuracy", 0) <= 100]
    valid.sort(key=lambda p: p["ts"])
    for a, b in zip(valid, valid[1:]):
        seconds = (b["ts"] - a["ts"]) / 1000
        if seconds <= 0 or seconds > 30:
            continue
        if any(a["ts"] < (end if end is not None else b["ts"]) and b["ts"] > start for start,end in (pause_intervals or [])):
            continue
        speed = haversine((a["lat"], a["lon"]), (b["lat"], b["lon"])) / seconds
        if 0.6 <= speed <= 45:
            total += seconds
    return int(total)


def reorder_positions(db: sqlite3.Connection, table: str, route_id: str, item_id: str, new_position: int) -> bool:
    if table not in {"route_segments", "route_checkpoints"}:
        raise ValueError("unsupported ordered table")
    rows = db.execute(f"SELECT id FROM {table} WHERE route_id=? ORDER BY position", (route_id,)).fetchall()
    ids = [row["id"] for row in rows]
    if item_id not in ids or new_position < 0 or new_position >= len(ids):
        return False
    ids.remove(item_id)
    ids.insert(new_position, item_id)
    # Move out of the constrained range first, then assign compact positions.
    db.execute(f"UPDATE {table} SET position=position+1000000 WHERE route_id=?", (route_id,))
    for position, row_id in enumerate(ids):
        db.execute(f"UPDATE {table} SET position=? WHERE id=? AND route_id=?", (position, row_id, route_id))
    return True


TRANSPORT_TO_MODE = {
    "步行": "walking", "地铁": "subway", "公交": "bus", "骑行": "cycling",
    "打车": "taxi", "自驾": "driving", "其他": "other",
}
MODE_TO_TRANSPORT = {value: key for key, value in TRANSPORT_TO_MODE.items()}


def reconcile_route_legs(db: sqlite3.Connection, route_id: str) -> None:
    """Keep exactly one leg per adjacent waypoint pair without changing GPS samples."""
    old_legs = [dict(row) for row in db.execute(
        "SELECT * FROM route_legs WHERE route_id=? ORDER BY order_index", (route_id,)
    ).fetchall()]
    old_by_pair = {(row["from_waypoint_id"], row["to_waypoint_id"]): row for row in old_legs}
    old_chain = []
    for leg in old_legs:
        if not old_chain:
            old_chain.append(leg["from_waypoint_id"])
        if old_chain[-1] == leg["from_waypoint_id"]:
            old_chain.append(leg["to_waypoint_id"])
    old_pair_by_gap = {}
    old_pos = {waypoint_id: index for index, waypoint_id in enumerate(old_chain)}
    for leg in old_legs:
        a, b = leg["from_waypoint_id"], leg["to_waypoint_id"]
        if a in old_pos and b in old_pos and old_pos[b] == old_pos[a] + 1:
            old_pair_by_gap[(a, b)] = leg

    waypoints = [row["id"] for row in db.execute(
        "SELECT id FROM route_waypoints WHERE route_id=? ORDER BY order_index,id", (route_id,)
    ).fetchall()]
    db.execute("DELETE FROM route_legs WHERE route_id=?", (route_id,))
    new_pos = {waypoint_id: index for index, waypoint_id in enumerate(waypoints)}
    inherited = {}
    for (a, b), old in old_pair_by_gap.items():
        if a in new_pos and b in new_pos and new_pos[b] == new_pos[a] + 2:
            middle = waypoints[new_pos[a] + 1]
            inherited[(a, middle)] = old
            inherited[(middle, b)] = old

    for index, (a, b) in enumerate(zip(waypoints, waypoints[1:])):
        old = old_by_pair.get((a, b))
        source = "manual"
        confirmed = 0
        mode = "other"
        duration = None
        notes = ""
        line_info = ""
        start_index = end_index = None
        if old:
            source = old["source"]
            confirmed = old["mode_confirmed"]
            mode = old["transport_mode"]
            duration = old["actual_duration_seconds"]
            notes = old["notes"]
            line_info = old["line_info"]
            start_index = old["track_start_index"]
            end_index = old["track_end_index"]
        elif (a, b) in inherited:
            old = inherited[(a, b)]
            source = "inherited"
            mode = old["transport_mode"]
            notes = "原路段拆分后继承交通方式，请确认此段。"
        db.execute(
            """INSERT INTO route_legs(id,route_id,from_waypoint_id,to_waypoint_id,order_index,
               transport_mode,mode_confirmed,actual_duration_seconds,notes,line_info,
               track_start_index,track_end_index,source,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uuid.uuid4().hex, route_id, a, b, index, mode, confirmed, duration, notes, line_info,
             start_index, end_index, source, now(), now()),
        )


def backfill_route_legs(db: sqlite3.Connection) -> None:
    route_ids = [row[0] for row in db.execute(
        "SELECT DISTINCT w.route_id FROM route_waypoints w "
        "LEFT JOIN route_legs l ON l.route_id=w.route_id WHERE l.id IS NULL"
    ).fetchall()]
    for route_id in route_ids:
        waypoints = [row[0] for row in db.execute(
            "SELECT id FROM route_waypoints WHERE route_id=? ORDER BY order_index,id", (route_id,)
        ).fetchall()]
        route = db.execute("SELECT is_demo FROM routes WHERE id=?", (route_id,)).fetchone()
        old_segments = db.execute(
            "SELECT mode FROM route_segments WHERE route_id=? ORDER BY position", (route_id,)
        ).fetchall()
        for index, (a, b) in enumerate(zip(waypoints, waypoints[1:])):
            mode = TRANSPORT_TO_MODE.get(old_segments[index]["mode"], "other") if route and route["is_demo"] and index < len(old_segments) else "other"
            confirmed = 1 if route and route["is_demo"] and index < len(old_segments) else 0
            db.execute(
                """INSERT OR IGNORE INTO route_legs(id,route_id,from_waypoint_id,to_waypoint_id,order_index,
                   transport_mode,mode_confirmed,source,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (uuid.uuid4().hex, route_id, a, b, index, mode, confirmed,
                 "demo" if route and route["is_demo"] else "manual", now(), now()),
            )


def backfill_route_versions(db: sqlite3.Connection) -> None:
    handler = object.__new__(CityTraceHandler)
    rows = db.execute(
        """SELECT r.*,u.nickname,
          (SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,
          (SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count
          FROM routes r JOIN users u ON u.id=r.user_id
          WHERE r.status IN ('published','pending_review','rejected')"""
    ).fetchall()
    for row in rows:
        if db.execute("SELECT 1 FROM route_versions WHERE route_id=? AND version=?", (row["id"], row["version"])).fetchone():
            continue
        snapshot = handler._route_view(row, db, None, summary=False, owner=False)
        db.execute(
            """INSERT INTO route_versions(id,route_id,version,status,snapshot_json,created_by,created_at,published_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (uuid.uuid4().hex, row["id"], row["version"], row["status"],
             json.dumps(snapshot, ensure_ascii=False), row["user_id"], row["updated_at"],
             row["published_at"] if row["status"] == "published" else None),
        )
    legacy_follows = db.execute(
        """SELECT f.id,f.route_id,f.route_version,f.waypoints_snapshot,f.legs_snapshot,f.geometry_segments_snapshot,
                  v.id version_id,v.snapshot_json
           FROM follow_sessions f LEFT JOIN route_versions v
             ON v.route_id=f.route_id AND v.version=f.route_version
           WHERE f.route_version_id IS NULL"""
    ).fetchall()
    for follow in legacy_follows:
        if not follow["version_id"]:
            continue
        snapshot = json.loads(follow["snapshot_json"])
        db.execute(
            """UPDATE follow_sessions SET route_version_id=?,
               waypoints_snapshot=CASE WHEN waypoints_snapshot='[]' THEN ? ELSE waypoints_snapshot END,
               legs_snapshot=CASE WHEN legs_snapshot='[]' THEN ? ELSE legs_snapshot END,
               geometry_segments_snapshot=CASE WHEN geometry_segments_snapshot='[]' THEN ? ELSE geometry_segments_snapshot END
               WHERE id=?""",
            (follow["version_id"], json.dumps(snapshot.get("waypoints", snapshot.get("checkpoints", []))),
             json.dumps(snapshot.get("legs", [])),
             json.dumps(snapshot.get("geometry_segments", [snapshot.get("geometry", [])])), follow["id"]),
        )


def route_version_conflict(route: sqlite3.Row, body: dict) -> bool | tuple[int, dict, dict]:
    supplied = body.get("expected_version", body.get("version"))
    if supplied is None:
        return False
    try:
        expected = int(supplied)
    except (TypeError, ValueError):
        return fail(422, "路线版本号无效", "validation_error")
    if expected != route["version"]:
        return fail(409, "路线已被其他操作更新，请刷新后再编辑", "version_conflict")
    return False


def touch_route(db: sqlite3.Connection, route_id: str) -> None:
    db.execute("UPDATE routes SET updated_at=?,version=version+1 WHERE id=?", (now(), route_id))


def clipped_path(points: list[dict], trim_m: float = 150) -> list[list[float]]:
    """Return a simplified public path with roughly 150m removed from both ends."""
    if len(points) < 3:
        return [[p["lon"], p["lat"]] for p in points]
    lengths = [haversine((a["lat"], a["lon"]), (b["lat"], b["lon"])) for a, b in zip(points, points[1:])]
    total = sum(lengths)
    if total <= trim_m * 2 + 20:
        mid = points[1:-1] or points
        return [[p["lon"], p["lat"]] for p in mid]

    def cut(distance: float) -> tuple[float, float]:
        walked = 0.0
        for idx, length in enumerate(lengths):
            if walked + length >= distance:
                ratio = (distance - walked) / max(length, 0.001)
                a, b = points[idx], points[idx + 1]
                return (a["lat"] + (b["lat"] - a["lat"]) * ratio,
                        a["lon"] + (b["lon"] - a["lon"]) * ratio)
            walked += length
        return points[-1]["lat"], points[-1]["lon"]

    start, end = cut(trim_m), cut(total - trim_m)
    middle = []
    walked = 0.0
    for idx, point in enumerate(points):
        if idx == 0:
            continue
        walked += lengths[idx - 1]
        if trim_m < walked < total - trim_m:
            middle.append([point["lon"], point["lat"]])
    return [[start[1], start[0]], *middle, [end[1], end[0]]]


def schema() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            db.executescript((ROOT / "migrations" / "001_initial.sql").read_text())
            db.execute("PRAGMA user_version=1")
            version = 1
        if version < 2:
            db.executescript((ROOT / "migrations" / "002_track_pause_intervals.sql").read_text())
            db.execute("PRAGMA user_version=2")
            version = 2
        if version < 3:
            db.executescript((ROOT / "migrations" / "003_v2_route_graph.sql").read_text())
            version = 3
        if APP_MODE == "demo":
            seed(db)
        else:
            email = os.environ.get("CITYTRACE_ADMIN_EMAIL", "").strip().lower()
            password = os.environ.get("CITYTRACE_ADMIN_PASSWORD", "")
            if bool(email) != bool(password):
                raise RuntimeError("real 模式下 CITYTRACE_ADMIN_EMAIL 与 CITYTRACE_ADMIN_PASSWORD 必须同时设置")
            has_admin = db.execute("SELECT 1 FROM users WHERE role='admin' AND active=1 LIMIT 1").fetchone()
            if not has_admin and not email:
                raise RuntimeError("real 模式首次启动需设置管理员邮箱和密码")
            if email and (not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(password) < 12):
                raise RuntimeError("管理员邮箱格式无效，初始密码至少需要 12 位")
            if email and not db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (uuid.uuid4().hex, "城迹管理员", email, pw_hash(password), "admin", 1, now()))
        backfill_route_legs(db)
        backfill_route_versions(db)


def seed(db: sqlite3.Connection) -> None:
    demo = db.execute("SELECT id FROM users WHERE email=?", ("author@citytrace.demo",)).fetchone()
    if demo:
        return
    author = uuid.uuid4().hex
    explorer = uuid.uuid4().hex
    admin = uuid.uuid4().hex
    db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (author, "城迹体验官", "author@citytrace.demo", pw_hash("trace123"), "user", 1, now()))
    db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (explorer, "沿途拾味", "explorer@citytrace.demo", pw_hash("trace123"), "user", 1, now()))
    db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (admin, "城迹管理员", "admin@citytrace.demo", pw_hash("admin123"), "admin", 1, now()))
    track = uuid.uuid4().hex
    route = uuid.uuid4().hex
    started = int(time.time() * 1000) - 5 * 3600 * 1000
    db.execute("INSERT INTO track_sessions(id,user_id,status,started_at,ended_at,active_seconds,paused_seconds,created_at,is_demo) VALUES(?,?,?,?,?,?,?,?,1)",
               (track, author, "finished", datetime.fromtimestamp(started / 1000, timezone.utc).isoformat(), now(), 16200, 0, now()))
    # Clearly marked demo samples; the map panel labels its coordinate sketch as illustrative.
    coords = [(26.0912,119.2965),(26.0915,119.2970),(26.0921,119.2981),(26.0932,119.2992),(26.0940,119.3005),(26.0950,119.3012),(26.0961,119.3023),(26.0973,119.3032),(26.0984,119.3044)]
    for i, (lat, lon) in enumerate(coords):
        db.execute("INSERT INTO track_points(id,track_id,client_id,lat,lon,accuracy,ts,created_at) VALUES(?,?,?,?,?,?,?,?)",
                   (uuid.uuid4().hex, track, f"demo-{i}", lat, lon, 8, started + i * 420_000, now()))
    samples = [{"lat": x, "lon": y, "accuracy": 8, "ts": started + i * 420_000} for i, (x, y) in enumerate(coords)]
    _, cleaned = path_stats(samples)
    route_path = [[p["lon"], p["lat"]] for p in cleaned]
    dist, _ = path_stats(samples)
    db.execute("""INSERT INTO routes(id,user_id,track_id,title,city,category,description,status,distance_m,elapsed_seconds,moving_seconds,public_geometry,created_at,updated_at,published_at,is_demo,version)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""", (route, author, track, "福州老城 · 巷弄与一碗鱼丸", "福州", "美食", "从三坊七巷出发，沿着老城街巷慢慢走。示例路线仅用于演示产品操作，坐标与照片均非真实推荐。", "published", int(dist), 16200, 2700, json.dumps(route_path), now(), now(), now(), 1))
    segments = [("步行", "三坊七巷", "安泰河", 0, 3600), ("公交", "安泰河", "上下杭", 3600, 9000), ("步行", "上下杭", "烟台山", 9000, 16200)]
    for idx, (mode, a, b, start, end) in enumerate(segments):
        db.execute("INSERT INTO route_segments(id,route_id,position,mode,start_label,end_label,start_offset,end_offset,source) VALUES(?,?,?,?,?,?,?,?,?)",
                   (uuid.uuid4().hex, route, idx, mode, a, b, start, end, "demo"))
    spots = [("三坊七巷", "景点", "从坊巷的青石板路开始，留一点时间慢慢逛。", 26.0918,119.2974),
             ("安泰河边", "休息", "沿河吹风，看看老城日常。", 26.0941,119.3000),
             ("上下杭街区", "美食", "示例打卡点。真实行程中可补充门面照片、推荐菜和花费。", 26.0967,119.3028)]
    for idx, (name, kind, note, lat, lon) in enumerate(spots):
        db.execute("INSERT INTO route_checkpoints(id,route_id,user_id,position,name,kind,note,lat,lon,location_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (uuid.uuid4().hex, route, author, idx, name, kind, note, lat, lon, "demo", now()))


def fail(status: int, message: str, code: str = "request_error") -> tuple[int, dict, dict]:
    return status, {"ok": False, "error": {"code": code, "message": message}}, {}


def ok(data=None, status=200, headers=None):
    return status, {"ok": True, "data": data}, headers or {}


class CityTraceHandler(BaseHTTPRequestHandler):
    server_version = "CityTrace/0.1"
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            raise ValueError("请求内容过大（最大 11 MB）")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def _session(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        token = cookie.get(COOKIE)
        if not token:
            return None
        with connect() as db:
            row = db.execute("SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at> ? AND u.active=1", (hashlib.sha256(token.value.encode()).hexdigest(), now())).fetchone()
            return dict(row) if row else None

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        params = parse_qs(parsed.query)
        method = self.command
        body = {}
        if method in ("POST", "PATCH", "PUT"):
            body = self._read_body()
            if not isinstance(body, dict):
                return fail(422, "请求需要 JSON 对象", "validation_error")
        user = self._session()
        if path.startswith(("/auth/", "/tracks", "/routes", "/waypoints", "/legs", "/users/", "/follow-sessions", "/admin/", "/photos/")):
            path = "/api" + path
        if path == "/api/users/me/favorites":
            path = "/api/me/favorites"
        waypoint_path = re.fullmatch(r"/api/routes/([a-f0-9]{32})/waypoints", path)
        if waypoint_path:
            path = f"/api/routes/{waypoint_path.group(1)}/checkpoints"
        waypoint_order_path = re.fullmatch(r"/api/routes/([a-f0-9]{32})/waypoints/order", path)
        if waypoint_order_path:
            path = f"/api/routes/{waypoint_order_path.group(1)}/waypoints/order"
        global_waypoint = re.fullmatch(r"/api/waypoints/([a-f0-9]{32})(/photos)?", path)
        if global_waypoint:
            waypoint_id = global_waypoint.group(1)
            with connect() as db:
                waypoint = db.execute("SELECT route_id FROM route_waypoints WHERE id=?", (waypoint_id,)).fetchone()
            if waypoint:
                route_id = waypoint["route_id"]
                if global_waypoint.group(2):
                    path = f"/api/routes/{route_id}/photos"
                    body["checkpoint_id"] = waypoint_id
                    body.setdefault("kind", "checkpoint")
                else:
                    path = f"/api/routes/{route_id}/checkpoints/{waypoint_id}"
        follow_arrival = re.fullmatch(r"/api/follow-sessions/([a-f0-9]{32})/waypoints/([a-f0-9]{32})/arrive", path)
        if follow_arrival:
            path = f"/api/follow-sessions/{follow_arrival.group(1)}/checkpoints"
            body["checkpoint_id"] = follow_arrival.group(2)
        for source, target in (("title", "name"), ("description", "note"), ("latitude", "lat"),
                               ("longitude", "lon"), ("position_source", "location_source"),
                               ("order_index", "position"), ("optional_spend", "spend")):
            if source in body and target not in body:
                body[target] = body[source]
        if "marker_type" in body and "kind" not in body:
            body["kind"] = body["marker_type"]
        if path == "/" and method == "GET":
            return self._file(ROOT / "static" / "index.html", "text/html; charset=utf-8")
        if path == "/sw.js" and method == "GET":
            return self._file(ROOT / "static" / "sw.js", "application/javascript; charset=utf-8")
        if path.startswith("/static/") and method == "GET":
            name = path.removeprefix("/static/")
            if "/" in name or name.startswith("."):
                return fail(404, "文件不存在", "not_found")
            f = ROOT / "static" / name
            return self._file(f, mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        if path == "/health" and method == "GET":
            with connect() as db: db.execute("SELECT 1").fetchone()
            return ok({"service": "citytrace", "database": "sqlite", "status": "ready"})
        if path == "/api/config" and method == "GET":
            return ok({"map_provider": "amap" if os.environ.get("AMAP_JS_KEY") else None,
                       "amap_key": os.environ.get("AMAP_JS_KEY", ""), "amap_security_code": os.environ.get("AMAP_SECURITY_CODE", ""),
                       "demo_mode": APP_MODE == "demo", "map_message": "高德地图服务未配置。轨迹坐标图会明确标注为非地图示意；配置合法 Key 后可显示地图底图。"})

        # Authentication
        if path == "/api/auth/register" and method == "POST":
            email, password = str(body.get("email", "")).strip().lower(), str(body.get("password", ""))
            nickname = str(body.get("nickname", "")).strip()[:40]
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(password) < 8 or not nickname:
                return fail(422, "请填写有效邮箱、昵称和至少 8 位密码", "validation_error")
            uid = uuid.uuid4().hex
            with connect() as db:
                try: db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (uid,nickname,email,pw_hash(password),"user",1,now()))
                except sqlite3.IntegrityError: return fail(409, "该邮箱已注册", "conflict")
            return self._login_user(uid)
        if path == "/api/auth/login" and method == "POST":
            email = str(body.get("email", "")).strip().lower()
            with connect() as db: row = db.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
            if not row or not check_password(str(body.get("password", "")), row["password_hash"]):
                return fail(401, "邮箱或密码不正确", "unauthorized")
            return self._login_user(row["id"])
        if path == "/api/auth/logout" and method == "POST":
            cookie = SimpleCookie(self.headers.get("Cookie", "")); token = cookie.get(COOKIE)
            if token:
                with connect() as db: db.execute("DELETE FROM auth_sessions WHERE token_hash=?", (hashlib.sha256(token.value.encode()).hexdigest(),))
            return ok({"logged_out": True}, headers={"Set-Cookie": f"{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})
        if path == "/api/auth/me" and method == "GET":
            if not user: return fail(401, "请先登录", "unauthorized")
            return ok(user_json(user))

        if path == "/api/auth/me" and method == "DELETE":
            if not user: return fail(401, "请先登录", "unauthorized")
            with connect() as db:
                db.execute("UPDATE users SET active=0 WHERE id=?", (user["id"],))
                db.execute("DELETE FROM auth_sessions WHERE user_id=?", (user["id"],))
                db.execute("UPDATE routes SET status='withdrawn',updated_at=?,version=version+1 WHERE user_id=? AND status IN ('draft','pending_review','published','rejected')", (now(), user["id"]))
            return ok({"deleted": True})

        if path == "/api/tracks" and method == "POST":
            if not user: return fail(401,"请登录后开始记录","unauthorized")
            tid = uuid.uuid4().hex
            idempotency_key = str(body.get("idempotency_key", "")).strip()
            if len(idempotency_key) > 100 or (idempotency_key and not re.fullmatch(r"[A-Za-z0-9._:-]+", idempotency_key)):
                return fail(422,"轨迹幂等键格式无效","validation_error")
            with connect() as db:
                if idempotency_key:
                    existing = db.execute("SELECT * FROM track_sessions WHERE user_id=? AND idempotency_key=?", (user["id"], idempotency_key)).fetchone()
                    if existing:
                        return ok(self._track_view(existing, True, db))
                active = db.execute("SELECT id FROM track_sessions WHERE user_id=? AND status IN ('recording','paused')", (user["id"],)).fetchone()
                if active: return fail(409, "你已有一条未结束的记录", "conflict")
                started_at = now()
                db.execute("INSERT INTO track_sessions(id,user_id,status,started_at,created_at,is_demo,idempotency_key) VALUES(?,?,?,?,?,0,?)", (tid,user["id"],"recording",started_at,started_at,idempotency_key or None))
            return ok({"id":tid,"status":"recording","started_at":started_at,"point_count":0,"distance_m":0,"points":[]},201)
        if path == "/api/tracks/active" and method == "GET":
            if not user: return fail(401,"请先登录","unauthorized")
            with connect() as db:
                row=db.execute("SELECT * FROM track_sessions WHERE user_id=? AND status IN ('recording','paused') ORDER BY created_at DESC LIMIT 1",(user["id"],)).fetchone()
            return ok(self._track_view(row, True) if row else None)
        match = re.fullmatch(r"/api/tracks/([a-f0-9]+)/?(points|pause|resume|finish)?", path)
        if match:
            tid, action = match.group(1), match.group(2)
            if not user: return fail(401,"请先登录","unauthorized")
            with connect() as db:
                track=db.execute("SELECT * FROM track_sessions WHERE id=?",(tid,)).fetchone()
                if not track: return fail(404,"记录不存在","not_found")
                if track["user_id"] != user["id"]: return fail(403,"无权访问这条私有轨迹","forbidden")
                if method == "GET" and action is None:
                    return ok(self._track_view(track, True, db))
                if method == "POST" and action == "points":
                    if track["status"] not in ("recording", "paused"): return fail(409,"记录已经结束，无法继续上传采样","conflict")
                    samples=body.get("samples",[])
                    if not isinstance(samples,list) or len(samples)>500: return fail(422,"采样批次无效（每次最多 500 个点）","validation_error")
                    inserted=0
                    for p in samples:
                        try:
                            lat,lon=float(p["lat"]),float(p["lon"]); accuracy=float(p.get("accuracy",0)); ts=int(p["ts"]); cid=str(p["client_id"])
                            if not (-90<=lat<=90 and -180<=lon<=180 and 0<=accuracy<=10000 and 0<len(cid)<=100): continue
                            started_ms=int(datetime.fromisoformat(track["started_at"]).timestamp()*1000)
                            if ts<started_ms-300_000 or ts>int(time.time()*1000)+60_000:continue
                            paused=db.execute("SELECT 1 FROM track_pause_intervals WHERE track_id=? AND paused_at_ms<=? AND (resumed_at_ms IS NULL OR resumed_at_ms>=?) LIMIT 1",(tid,ts,ts)).fetchone()
                            if paused:continue
                            cur=db.execute("INSERT OR IGNORE INTO track_points(id,track_id,client_id,lat,lon,accuracy,ts,created_at) VALUES(?,?,?,?,?,?,?,?)",(uuid.uuid4().hex,tid,cid,lat,lon,accuracy,ts,now()))
                            inserted += cur.rowcount
                        except (KeyError,ValueError,TypeError): continue
                    return ok({"inserted":inserted,"received":len(samples)})
                if method == "POST" and action in ("pause","resume","finish"):
                    status=track["status"]
                    if action=="pause":
                        if status!="recording": return fail(409,"只有记录中的轨迹可以暂停","conflict")
                        paused_ms=int(time.time()*1000)
                        paused_at=datetime.fromtimestamp(paused_ms/1000,timezone.utc).isoformat(timespec="milliseconds")
                        db.execute("UPDATE track_sessions SET status='paused',pause_started_at=? WHERE id=?",(paused_at,tid))
                        db.execute("INSERT INTO track_pause_intervals(id,track_id,paused_at_ms) VALUES(?,?,?)",(uuid.uuid4().hex,tid,paused_ms))
                    elif action=="resume":
                        if status!="paused": return fail(409,"当前记录未暂停","conflict")
                        resumed_ms=int(time.time()*1000)
                        pause_row=db.execute("SELECT paused_at_ms FROM track_pause_intervals WHERE track_id=? AND resumed_at_ms IS NULL ORDER BY paused_at_ms DESC LIMIT 1",(tid,)).fetchone()
                        paused=max(0,int((resumed_ms-pause_row["paused_at_ms"])/1000)) if pause_row else 0
                        db.execute("UPDATE track_pause_intervals SET resumed_at_ms=? WHERE track_id=? AND resumed_at_ms IS NULL",(resumed_ms,tid))
                        db.execute("UPDATE track_sessions SET status='recording',paused_seconds=paused_seconds+?,pause_started_at=NULL WHERE id=?",(paused,tid))
                    else:
                        if status not in ("recording","paused"): return fail(409,"记录已经结束","conflict")
                        paused=track["paused_seconds"] or 0
                        if status=="paused" and track["pause_started_at"]:
                            ended_ms=int(time.time()*1000)
                            pause_row=db.execute("SELECT paused_at_ms FROM track_pause_intervals WHERE track_id=? AND resumed_at_ms IS NULL ORDER BY paused_at_ms DESC LIMIT 1",(tid,)).fetchone()
                            if pause_row:paused += max(0,int((ended_ms-pause_row["paused_at_ms"])/1000))
                            db.execute("UPDATE track_pause_intervals SET resumed_at_ms=? WHERE track_id=? AND resumed_at_ms IS NULL",(ended_ms,tid))
                        ended=datetime.now(timezone.utc)
                        started=datetime.fromisoformat(track["started_at"])
                        elapsed=max(0,int((ended-started).total_seconds())-paused)
                        db.execute("UPDATE track_sessions SET status='finished',ended_at=?,active_seconds=?,paused_seconds=?,pause_started_at=NULL WHERE id=?",(ended.isoformat(),elapsed,paused,tid))
                    fresh=db.execute("SELECT * FROM track_sessions WHERE id=?",(tid,)).fetchone()
                    return ok(self._track_view(fresh,True,db))
            return fail(405,"不支持的轨迹操作","method_not_allowed")

        waypoint_order_match = re.fullmatch(r"/api/routes/([a-f0-9]{32})/waypoints/order", path)
        if waypoint_order_match and method == "PATCH":
            route_id = waypoint_order_match.group(1)
            if not user:
                return fail(401, "请登录后调整标记点顺序", "unauthorized")
            with connect() as db:
                route = db.execute("SELECT * FROM routes WHERE id=?", (route_id,)).fetchone()
                if not route:
                    return fail(404, "路线不存在", "not_found")
                if route["user_id"] != user["id"]:
                    return fail(403, "只有作者可以调整标记点顺序", "forbidden")
                if route["status"] not in ("draft", "rejected"):
                    return fail(409, "当前状态不能编辑标记点", "conflict")
                conflict = route_version_conflict(route, body)
                if conflict:
                    return conflict
                ids = body.get("waypoint_ids")
                existing = [row[0] for row in db.execute(
                    "SELECT id FROM route_waypoints WHERE route_id=? ORDER BY order_index,id", (route_id,)
                ).fetchall()]
                if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids) or len(ids) != len(set(ids)) or set(ids) != set(existing):
                    return fail(422, "顺序列表必须包含此路线全部标记点且不能重复", "validation_error")
                db.execute("UPDATE route_checkpoints SET position=position+1000000 WHERE route_id=?", (route_id,))
                for index, waypoint_id in enumerate(ids):
                    db.execute("UPDATE route_checkpoints SET position=? WHERE id=? AND route_id=?", (index, waypoint_id, route_id))
                reconcile_route_legs(db, route_id)
                touch_route(db, route_id)
                return ok({"waypoint_ids": ids, "version": route["version"] + 1,
                           "legs": [dict(row) for row in db.execute("SELECT * FROM route_legs WHERE route_id=? ORDER BY order_index", (route_id,)).fetchall()]})

        legs_route_match = re.fullmatch(r"/api/routes/([a-f0-9]{32})/legs", path)
        if legs_route_match and method == "GET":
            route_id = legs_route_match.group(1)
            with connect() as db:
                route = db.execute("SELECT * FROM routes WHERE id=?", (route_id,)).fetchone()
                owner = bool(user and route and user["id"] == route["user_id"])
                if not route or (route["status"] != "published" and not owner and not (user and user["role"] == "admin")):
                    return fail(404, "路线不存在", "not_found")
                return ok(self._legs_view(db, route_id))

        leg_match = re.fullmatch(r"/api/legs/([a-f0-9]{32})", path)
        if leg_match and method == "PATCH":
            if not user:
                return fail(401, "请登录后编辑交通路段", "unauthorized")
            with connect() as db:
                leg = db.execute("SELECT * FROM route_legs WHERE id=?", (leg_match.group(1),)).fetchone()
                if not leg:
                    return fail(404, "交通路段不存在", "not_found")
                route = db.execute("SELECT * FROM routes WHERE id=?", (leg["route_id"],)).fetchone()
                if route["user_id"] != user["id"]:
                    return fail(403, "只有路线作者可以编辑交通路段", "forbidden")
                if route["status"] not in ("draft", "rejected"):
                    return fail(409, "当前状态不能编辑交通路段", "conflict")
                conflict = route_version_conflict(route, body)
                if conflict:
                    return conflict
                mode = str(body.get("transport_mode", body.get("mode", leg["transport_mode"])))
                if mode in TRANSPORT_TO_MODE:
                    mode = TRANSPORT_TO_MODE[mode]
                allowed_modes = set(MODE_TO_TRANSPORT)
                try:
                    duration = body.get("actual_duration_seconds", leg["actual_duration_seconds"])
                    duration = None if duration in (None, "") else int(duration)
                except (TypeError, ValueError):
                    return fail(422, "路段实际耗时无效", "validation_error")
                if mode not in allowed_modes or (duration is not None and duration < 0):
                    return fail(422, "交通方式或实际耗时无效", "validation_error")
                db.execute("UPDATE route_legs SET transport_mode=?,mode_confirmed=1,actual_duration_seconds=?,notes=?,line_info=?,updated_at=? WHERE id=?",
                           (mode,duration,str(body.get("notes",leg["notes"]))[:1000],str(body.get("line_info",leg["line_info"]))[:300],now(),leg["id"]))
                touch_route(db, route["id"])
                return ok(next((item for item in self._legs_view(db, route["id"]) if item["id"] == leg["id"]), None))

        # Route discovery and CRUD
        if path == "/api/routes" and method == "GET":
            q=str(params.get("q",[""])[0])[:100]; city=str(params.get("city",[""])[0])[:80]; category=str(params.get("category",[""])[0])[:40]
            try: page=max(1,int(params.get("page",[1])[0])); size=min(30,max(1,int(params.get("page_size",[12])[0])))
            except ValueError: page,size=1,12
            where=["r.status='published'"]; args=[]
            if q: where.append("(r.title LIKE ? OR r.description LIKE ? OR r.city LIKE ?)"); args.extend([f"%{q}%"]*3)
            if city: where.append("r.city LIKE ?"); args.append(f"%{city}%")
            if category: where.append("r.category=?"); args.append(category)
            try:
                minimum=int(params.get("min_duration",[0])[0]); maximum=int(params.get("max_duration",[10**9])[0])
                where.append("r.elapsed_seconds BETWEEN ? AND ?"); args.extend([minimum,maximum])
            except ValueError: pass
            bbox_values=parse_qs(parsed.query,keep_blank_values=True).get("bbox")
            bounds=None
            if bbox_values is not None:
                try:
                    if len(bbox_values)!=1:raise ValueError
                    west,south,east,north=map(float,bbox_values[0].split(','))
                    if not all(math.isfinite(value) for value in (west,south,east,north)):raise ValueError
                    if not (-180<=west<=east<=180 and -90<=south<=north<=90):raise ValueError
                    bounds=(west,south,east,north)
                except ValueError:
                    return fail(422,"地图范围无效，请提供 west,south,east,north 四个有效经纬度","validation_error")
            with connect() as db:
                query=f"SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM routes r JOIN users u ON u.id=r.user_id WHERE {' AND '.join(where)} ORDER BY r.published_at DESC,r.id ASC"
                offset=(page-1)*size
                if bounds is not None:
                    # Apply the geographic filter before deriving either pages or totals.
                    west,south,east,north=bounds
                    candidates=db.execute(query,args).fetchall()
                    matching=[r for r in candidates if any(west<=p[0]<=east and south<=p[1]<=north for p in json.loads(r["public_geometry"] or "[]"))]
                    count=len(matching)
                    rows=matching[offset:offset+size]
                else:
                    rows=db.execute(query+" LIMIT ? OFFSET ?",(*args,size,offset)).fetchall()
                    count=db.execute(f"SELECT COUNT(*) FROM routes r WHERE {' AND '.join(where)}",args).fetchone()[0]
                result=[self._route_view(r,db,user,summary=True) for r in rows]
            return ok({"items":result,"page":page,"page_size":size,"total":count})
        if path == "/api/routes" and method == "POST":
            if not user: return fail(401,"请登录后保存路线","unauthorized")
            tid=body.get("track_id")
            if not isinstance(tid,str) or not re.fullmatch(r"[a-f0-9]{32}",tid):return fail(422,"路线必须关联一条本人已结束的真实 GPS 记录","validation_error")
            with connect() as db:
                track=db.execute("SELECT * FROM track_sessions WHERE id=? AND user_id=? AND status='finished'",(tid,user["id"])).fetchone() if tid else None
                if tid and not track: return fail(404,"已结束的本人轨迹不存在","not_found")
                if tid:
                    existing=db.execute("SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM routes r JOIN users u ON u.id=r.user_id WHERE r.track_id=? AND r.user_id=?",(tid,user["id"])).fetchone()
                    if existing:return ok(self._route_view(existing,db,user,summary=False,owner=True))
                rid=uuid.uuid4().hex
                title=str(body.get("title",""))[:100].strip() or "未命名城市路线"
                elapsed=track["active_seconds"] or 0 if track else 0
                rawpts=[]
                pause_intervals=[]
                if track:
                    rawpts=[dict(x) for x in db.execute("SELECT lat,lon,accuracy,ts FROM track_points WHERE track_id=? ORDER BY ts,id",(track["id"],)).fetchall()]
                    pause_intervals=[(int(p["paused_at_ms"]),int(p["resumed_at_ms"]) if p["resumed_at_ms"] is not None else None)
                                     for p in db.execute("SELECT paused_at_ms,resumed_at_ms FROM track_pause_intervals WHERE track_id=? ORDER BY paused_at_ms",(track["id"],)).fetchall()]
                distance,cleaned_paths=track_geometry_stats(rawpts,pause_intervals)
                moving=moving_time_seconds(rawpts,pause_intervals)
                cleaned=[point for path in cleaned_paths for point in path]
                db.execute("INSERT INTO routes(id,user_id,track_id,title,city,category,description,status,distance_m,elapsed_seconds,moving_seconds,public_geometry,created_at,updated_at,is_demo,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)",
                           (rid,user["id"],tid,title,str(body.get("city",""))[:80],"其他","","draft",int(distance),elapsed,moving,json.dumps([[p["lon"],p["lat"]] for p in cleaned]),now(),now()))
                route=db.execute("SELECT * FROM routes WHERE id=?",(rid,)).fetchone()
                return ok(self._route_view(route,db,user),201)
        rmatch=re.fullmatch(r"/api/routes/([a-f0-9]+)(?:/(segments|checkpoints|photos|submit|withdraw|favorite|report)(?:/([a-f0-9]+))?)?",path)
        if rmatch:
            rid,action,subid=rmatch.group(1),rmatch.group(2),rmatch.group(3)
            with connect() as db:
                route=db.execute("SELECT * FROM routes WHERE id=?",(rid,)).fetchone()
                if not route or route["status"] in ("withdrawn","unpublished") and (not user or user["id"]!=route["user_id"] and user["role"]!="admin"):
                    return fail(404,"路线不存在或已撤回","not_found")
                owner=bool(user and user["id"]==route["user_id"])
                public=route["status"]=="published"
                if owner and ("version" in body or "expected_version" in body):
                    conflict = route_version_conflict(route, body)
                    if conflict:
                        return conflict
                if method=="GET" and action is None:
                    if not public and not owner and not (user and user["role"]=="admin"): return fail(404,"路线不存在","not_found")
                    return ok(self._route_view(route,db,user,summary=False,owner=owner))
                if method=="PATCH" and action is None:
                    if not owner: return fail(403,"只有路线作者可以编辑","forbidden")
                    if route["status"] not in ("draft","rejected"): return fail(409,"此状态下不能编辑路线","conflict")
                    allowed={"title":"title","city":"city","category":"category","description":"description"}
                    updates={key:str(body[key])[:limit] for key,limit in (("title",100),("city",80),("category",40),("description",3000)) if key in body}
                    if not str(body.get("title",route["title"])).strip(): return fail(422,"路线名称不能为空","validation_error")
                    if updates:
                        updates["updated_at"]=now(); updates["version"]=route["version"]+1
                        db.execute("UPDATE routes SET "+",".join(f"{k}=?" for k in updates)+" WHERE id=?",(*updates.values(),rid))
                    fresh=db.execute("SELECT * FROM routes WHERE id=?",(rid,)).fetchone()
                    return ok(self._route_view(fresh,db,user,False,True))
                if action=="segments" and method=="POST":
                    if not owner:return fail(403,"只有路线作者可以编辑路段","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"请先撤回待审核路线再编辑","conflict")
                    mode=str(body.get("mode","")); allowed_modes={"步行","地铁","公交","骑行","打车","自驾","其他"}
                    if mode not in allowed_modes:return fail(422,"交通方式无效","validation_error")
                    try: pos=int(body.get("position",db.execute("SELECT COUNT(*) FROM route_segments WHERE route_id=?",(rid,)).fetchone()[0])); start=int(body.get("start_offset",0)); end=int(body.get("end_offset",start))
                    except (ValueError,TypeError):return fail(422,"路段顺序或时间无效","validation_error")
                    count=db.execute("SELECT COUNT(*) FROM route_segments WHERE route_id=?",(rid,)).fetchone()[0]
                    if pos<0 or pos>count or start<0 or end<start or end>route["elapsed_seconds"]:return fail(422,"路段顺序或时间超出实际行程范围","validation_error")
                    existing=db.execute("SELECT position,start_offset,end_offset FROM route_segments WHERE route_id=? ORDER BY position",(rid,)).fetchall()
                    previous=next((x for x in existing if x["position"]==pos-1),None)
                    following=next((x for x in existing if x["position"]==pos),None)
                    if previous and start<previous["end_offset"]:return fail(422,"路段开始时间早于上一段结束时间","validation_error")
                    if following and end>following["start_offset"]:return fail(422,"路段结束时间晚于下一段开始时间","validation_error")
                    sid=uuid.uuid4().hex
                    db.execute("UPDATE route_segments SET position=position+1000 WHERE route_id=? AND position>=?",(rid,pos))
                    db.execute("INSERT INTO route_segments(id,route_id,position,mode,start_label,end_label,start_offset,end_offset,source) VALUES(?,?,?,?,?,?,?,?,?)",(sid,rid,pos,mode,str(body.get("start_label",""))[:100],str(body.get("end_label",""))[:100],start,end,"manual"))
                    db.execute("UPDATE route_segments SET position=position-999 WHERE route_id=? AND position>=1000",(rid,))
                    touch_route(db,rid)
                    return ok({"id":sid,"position":pos,"mode":mode},201)
                if action=="segments" and subid and method=="PATCH":
                    if not owner:return fail(403,"只有路线作者可以编辑路段","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能编辑路段","conflict")
                    current=db.execute("SELECT * FROM route_segments WHERE id=? AND route_id=?",(subid,rid)).fetchone()
                    if not current:return fail(404,"交通路段不存在","not_found")
                    mode=str(body.get("mode",current["mode"])); allowed_modes={"步行","地铁","公交","骑行","打车","自驾","其他"}
                    try:start=int(body.get("start_offset",current["start_offset"]));end=int(body.get("end_offset",current["end_offset"]));position=int(body.get("position",current["position"]))
                    except (ValueError,TypeError):return fail(422,"路段时间无效","validation_error")
                    count=db.execute("SELECT COUNT(*) FROM route_segments WHERE route_id=?",(rid,)).fetchone()[0]
                    if mode not in allowed_modes or position<0 or position>=count or start<0 or end<start or end>route["elapsed_seconds"]:return fail(422,"路段方式、顺序或时间无效","validation_error")
                    siblings=[dict(x) for x in db.execute("SELECT id,position,start_offset,end_offset FROM route_segments WHERE route_id=? AND id<>? ORDER BY position",(rid,subid)).fetchall()]
                    order=siblings.copy();order.insert(position,{"id":subid,"position":position,"start_offset":start,"end_offset":end})
                    previous=order[position-1] if position>0 else None
                    following=order[position+1] if position+1<len(order) else None
                    if previous and start<previous["end_offset"]:return fail(422,"路段开始时间早于上一段结束时间","validation_error")
                    if following and end>following["start_offset"]:return fail(422,"路段结束时间晚于下一段开始时间","validation_error")
                    if not reorder_positions(db,"route_segments",rid,subid,position):return fail(422,"路段顺序无效","validation_error")
                    db.execute("UPDATE route_segments SET mode=?,start_label=?,end_label=?,start_offset=?,end_offset=?,source='manual' WHERE id=?",(mode,str(body.get("start_label",current["start_label"]))[:100],str(body.get("end_label",current["end_label"]))[:100],start,end,subid))
                    touch_route(db,rid)
                    return ok({"id":subid,"position":position,"mode":mode})
                if action=="segments" and subid and method=="DELETE":
                    if not owner:return fail(403,"只有路线作者可以编辑路段","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能编辑路段","conflict")
                    old=db.execute("SELECT position FROM route_segments WHERE id=? AND route_id=?",(subid,rid)).fetchone()
                    if old:
                        db.execute("DELETE FROM route_segments WHERE id=? AND route_id=?",(subid,rid))
                        db.execute("UPDATE route_segments SET position=position+1000000 WHERE route_id=?",(rid,))
                        rows=db.execute("SELECT id FROM route_segments WHERE route_id=? ORDER BY position",(rid,)).fetchall()
                        for position,row in enumerate(rows):db.execute("UPDATE route_segments SET position=? WHERE id=?",(position,row["id"]))
                        touch_route(db,rid)
                    return ok({"deleted":True})
                if action=="checkpoints" and method=="POST":
                    if not owner:return fail(403,"只有路线作者可以添加打卡点","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能编辑打卡点","conflict")
                    name=str(body.get("name",""))[:120].strip(); marker_type=str(body.get("marker_type",body.get("kind","其他")))
                    allowed={"美食","景点","摄影","地铁站","公交站","休息点","其他","购物","休息"}
                    kind=marker_type if marker_type in {"美食","景点","摄影","休息","购物","其他"} else ("休息" if marker_type=="休息点" else "其他")
                    try: lat=float(body["lat"]); lon=float(body["lon"]); pos=int(body.get("position",db.execute("SELECT COUNT(*) FROM route_checkpoints WHERE route_id=?",(rid,)).fetchone()[0]))
                    except (KeyError,ValueError,TypeError):return fail(422,"请提供有效打卡名称和经纬度","validation_error")
                    count=db.execute("SELECT COUNT(*) FROM route_checkpoints WHERE route_id=?",(rid,)).fetchone()[0]
                    source=str(body.get("location_source","manual")); coordinate_system=str(body.get("coordinate_system","WGS84"))
                    if not name or not -90<=lat<=90 or not -180<=lon<=180 or marker_type not in allowed or source not in {"live","track","manual"} or coordinate_system not in {"WGS84","GCJ-02"} or pos<0 or pos>count:return fail(422,"标记点字段无效","validation_error")
                    seg_id=body.get("segment_id")
                    if seg_id and not db.execute("SELECT 1 FROM route_segments WHERE id=? AND route_id=?",(seg_id,rid)).fetchone():return fail(422,"打卡点关联的路段不属于此路线","validation_error")
                    try: spend=int(body.get("spend",0) or 0); stay=int(body.get("stay_minutes",0) or 0)
                    except (ValueError,TypeError):return fail(422,"消费金额或停留时间无效","validation_error")
                    if spend<0 or stay<0:return fail(422,"消费金额或停留时间不能为负数","validation_error")
                    cid=uuid.uuid4().hex
                    db.execute("INSERT INTO route_checkpoints(id,route_id,user_id,position,name,kind,note,recommended,spend,stay_minutes,lat,lon,segment_id,location_source,created_at,marker_type,coordinate_system) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(cid,rid,user["id"],pos,name,kind,str(body.get("note",""))[:1200],str(body.get("recommended",""))[:300],spend,stay,lat,lon,seg_id,source,now(),marker_type,coordinate_system))
                    reconcile_route_legs(db,rid)
                    touch_route(db,rid)
                    return ok({"id":cid,"name":name,"title":name,"position":pos,"order_index":pos,"marker_type":marker_type,"version":route["version"]+1},201)
                if action=="checkpoints" and subid and method=="PATCH":
                    if not owner:return fail(403,"只有路线作者可以编辑打卡点","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能编辑打卡点","conflict")
                    current=db.execute("SELECT * FROM route_checkpoints WHERE id=? AND route_id=?",(subid,rid)).fetchone()
                    if not current:return fail(404,"打卡点不存在","not_found")
                    name=str(body.get("name",current["name"]))[:120].strip(); marker_type=str(body.get("marker_type",body.get("kind",current["marker_type"])))
                    kind=marker_type if marker_type in {"美食","景点","摄影","休息","购物","其他"} else ("休息" if marker_type=="休息点" else "其他")
                    source=str(body.get("location_source",current["location_source"])); coordinate_system=str(body.get("coordinate_system",current["coordinate_system"]))
                    try:lat=float(body.get("lat",current["lat"]));lon=float(body.get("lon",current["lon"]));spend=int(body.get("spend",current["spend"]));stay=int(body.get("stay_minutes",current["stay_minutes"]));position=int(body.get("position",current["position"]))
                    except (ValueError,TypeError):return fail(422,"打卡点字段无效","validation_error")
                    count=db.execute("SELECT COUNT(*) FROM route_checkpoints WHERE route_id=?",(rid,)).fetchone()[0]
                    if not name or marker_type not in {"美食","景点","摄影","地铁站","公交站","休息点","其他","购物","休息"} or source not in {"live","track","manual"} or coordinate_system not in {"WGS84","GCJ-02"} or not -90<=lat<=90 or not -180<=lon<=180 or spend<0 or stay<0 or position<0 or position>=count:return fail(422,"标记点字段无效","validation_error")
                    seg_id=body.get("segment_id",current["segment_id"])
                    if seg_id and not db.execute("SELECT 1 FROM route_segments WHERE id=? AND route_id=?",(seg_id,rid)).fetchone():return fail(422,"关联路段不属于此路线","validation_error")
                    if not reorder_positions(db,"route_checkpoints",rid,subid,position):return fail(422,"打卡点顺序无效","validation_error")
                    db.execute("UPDATE route_checkpoints SET name=?,kind=?,note=?,recommended=?,spend=?,stay_minutes=?,lat=?,lon=?,segment_id=?,location_source=?,marker_type=?,coordinate_system=? WHERE id=?",(name,kind,str(body.get("note",current["note"]))[:1200],str(body.get("recommended",current["recommended"]))[:300],spend,stay,lat,lon,seg_id,source,marker_type,coordinate_system,subid))
                    reconcile_route_legs(db,rid)
                    touch_route(db,rid)
                    return ok({"id":subid,"position":position,"order_index":position,"name":name,"title":name,"marker_type":marker_type,"version":route["version"]+1})
                if action=="checkpoints" and subid and method=="DELETE":
                    if not owner:return fail(403,"只有路线作者可以编辑打卡点","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能编辑打卡点","conflict")
                    old=db.execute("SELECT position FROM route_checkpoints WHERE id=? AND route_id=?",(subid,rid)).fetchone()
                    if old:
                        db.execute("DELETE FROM route_checkpoints WHERE id=? AND route_id=?",(subid,rid))
                        db.execute("UPDATE route_checkpoints SET position=position+1000000 WHERE route_id=?",(rid,))
                        rows=db.execute("SELECT id FROM route_checkpoints WHERE route_id=? ORDER BY position",(rid,)).fetchall()
                        for position,row in enumerate(rows):db.execute("UPDATE route_checkpoints SET position=? WHERE id=?",(position,row["id"]))
                        reconcile_route_legs(db,rid)
                        touch_route(db,rid)
                    return ok({"deleted":True})
                if action=="photos" and method=="POST":
                    if not owner:return fail(403,"只有路线作者可以上传照片","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"当前状态不能上传照片","conflict")
                    result=self._save_photo(db,user,rid,body)
                    if result[0] < 300 and not result[1].get("data",{}).get("reused"):
                        touch_route(db,rid)
                    return result
                if action=="submit" and method=="POST":
                    if not owner:return fail(403,"只有路线作者可以提交","forbidden")
                    if route["status"] not in ("draft","rejected"):return fail(409,"路线已经提交或公开","conflict")
                    if not route["title"].strip():return fail(422,"请先填写路线标题","validation_error")
                    if not route["track_id"]:return fail(422,"路线必须来自一条真实 GPS 记录","validation_error")
                    if route["is_demo"]:return fail(422,"演示路线不能作为真实路线发布","demo_route_not_publishable")
                    if body.get("privacy_confirmed") is not True:
                        return fail(422,"发布前请明确确认路线、标记点和照片的公开范围","privacy_confirmation_required")
                    waypoint_count=db.execute("SELECT COUNT(*) FROM route_waypoints WHERE route_id=?",(rid,)).fetchone()[0]
                    if waypoint_count<2:return fail(422,"公开路线至少需要两个按顺序排列的标记点","validation_error")
                    missing_photos=db.execute("SELECT COUNT(*) FROM route_waypoints w WHERE w.route_id=? AND NOT EXISTS (SELECT 1 FROM waypoint_photos p WHERE p.waypoint_id=w.id)",(rid,)).fetchone()[0]
                    if missing_photos:return fail(422,"每个标记点至少上传一张现场照片后才能提交","waypoint_photo_required")
                    legs=db.execute("SELECT COUNT(*) total,SUM(mode_confirmed) confirmed FROM route_legs WHERE route_id=?",(rid,)).fetchone()
                    if legs["total"]!=waypoint_count-1 or (legs["confirmed"] or 0)!=waypoint_count-1:
                        return fail(422,"请为每两个相邻标记点确认交通方式","route_legs_incomplete")
                    if route["track_id"]:
                        rawpts=[dict(x) for x in db.execute("SELECT lat,lon,accuracy,ts FROM track_points WHERE track_id=? ORDER BY ts,id",(route["track_id"],)).fetchall()]
                        pause_intervals=[(int(p["paused_at_ms"]),int(p["resumed_at_ms"]) if p["resumed_at_ms"] is not None else None)
                                         for p in db.execute("SELECT paused_at_ms,resumed_at_ms FROM track_pause_intervals WHERE track_id=? ORDER BY paused_at_ms",(route["track_id"],)).fetchall()]
                        _,cleaned_paths=track_geometry_stats(rawpts,pause_intervals)
                        geometry_segments=clipped_paths(cleaned_paths)
                        if not geometry_segments:return fail(422,"隐私裁剪后有效轨迹不足，至少需要一段可公开路线","validation_error")
                        geometry=[point for path in geometry_segments for point in path]
                        db.execute("UPDATE routes SET public_geometry=?,public_geometry_segments=? WHERE id=?",(json.dumps(geometry),json.dumps(geometry_segments),rid))
                    db.execute("UPDATE routes SET status='pending_review',updated_at=?,version=version+1 WHERE id=?",(now(),rid))
                    fresh=db.execute("SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM routes r JOIN users u ON u.id=r.user_id WHERE r.id=?",(rid,)).fetchone()
                    snapshot=self._route_view(fresh,db,user,summary=False,owner=False)
                    db.execute("INSERT INTO route_versions(id,route_id,version,status,snapshot_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)",(uuid.uuid4().hex,rid,fresh["version"],"pending_review",json.dumps(snapshot,ensure_ascii=False),user["id"],now()))
                    db.execute("INSERT INTO moderation_logs(id,route_id,admin_id,action,note,created_at) VALUES(?,?,?,?,?,?)",(uuid.uuid4().hex,rid,None,"submitted","路线提交审核",now()))
                    return ok({"id":rid,"status":"pending_review","version":fresh["version"]})
                if action=="withdraw" and method=="POST":
                    if not owner:return fail(403,"只有作者可以撤回","forbidden")
                    if route["status"] not in ("published","pending_review","rejected"):return fail(409,"当前状态不能撤回","conflict")
                    db.execute("UPDATE routes SET status='withdrawn',updated_at=?,version=version+1 WHERE id=?",(now(),rid))
                    db.execute("UPDATE route_versions SET access_revoked_at=? WHERE route_id=? AND status='published' AND access_revoked_at IS NULL",(now(),rid))
                    db.execute("INSERT INTO moderation_logs(id,route_id,admin_id,action,note,created_at) VALUES(?,?,?,?,?,?)",(uuid.uuid4().hex,rid,None,"withdrawn","作者撤回路线",now()))
                    return ok({"id":rid,"status":"withdrawn"})
                if action=="favorite" and method=="POST":
                    if not user:return fail(401,"登录后收藏路线","unauthorized")
                    if not public:return fail(404,"路线当前不可收藏","not_found")
                    db.execute("INSERT OR IGNORE INTO route_favorites(id,user_id,route_id,created_at,route_version) VALUES(?,?,?,?,?)",(uuid.uuid4().hex,user["id"],rid,now(),route["version"]))
                    return ok({"favorite":True})
                if action=="favorite" and method=="DELETE":
                    if not user:return fail(401,"请先登录","unauthorized")
                    db.execute("DELETE FROM route_favorites WHERE user_id=? AND route_id=?",(user["id"],rid))
                    return ok({"favorite":False})
                if action=="report" and method=="POST":
                    if not user:return fail(401,"请登录后举报","unauthorized")
                    if not public:return fail(404,"仅可举报公开路线","not_found")
                    reason=str(body.get("reason","其他"))[:40]; note=str(body.get("note",""))[:1000]
                    if reason not in {"不实信息","隐私风险","危险路线","侵权内容","其他"}:return fail(422,"举报类型无效","validation_error")
                    db.execute("INSERT INTO route_reports(id,route_id,user_id,reason,note,status,created_at) VALUES(?,?,?,?,?,'open',?)",(uuid.uuid4().hex,rid,user["id"],reason,note,now()))
                    return ok({"reported":True},201)

        if path == "/api/me/routes" and method == "GET":
            if not user:return fail(401,"请先登录","unauthorized")
            with connect() as db:
                rows=db.execute("SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM routes r JOIN users u ON u.id=r.user_id WHERE r.user_id=? ORDER BY r.updated_at DESC",(user["id"],)).fetchall()
                return ok([self._route_view(r,db,user,summary=True,owner=True) for r in rows])
        if path == "/api/me/favorites" and method == "GET":
            if not user:return fail(401,"请先登录","unauthorized")
            with connect() as db:
                rows=db.execute("SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM route_favorites f JOIN routes r ON r.id=f.route_id JOIN users u ON u.id=r.user_id WHERE f.user_id=? AND r.status='published' ORDER BY f.created_at DESC",(user["id"],)).fetchall()
                return ok([self._route_view(r,db,user,summary=True) for r in rows])

        # Independent follow sessions snapshot route version and public geometry.
        if path == "/api/me/follows" and method == "GET":
            if not user:return fail(401,"请先登录","unauthorized")
            with connect() as db:
                rows=db.execute("SELECT * FROM follow_sessions WHERE user_id=? ORDER BY created_at DESC",(user["id"],)).fetchall()
                return ok([self._follow_view(r,db) for r in rows])
        if re.fullmatch(r"/api/routes/[a-f0-9]+/follow",path) and method=="POST":
            if not user:return fail(401,"登录后开始复刻","unauthorized")
            rid=path.split("/")[3]
            with connect() as db:
                route=db.execute("SELECT * FROM routes WHERE id=? AND status='published'",(rid,)).fetchone()
                if not route:return fail(404,"路线当前不可复刻","not_found")
                version_row=db.execute("SELECT * FROM route_versions WHERE route_id=? AND status='published' AND access_revoked_at IS NULL ORDER BY version DESC LIMIT 1",(rid,)).fetchone()
                if not version_row:return fail(409,"路线公开版本暂不可用，请联系管理员重新审核","version_unavailable")
                snap=json.loads(version_row["snapshot_json"])
                checkpoints=snap.get("checkpoints",snap.get("waypoints",[]))
                waypoints=snap.get("waypoints",checkpoints)
                legs=snap.get("legs",[])
                fid=uuid.uuid4().hex
                db.execute("""INSERT INTO follow_sessions(id,user_id,route_id,route_version,route_version_id,title_snapshot,
                    geometry_snapshot,geometry_segments_snapshot,segments_snapshot,checkpoints_snapshot,waypoints_snapshot,legs_snapshot,status,started_at,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",(fid,user["id"],rid,version_row["version"],version_row["id"],route["title"],
                    json.dumps(snap.get("geometry",[])),json.dumps(snap.get("geometry_segments",[snap.get("geometry",[])])),
                    json.dumps(snap.get("segments",[])),json.dumps(checkpoints),json.dumps(waypoints),json.dumps(legs),"active",now(),now()))
                row=db.execute("SELECT * FROM follow_sessions WHERE id=?",(fid,)).fetchone()
                return ok(self._follow_view(row,db),201)
        fmatch=re.fullmatch(r"/api/follow-sessions/([a-f0-9]+)(?:/(checkpoints|points|pause|resume|finish))?",path)
        if fmatch:
            fid,action=fmatch.group(1),fmatch.group(2)
            if not user:return fail(401,"请先登录","unauthorized")
            with connect() as db:
                follow=db.execute("SELECT * FROM follow_sessions WHERE id=?",(fid,)).fetchone()
                if not follow:return fail(404,"复刻行程不存在","not_found")
                if follow["user_id"]!=user["id"]:return fail(403,"无权访问这条复刻行程","forbidden")
                if method=="GET" and not action:
                    version_access=db.execute("SELECT access_revoked_at,status FROM route_versions WHERE id=?",(follow["route_version_id"],)).fetchone() if follow["route_version_id"] else None
                    legacy_route_access=db.execute("SELECT status FROM routes WHERE id=?",(follow["route_id"],)).fetchone() if not version_access else None
                    revoked=bool(version_access and (version_access["status"]!="published" or version_access["access_revoked_at"]))
                    legacy_hidden=bool(not version_access and (not legacy_route_access or legacy_route_access["status"]!="published"))
                    if revoked or legacy_hidden:
                        return fail(404,"原路线公开版本已撤回，无法继续获取路线详情","version_revoked")
                    return ok(self._follow_view(follow,db))
                if action=="points" and method=="POST":
                    if follow["status"]!="active":return fail(409,"只有进行中的复刻行程可以记录 GPS","conflict")
                    samples=body.get("samples",[])
                    if not isinstance(samples,list) or len(samples)>500:return fail(422,"采样批次无效（每次最多 500 个点）","validation_error")
                    inserted=0; started_ms=int(datetime.fromisoformat(follow["started_at"]).timestamp()*1000); now_ms=int(time.time()*1000)
                    for sample in samples:
                        try:
                            lat=float(sample["lat"]); lon=float(sample["lon"]); accuracy=float(sample.get("accuracy",0)); ts=int(sample["ts"]); client_id=str(sample["client_id"])
                            if not (-90<=lat<=90 and -180<=lon<=180 and 0<=accuracy<=10000 and 0<len(client_id)<=100):continue
                            if ts<started_ms-300_000 or ts>now_ms+60_000:continue
                            cur=db.execute("INSERT OR IGNORE INTO follow_track_points(id,follow_id,client_id,lat,lon,accuracy,ts,created_at) VALUES(?,?,?,?,?,?,?,?)",(uuid.uuid4().hex,fid,client_id,lat,lon,accuracy,ts,now()))
                            inserted+=cur.rowcount
                        except (KeyError,ValueError,TypeError):continue
                    return ok({"inserted":inserted,"received":len(samples)})
                if action=="checkpoints" and method=="POST":
                    if follow["status"]!="active":return fail(409,"请先继续复刻行程，再确认到站","conflict")
                    checkpoint_id=str(body.get("checkpoint_id",""))
                    snaps=json.loads(follow["checkpoints_snapshot"])
                    if not any(c["id"]==checkpoint_id for c in snaps):return fail(404,"目标不属于这条路线","not_found")
                    done={x["checkpoint_id"] for x in db.execute("SELECT checkpoint_id FROM follow_checkpoints WHERE follow_id=?",(fid,)).fetchall()}
                    next_cp=next((c for c in snaps if c["id"] not in done),None)
                    if not next_cp or next_cp["id"]!=checkpoint_id:return fail(409,"请按路线顺序确认当前目标站点","conflict")
                    confirmation_source=str(body.get("confirmation_source","manual"))
                    if confirmation_source not in {"manual","gps"}:return fail(422,"到站确认来源无效","validation_error")
                    db.execute("INSERT OR IGNORE INTO follow_checkpoints(id,follow_id,checkpoint_id,arrived_at,note) VALUES(?,?,?,?,?)",(uuid.uuid4().hex,fid,checkpoint_id,now(),str(body.get("note",""))[:500]))
                    return ok(self._follow_view(db.execute("SELECT * FROM follow_sessions WHERE id=?",(fid,)).fetchone(),db))
                if action in ("pause","resume","finish") and method=="PATCH":
                    state=follow["status"]
                    if action=="pause" and state=="active":db.execute("UPDATE follow_sessions SET status='paused',pause_started_at=? WHERE id=?",(now(),fid))
                    elif action=="resume" and state=="paused":
                        paused=max(0,int(time.time()-datetime.fromisoformat(follow["pause_started_at"]).timestamp())) if follow["pause_started_at"] else 0
                        db.execute("UPDATE follow_sessions SET status='active',paused_seconds=paused_seconds+?,pause_started_at=NULL WHERE id=?",(paused,fid))
                    elif action=="finish" and state in ("active","paused"):
                        paused=follow["paused_seconds"] or 0
                        if state=="paused" and follow["pause_started_at"]:paused+=max(0,int(time.time()-datetime.fromisoformat(follow["pause_started_at"]).timestamp()))
                        ended=datetime.now(timezone.utc); started=datetime.fromisoformat(follow["started_at"])
                        elapsed=max(0,int((ended-started).total_seconds())-paused)
                        db.execute("UPDATE follow_sessions SET status='completed',ended_at=?,elapsed_seconds=?,paused_seconds=?,pause_started_at=NULL WHERE id=?",(ended.isoformat(),elapsed,paused,fid))
                    else:return fail(409,"复刻行程状态不允许此操作","conflict")
                    return ok(self._follow_view(db.execute("SELECT * FROM follow_sessions WHERE id=?",(fid,)).fetchone(),db))

        # Images: access is checked against owner or currently published route.
        photo_match=re.fullmatch(r"/api/photos/([a-f0-9]+)",path)
        if photo_match and method=="GET":
            with connect() as db:
                photo=db.execute("SELECT p.*,r.status,r.user_id FROM route_photos p JOIN routes r ON r.id=p.route_id WHERE p.id=?",(photo_match.group(1),)).fetchone()
                if not photo:return fail(404,"图片不存在","not_found")
                if photo["status"]!="published" and (not user or (user["id"]!=photo["user_id"] and user["role"]!="admin")):return fail(404,"图片不存在","not_found")
                path=UPLOAD_DIR/photo["stored_name"]
                if not path.is_file():return fail(404,"图片文件不存在","not_found")
                return self._file(path,photo["mime"])

        # Admin review and report queue.
        if path=="/api/admin/routes/pending" and method=="GET":
            if not user:return fail(401,"请先登录","unauthorized")
            if user["role"]!="admin":return fail(403,"仅管理员可审核","forbidden")
            with connect() as db:
                rows=db.execute("SELECT r.*,u.nickname,(SELECT COUNT(*) FROM route_checkpoints c WHERE c.route_id=r.id) checkpoint_count,(SELECT COUNT(*) FROM route_favorites f WHERE f.route_id=r.id) favorite_count FROM routes r JOIN users u ON u.id=r.user_id WHERE r.status='pending_review' ORDER BY r.updated_at",()).fetchall()
                return ok([self._route_view(r,db,user,False,True) for r in rows])
        if path=="/api/admin/reports" and method=="GET":
            if not user:return fail(401,"请先登录","unauthorized")
            if user["role"]!="admin":return fail(403,"仅管理员可处理举报","forbidden")
            with connect() as db:
                return ok([dict(r) for r in db.execute("SELECT rr.*,r.title,u.nickname reporter FROM route_reports rr JOIN routes r ON r.id=rr.route_id JOIN users u ON u.id=rr.user_id WHERE rr.status='open' ORDER BY rr.created_at")])
        amatch=re.fullmatch(r"/api/admin/routes/([a-f0-9]+)/(approve|reject|unpublish)",path)
        if amatch and method=="POST":
            if not user:return fail(401,"请先登录","unauthorized")
            if user["role"]!="admin":return fail(403,"仅管理员可操作","forbidden")
            rid,action=amatch.groups()
            with connect() as db:
                route=db.execute("SELECT * FROM routes WHERE id=?",(rid,)).fetchone()
                if not route:return fail(404,"路线不存在","not_found")
                if action=="approve":
                    if route["status"]!="pending_review":return fail(409,"仅待审核路线可以通过","conflict")
                    status="published"; published=now()
                elif action=="reject":
                    if route["status"]!="pending_review":return fail(409,"仅待审核路线可以拒绝","conflict")
                    status="rejected"; published=None
                else:
                    if route["status"]!="published":return fail(409,"仅公开路线可以下架","conflict")
                    status="unpublished"; published=None
                db.execute("UPDATE routes SET status=?,published_at=COALESCE(?,published_at),updated_at=? WHERE id=?",(status,published,now(),rid))
                if action=="approve":
                    db.execute("UPDATE route_versions SET status='published',published_at=?,access_revoked_at=NULL WHERE route_id=? AND version=? AND status='pending_review'",(published,rid,route["version"]))
                elif action=="reject":
                    db.execute("UPDATE route_versions SET status='rejected' WHERE route_id=? AND version=? AND status='pending_review'",(rid,route["version"]))
                else:
                    db.execute("UPDATE route_versions SET access_revoked_at=? WHERE route_id=? AND status='published' AND access_revoked_at IS NULL",(now(),rid))
                db.execute("INSERT INTO moderation_logs(id,route_id,admin_id,action,note,created_at) VALUES(?,?,?,?,?,?)",(uuid.uuid4().hex,rid,user["id"],action,str(body.get("note",""))[:1000],now()))
                if action in ("approve","reject"):
                    db.execute("UPDATE route_reports SET status='resolved',resolved_by=?,resolved_at=? WHERE route_id=? AND status='open'",(user["id"],now(),rid))
                return ok({"id":rid,"status":status})
        if path=="/api/admin/reports/resolve" and method=="POST":
            if not user:return fail(401,"请先登录","unauthorized")
            if user["role"]!="admin":return fail(403,"仅管理员可操作","forbidden")
            with connect() as db:db.execute("UPDATE route_reports SET status='resolved',resolved_by=?,resolved_at=? WHERE id=?",(user["id"],now(),str(body.get("report_id",""))))
            return ok({"resolved":True})
        return fail(404,"接口不存在","not_found")

    def _login_user(self, user_id):
        token=secrets.token_urlsafe(32); expires=int(time.time())+TOKEN_TTL
        with connect() as db:
            db.execute("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",(uuid.uuid4().hex,user_id,hashlib.sha256(token.encode()).hexdigest(),datetime.fromtimestamp(expires,timezone.utc).isoformat(),now()))
            user=db.execute("SELECT * FROM users WHERE id=?",(user_id,)).fetchone()
        secure="; Secure" if isinstance(self.connection,ssl.SSLSocket) else ""
        return ok(user_json(user),headers={"Set-Cookie":f"{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={TOKEN_TTL}{secure}"})

    def _track_view(self, row, include_raw=False, db=None):
        if not row:return None
        if db is None:
            with connect() as conn:return self._track_view(row,include_raw,conn)
        raw=[dict(p) for p in db.execute("SELECT lat,lon,accuracy,ts,client_id FROM track_points WHERE track_id=? ORDER BY ts,id",(row["id"],)).fetchall()]
        pause_intervals=[(int(p["paused_at_ms"]),int(p["resumed_at_ms"]) if p["resumed_at_ms"] is not None else None)
                         for p in db.execute("SELECT paused_at_ms,resumed_at_ms FROM track_pause_intervals WHERE track_id=? ORDER BY paused_at_ms",(row["id"],)).fetchall()]
        distance,paths=track_geometry_stats(raw,pause_intervals)
        geometry_segments=[[[p["lon"],p["lat"]] for p in path] for path in paths if path]
        cleaned=[point for path in paths for point in path]
        return {"id":row["id"],"status":row["status"],"started_at":row["started_at"],"ended_at":row["ended_at"],"pause_started_at":row["pause_started_at"],"active_seconds":row["active_seconds"],"moving_seconds":moving_time_seconds(raw,pause_intervals),"paused_seconds":row["paused_seconds"],"distance_m":int(distance),"point_count":len(raw),"cleaned_geometry":[[p["lon"],p["lat"]] for p in cleaned],"geometry_segments":geometry_segments,"points":raw if include_raw else None,"is_demo":bool(row["is_demo"])}

    def _route_view(self,row,db,user=None,summary=False,owner=False):
        if not row:return None
        rid=row["id"]
        favorite=bool(user and db.execute("SELECT 1 FROM route_favorites WHERE user_id=? AND route_id=?",(user["id"],rid)).fetchone())
        public_version_ready=row["status"] in ("published","pending_review","rejected","unpublished")
        data={"id":rid,"user_id":row["user_id"],"title":row["title"],"city":row["city"],"category":row["category"],"description":row["description"],"status":row["status"],"distance_m":row["distance_m"],"elapsed_seconds":row["elapsed_seconds"],"moving_seconds":row["moving_seconds"],"nickname":row["nickname"] if "nickname" in row.keys() else "","checkpoint_count":row["checkpoint_count"] if "checkpoint_count" in row.keys() else 0,"favorite_count":row["favorite_count"] if "favorite_count" in row.keys() else 0,"favorite":favorite,"is_demo":bool(row["is_demo"]),"version":row["version"],"route_version":row["version"],"published_at":row["published_at"],"geometry":json.loads(row["public_geometry"] or "[]") if public_version_ready else [],"geometry_segments":json.loads(row["public_geometry_segments"] or "[]") if public_version_ready and "public_geometry_segments" in row.keys() else []}
        if summary:return data
        data["segments"]=[dict(x) for x in db.execute("SELECT id,position,mode,start_label,end_label,start_offset,end_offset,source FROM route_segments WHERE route_id=? ORDER BY position",(rid,)).fetchall()]
        checkpoints=[]
        waypoints=[]
        for x in db.execute("SELECT * FROM route_checkpoints WHERE route_id=? ORDER BY position",(rid,)).fetchall():
            marker_type=x["marker_type"] if "marker_type" in x.keys() else x["kind"]
            photos=[{"id":p["id"],"url":"/api/photos/"+p["id"],"kind":"checkpoint","sort_index":p["sort_index"]}
                    for p in db.execute("SELECT id,sort_index FROM waypoint_photos WHERE waypoint_id=? ORDER BY sort_index,id",(x["id"],)).fetchall()]
            coordinate_system=x["coordinate_system"] if "coordinate_system" in x.keys() else "WGS84"
            cp={"id":x["id"],"position":x["position"],"order_index":x["position"],"name":x["name"],"title":x["name"],"kind":marker_type,"marker_type":marker_type,"note":x["note"],"description":x["note"],"recommended":x["recommended"],"spend":x["spend"],"optional_spend":x["spend"],"stay_minutes":x["stay_minutes"],"lat":x["lat"],"lon":x["lon"],"latitude":x["lat"],"longitude":x["lon"],"coordinate_system":coordinate_system,"segment_id":x["segment_id"],"location_source":x["location_source"],"position_source":x["location_source"],"created_by":x["user_id"],"photos":photos}
            checkpoints.append(cp)
            waypoints.append(cp)
        data["checkpoints"]=checkpoints
        data["waypoints"]=waypoints
        data["legs"]=self._legs_view(db,rid)
        data["cover"]=("/api/photos/"+row["cover_photo_id"]) if row["cover_photo_id"] else None
        if owner and user and user["id"]==row["user_id"] and row["track_id"]:
            track=db.execute("SELECT * FROM track_sessions WHERE id=?",(row["track_id"],)).fetchone()
            data["private_track"]=self._track_view(track,True,db)
        return data

    def _legs_view(self, db, route_id):
        rows=db.execute("""SELECT l.*,a.title from_title,b.title to_title,a.latitude from_latitude,a.longitude from_longitude,
            a.coordinate_system from_coordinate_system,b.latitude to_latitude,b.longitude to_longitude,b.coordinate_system to_coordinate_system
            FROM route_legs l JOIN route_waypoints a ON a.id=l.from_waypoint_id
            JOIN route_waypoints b ON b.id=l.to_waypoint_id
            WHERE l.route_id=? ORDER BY l.order_index""",(route_id,)).fetchall()
        return [{"id":r["id"],"route_id":r["route_id"],"from_waypoint_id":r["from_waypoint_id"],"to_waypoint_id":r["to_waypoint_id"],
                 "order_index":r["order_index"],"position":r["order_index"],"transport_mode":r["transport_mode"],
                 "mode":MODE_TO_TRANSPORT.get(r["transport_mode"],"其他"),"mode_confirmed":bool(r["mode_confirmed"]),
                 "actual_duration_seconds":r["actual_duration_seconds"],"notes":r["notes"],"line_info":r["line_info"],
                 "start_label":r["from_title"],"end_label":r["to_title"],
                 "from_waypoint":{"id":r["from_waypoint_id"],"title":r["from_title"],"latitude":r["from_latitude"],"longitude":r["from_longitude"],"coordinate_system":r["from_coordinate_system"]},
                 "to_waypoint":{"id":r["to_waypoint_id"],"title":r["to_title"],"latitude":r["to_latitude"],"longitude":r["to_longitude"],"coordinate_system":r["to_coordinate_system"]},
                 "track_start_index":r["track_start_index"],"track_end_index":r["track_end_index"],"source":r["source"]} for r in rows]

    def _follow_view(self,row,db):
        if not row:return None
        completed={x["waypoint_id"]:x["arrived_at"] for x in db.execute("SELECT waypoint_id,arrived_at FROM follow_waypoint_progress WHERE follow_id=?",(row["id"],)).fetchall()}
        cps=json.loads(row["waypoints_snapshot"] or "[]") or json.loads(row["checkpoints_snapshot"])
        for cp in cps:cp["arrived_at"]=completed.get(cp["id"])
        paused=row["paused_seconds"] or 0
        if row["status"]=="paused" and row["pause_started_at"]:
            paused+=max(0,int(time.time()-datetime.fromisoformat(row["pause_started_at"]).timestamp()))
        elapsed=row["elapsed_seconds"]
        if elapsed is None:
            elapsed=max(0,int((datetime.now(timezone.utc)-datetime.fromisoformat(row["started_at"])).total_seconds())-paused)
        legs=json.loads(row["legs_snapshot"] or "[]")
        own_points=[dict(point) for point in db.execute("SELECT client_id,lat,lon,accuracy,ts FROM follow_track_points WHERE follow_id=? ORDER BY ts,id",(row["id"],)).fetchall()]
        own_distance,own_cleaned=path_stats(own_points)
        own_geometry=[[point["lon"],point["lat"]] for point in own_cleaned]
        return {"id":row["id"],"route_id":row["route_id"],"route_version":row["route_version"],"title":row["title_snapshot"],"geometry":json.loads(row["geometry_snapshot"]),"geometry_segments":json.loads(row["geometry_segments_snapshot"] or "[]"),"segments":json.loads(row["segments_snapshot"]),"legs":legs,"checkpoints":cps,"waypoints":cps,"status":row["status"],"started_at":row["started_at"],"ended_at":row["ended_at"],"elapsed_seconds":elapsed,"completed_count":sum(bool(c["arrived_at"]) for c in cps),"total_checkpoints":len(cps),"my_track":{"point_count":len(own_points),"distance_m":int(own_distance),"geometry":own_geometry}}

    def _save_photo(self,db,user,rid,body):
        data_url=str(body.get("data_url","")); match=re.match(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$",data_url)
        if not match:return fail(422,"仅支持 JPEG、PNG、WebP 图片","validation_error")
        mime=match.group(1); raw=base64.b64decode(match.group(2),validate=True)
        if len(raw)>8*1024*1024:return fail(413,"单张图片最大 8 MB","payload_too_large")
        if (mime=="image/jpeg" and not raw.startswith(b"\xff\xd8\xff")) or (mime=="image/png" and not raw.startswith(b"\x89PNG\r\n\x1a\n")) or (mime=="image/webp" and not (raw.startswith(b"RIFF") and raw[8:12]==b"WEBP")):
            return fail(422,"图片内容与格式不匹配","validation_error")
        # Strip EXIF and metadata chunks from common image formats before storing.
        raw=strip_metadata(raw,mime)
        cp_id=body.get("checkpoint_id")
        if cp_id and not db.execute("SELECT 1 FROM route_checkpoints WHERE id=? AND route_id=?",(cp_id,rid)).fetchone():
            return fail(404,"标记点不存在","not_found")
        kind="cover" if body.get("kind")=="cover" else "checkpoint"
        if kind=="checkpoint" and not cp_id:return fail(422,"现场照片必须关联到一个标记点","validation_error")
        digest=hashlib.sha256(raw).hexdigest()
        if cp_id:
            existing=db.execute("SELECT id,stored_name,mime,size_bytes FROM route_photos WHERE checkpoint_id=? AND content_sha256=?",(cp_id,digest)).fetchone()
            if existing:return ok({"id":existing["id"],"url":"/api/photos/"+existing["id"],"kind":kind,"size_bytes":existing["size_bytes"],"reused":True})
            sort_index=db.execute("SELECT COUNT(*) FROM route_photos WHERE checkpoint_id=?",(cp_id,)).fetchone()[0]
        else:
            sort_index=0
        pid=uuid.uuid4().hex; ext={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[mime]; name=f"{pid}.{ext}"
        UPLOAD_DIR.mkdir(parents=True,exist_ok=True); file_path=UPLOAD_DIR/name
        file_path.write_bytes(raw)
        try:
            db.execute("INSERT INTO route_photos(id,route_id,checkpoint_id,user_id,kind,stored_name,mime,size_bytes,created_at,sort_index,content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(pid,rid,cp_id,user["id"],kind,name,mime,len(raw),now(),sort_index,digest))
        except Exception:
            file_path.unlink(missing_ok=True)
            raise
        if kind=="cover":db.execute("UPDATE routes SET cover_photo_id=?,updated_at=? WHERE id=?",(pid,now(),rid))
        return ok({"id":pid,"url":"/api/photos/"+pid,"kind":kind,"size_bytes":len(raw),"sort_index":sort_index},201)

    def _file(self,path,mime):
        try:data=path.read_bytes()
        except OSError:return fail(404,"文件不存在","not_found")
        # Small static files only; images are served inline.
        cache_control="no-store" if path.is_relative_to(UPLOAD_DIR) else "no-cache"
        return 200,data,{"Content-Type":mime,"Cache-Control":cache_control,"X-Content-Type-Options":"nosniff"}

    def _respond(self,result):
        status,payload,headers=result
        self.send_response(status)
        for key,value in headers.items():self.send_header(key,value)
        if isinstance(payload,bytes):
            self.send_header("Content-Length",str(len(payload))); self.end_headers(); self.wfile.write(payload); return
        raw=json.dumps(payload,ensure_ascii=False,separators=(",",":")).encode()
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(raw)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.end_headers(); self.wfile.write(raw)

    def do_GET(self): self._handle()
    def do_POST(self): self._handle()
    def do_PATCH(self): self._handle()
    def do_DELETE(self): self._handle()
    def _handle(self):
        try:self._respond(self._dispatch())
        except json.JSONDecodeError:self._respond(fail(400,"JSON 格式错误","bad_request"))
        except ValueError as e:self._respond(fail(413 if "过大" in str(e) else 422,str(e),"validation_error"))
        except sqlite3.IntegrityError as e:
            sys.stderr.write(f"database constraint: {e}\n"); self._respond(fail(409,"数据状态冲突，请刷新后重试","conflict"))
        except sqlite3.OperationalError as e:
            sys.stderr.write(f"database unavailable: {e}\n"); self._respond(fail(503,"数据库暂时不可用，请稍后重试","service_unavailable"))
        except (BrokenPipeError,ConnectionResetError):return
        except Exception as e:
            sys.stderr.write(f"request failed: {type(e).__name__}: {e}\n"); self._respond(fail(500,"服务暂时发生错误","internal_error"))


def strip_metadata(data: bytes, mime: str) -> bytes:
    if mime=="image/jpeg":
        out=bytearray(data[:2]); i=2
        while i+4<=len(data) and data[i]==0xFF:
            marker=data[i+1]
            if marker==0xDA:out.extend(data[i:]); return bytes(out)
            length=int.from_bytes(data[i+2:i+4],"big")
            if length<2 or i+2+length>len(data):return data
            segment=data[i:i+2+length]
            if marker not in (0xE1,0xED,0xFE):out.extend(segment)
            i+=2+length
        out.extend(data[i:]); return bytes(out)
    if mime=="image/png":
        out=bytearray(data[:8]); i=8
        while i+12<=len(data):
            length=int.from_bytes(data[i:i+4],"big"); kind=data[i+4:i+8]; end=i+12+length
            if end>len(data):return data
            if kind not in (b"eXIf",b"tEXt",b"zTXt",b"iTXt"):out.extend(data[i:end])
            i=end
            if kind==b"IEND":break
        return bytes(out)
    if mime=="image/webp" and len(data)>=12:
        chunks=[]; i=12
        while i+8<=len(data):
            kind=data[i:i+4]; size=int.from_bytes(data[i+4:i+8],"little"); end=i+8+size+(size%2)
            if end>len(data):return data
            if kind not in (b"EXIF",b"XMP "):chunks.append(data[i:end])
            i=end
        body=b"".join(chunks); return data[:8]+len(body).to_bytes(4,"little")+b"WEBP"+body
    return data


def main():
    parser=argparse.ArgumentParser(description="CityTrace local MVP server")
    parser.add_argument("--host",default=os.environ.get("CITYTRACE_HOST","127.0.0.1")); parser.add_argument("--port",type=int,default=int(os.environ.get("CITYTRACE_PORT","8000")))
    parser.add_argument("--certfile"); parser.add_argument("--keyfile")
    args=parser.parse_args()
    if APP_MODE not in {"demo","real"}:parser.error("APP_MODE 只能是 demo 或 real")
    schema()
    server=ThreadingHTTPServer((args.host,args.port),CityTraceHandler)
    if args.certfile:
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(args.certfile,args.keyfile); server.socket=context.wrap_socket(server.socket,server_side=True)
    protocol="https" if args.certfile else "http"
    print(f"CityTrace V2.1 ready at {protocol}://{args.host}:{args.port}")
    print(f"Database: {DB_PATH}")
    if APP_MODE == "demo":
        print("Demo accounts: author@citytrace.demo / trace123; explorer@citytrace.demo / trace123; admin@citytrace.demo / admin123")
    try:server.serve_forever()
    except KeyboardInterrupt:print("\nStopping CityTrace…")
    finally:server.server_close()

if __name__=="__main__":main()
