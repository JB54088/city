import base64
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timezone
import unittest
from pathlib import Path

import app


class ApiClient:
    def __init__(self, port):
        self.port = port
        self.cookie = ""

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Accept": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        conn.request(method, path, payload, headers)
        response = conn.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        status = response.status
        conn.close()
        if set_cookie and "Max-Age=0" not in set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        try:
            return status, json.loads(raw.decode())
        except ValueError:
            return status, raw

    def data(self, method, path, body=None, expected=200):
        status, result = self.request(method, path, body)
        if status != expected:
            raise AssertionError(f"{method} {path}: expected {expected}, got {status}: {result}")
        return result["data"]


class CityTraceApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="citytrace-test-")
        root = Path(cls.temp.name)
        app.DATA_DIR = root
        app.MODE_DIR = root / "demo"
        app.DB_PATH = app.MODE_DIR / "test.sqlite3"
        app.UPLOAD_DIR = app.MODE_DIR / "uploads"
        app.APP_MODE = "demo"
        app.schema()
        app.schema()  # Re-running the migration/seed path must preserve existing data.
        cls.server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.CityTraceHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.temp.cleanup()

    def setUp(self):
        # A failed assertion must not leave an active recording for the next case.
        with app.connect() as db:
            db.execute("UPDATE track_sessions SET status='finished', ended_at=? WHERE status IN ('recording','paused')", (app.now(),))
        self.author = ApiClient(self.port)
        self.explorer = ApiClient(self.port)
        self.admin = ApiClient(self.port)
        self.author.data("POST", "/api/auth/login", {"email": "author@citytrace.demo", "password": "trace123"})
        self.explorer.data("POST", "/api/auth/login", {"email": "explorer@citytrace.demo", "password": "trace123"})
        self.admin.data("POST", "/api/auth/login", {"email": "admin@citytrace.demo", "password": "admin123"})

    def make_draft(self, title="测试路线"):
        status, _ = self.author.request("POST", "/api/routes", {"title": "没有轨迹的路线"})
        self.assertEqual(status, 422)
        track = self.author.data("POST", "/api/tracks", {}, expected=201)
        started = datetime.fromtimestamp(time.time() - 80, timezone.utc).isoformat(timespec="milliseconds")
        with app.connect() as db:
            db.execute("UPDATE track_sessions SET started_at=? WHERE id=?", (started, track["id"]))
        base = int(time.time() * 1000) - 80_000
        # Each valid hop is about 80m and lasts 20 seconds; end points span >300m.
        points = [
            {"client_id": f"{track['id']}-{i}", "lat": 26.0800, "lon": 119.2900 + i * 0.0009,
             "accuracy": 7, "ts": base + i * 20_000}
            for i in range(5)
        ]
        self.author.data("POST", f"/api/tracks/{track['id']}/points", {"samples": points}, expected=200)
        finished = self.author.data("POST", f"/api/tracks/{track['id']}/finish", {})
        route = self.author.data("POST", "/api/routes", {"track_id": track["id"], "title": title}, expected=201)
        same_route = self.author.data("POST", "/api/routes", {"track_id": track["id"], "title": "重复提交"})
        self.assertEqual(same_route["id"], route["id"])
        self.author.data("PATCH", f"/api/routes/{route['id']}", {"title": title, "city": "福州", "category": "美食", "description": "一条用于自动化验证的真实 GPS 测试轨迹。"})
        self.assertGreaterEqual(finished["point_count"], 5)
        return track["id"], route["id"]

    def add_stops(self, route_id):
        segment = self.author.data("POST", f"/api/routes/{route_id}/segments", {
            "mode": "步行", "position": 0, "start_label": "街口", "end_label": "地铁站出口",
            "start_offset": 0, "end_offset": 0,
        }, expected=201)
        checkpoints = []
        png = "data:image/png;base64," + base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082")).decode()
        for i, name in enumerate(("街口", "巷口小店", "地铁站出口")):
            checkpoint = self.author.data("POST", f"/routes/{route_id}/waypoints", {
                "title": name, "marker_type": ("景点", "美食", "地铁站")[i], "order_index": i,
                "latitude": 26.08, "longitude": 119.29 + i * 0.00045,
                "position_source": "track", "segment_id": segment["id"],
                "recommended": "鱼丸", "optional_spend": 18 if i else 0, "stay_minutes": 20,
            }, expected=201)
            checkpoints.append(checkpoint["id"])
            self.author.data("POST", f"/waypoints/{checkpoint['id']}/photos", {
                "data_url": png, "kind": "checkpoint", "checkpoint_id": checkpoint["id"],
            }, expected=201)
        for index, leg in enumerate(self.author.data("GET", f"/api/routes/{route_id}/legs")):
            self.author.data("PATCH", f"/api/legs/{leg['id']}", {
                "transport_mode": "walking" if index == 0 else "subway",
                "actual_duration_seconds": 600 if index == 0 else 420,
                "line_info": "地铁 1 号线" if index else "沿街步行",
            })
        return checkpoints

    def publish(self, route_id):
        self.author.data("POST", f"/api/routes/{route_id}/submit", {"privacy_confirmed": True}, expected=200)
        self.admin.data("POST", f"/api/admin/routes/{route_id}/approve", {"note": "自动化测试审核"}, expected=200)

    def test_registration_login_and_session_cookie(self):
        client = ApiClient(self.port)
        status, result = client.request("POST", "/api/auth/register", {
            "nickname": "新漫游者", "email": f"new-{time.time_ns()}@example.com", "password": "strong-pass-123"})
        self.assertEqual(status, 200)
        self.assertEqual(result["data"]["nickname"], "新漫游者")
        me = client.data("GET", "/api/auth/me")
        self.assertEqual(me["role"], "user")
        client.data("POST", "/api/auth/logout", {})
        status, _ = client.request("GET", "/api/auth/me")
        self.assertEqual(status, 401)

    def test_track_pause_resume_idempotency_filter_and_owner_permissions(self):
        track = self.author.data("POST", "/api/tracks", {}, expected=201)
        base = int(time.time() * 1000)
        point = {"client_id": "same-sample", "lat": 26.08, "lon": 119.29, "accuracy": 5, "ts": base}
        result = self.author.data("POST", f"/api/tracks/{track['id']}/points", {"samples": [point, dict(point, lat=26.081)]})
        self.assertEqual(result["inserted"], 1)
        self.author.data("POST", f"/api/tracks/{track['id']}/pause", {})
        status, _ = self.author.request("POST", f"/api/tracks/{track['id']}/points", {"samples": [dict(point, client_id="during-pause")]})
        self.assertEqual(status, 409)
        with app.connect() as db:
            pause_started = db.execute("SELECT paused_at_ms FROM track_pause_intervals WHERE track_id=?", (track["id"],)).fetchone()[0]
        time.sleep(0.02)
        self.author.data("POST", f"/api/tracks/{track['id']}/resume", {})
        with app.connect() as db:
            pause_ended = db.execute("SELECT resumed_at_ms FROM track_pause_intervals WHERE track_id=?", (track["id"],)).fetchone()[0]
        paused_ts = (pause_started + pause_ended) // 2
        result = self.author.data("POST", f"/api/tracks/{track['id']}/points", {"samples": [dict(point, client_id="delayed-pause-sample", ts=paused_ts)]})
        self.assertEqual(result["inserted"], 0)
        self.author.data("POST", f"/api/tracks/{track['id']}/points", {"samples": [dict(point, client_id="normal-hop", lon=119.2905, ts=base+60_000)]})
        private = self.author.data("GET", f"/api/tracks/{track['id']}")
        self.assertEqual(private["point_count"], 2)
        self.assertEqual(len(private["points"]), 2)
        self.assertLess(private["distance_m"], 100)
        forbidden, _ = self.explorer.request("GET", f"/api/tracks/{track['id']}")
        self.assertEqual(forbidden, 403)
        finished = self.author.data("POST", f"/api/tracks/{track['id']}/finish", {})
        self.assertEqual(finished["status"], "finished")

    def test_route_private_review_favorite_snapshot_and_ordered_follow(self):
        track_id, route_id = self.make_draft("巷口鱼丸测试路线")
        checkpoint_ids = self.add_stops(route_id)
        draft = self.author.data("GET", f"/api/routes/{route_id}")
        self.assertEqual(draft["status"], "draft")
        seg = draft["segments"][0]
        self.author.data("PATCH", f"/api/routes/{route_id}/segments/{seg['id']}", {
            "mode": "地铁", "start_label": "街口站", "end_label": "巷口站", "start_offset": 0, "end_offset": 0})
        self.author.data("PATCH", f"/api/routes/{route_id}/checkpoints/{checkpoint_ids[0]}", {
            "note": "编辑后的现场说明", "recommended": "手作鱼丸", "spend": 18})
        draft = self.author.data("GET", f"/api/routes/{route_id}")
        self.assertEqual(draft["segments"][0]["mode"], "地铁")
        self.assertEqual(draft["checkpoints"][0]["note"], "编辑后的现场说明")
        self.assertEqual([leg["transport_mode"] for leg in draft["legs"]], ["walking", "subway"])
        self.assertEqual(len(draft["waypoints"]), 3)
        status, _ = self.explorer.request("GET", f"/api/routes/{route_id}")
        self.assertEqual(status, 404)
        status, _ = self.explorer.request("PATCH", f"/api/routes/{route_id}", {"title": "越权"})
        self.assertEqual(status, 403)
        status, _ = self.explorer.request("POST", f"/api/routes/{route_id}/favorite", {})
        self.assertEqual(status, 404)
        status, _ = self.explorer.request("POST", f"/api/routes/{route_id}/report", {"reason": "其他"})
        self.assertEqual(status, 404)
        self.author.data("POST", f"/api/routes/{route_id}/submit", {"privacy_confirmed": True}, expected=200)
        status, _ = self.explorer.request("GET", f"/api/routes/{route_id}")
        self.assertEqual(status, 404)
        self.admin.data("POST", f"/api/admin/routes/{route_id}/approve", {"note": "通过"})

        public = ApiClient(self.port).data("GET", f"/api/routes/{route_id}")
        self.assertEqual(public["status"], "published")
        self.assertTrue(public["geometry"])
        self.assertTrue(public["geometry_segments"])
        self.assertNotIn("private_track", public)
        self.assertNotIn("track_id", public)
        self.assertNotIn("points", public)
        # Privacy-trimmed public path is shorter than the complete five-point source line.
        self.assertLessEqual(len(public["geometry"]), 3)
        status, _ = self.explorer.request("GET", f"/api/tracks/{track_id}")
        self.assertEqual(status, 403)

        self.explorer.data("POST", f"/api/routes/{route_id}/favorite", {})
        self.explorer.data("POST", f"/api/routes/{route_id}/favorite", {})
        favorites = self.explorer.data("GET", "/users/me/favorites")
        self.assertEqual(sum(r["id"] == route_id for r in favorites), 1)

        follow = self.explorer.data("POST", f"/api/routes/{route_id}/follow", {}, expected=201)
        self.assertEqual(follow["route_version"], public["version"])
        self.assertEqual(len(follow["checkpoints"]), 3)
        self.assertEqual(follow["geometry_segments"], public["geometry_segments"])
        self.assertEqual([leg["transport_mode"] for leg in follow["legs"]], ["walking", "subway"])
        sample_ts = int(time.time() * 1000)
        synced = self.explorer.data("POST", f"/api/follow-sessions/{follow['id']}/points", {"samples": [
            {"client_id": "follow-gps-1", "lat": 26.0802, "lon": 119.2901, "accuracy": 9, "ts": sample_ts},
            {"client_id": "follow-gps-1", "lat": 26.0802, "lon": 119.2901, "accuracy": 9, "ts": sample_ts},
        ]})
        self.assertEqual(synced["inserted"], 1)
        self.assertEqual(self.explorer.data("GET", f"/api/follow-sessions/{follow['id']}")["my_track"]["point_count"], 1)
        status, _ = self.explorer.request("POST", f"/follow-sessions/{follow['id']}/waypoints/{checkpoint_ids[1]}/arrive", {})
        self.assertEqual(status, 409)
        first = self.explorer.data("POST", f"/follow-sessions/{follow['id']}/waypoints/{checkpoint_ids[0]}/arrive", {})
        self.assertEqual(first["completed_count"], 1)
        completed = self.explorer.data("POST", f"/follow-sessions/{follow['id']}/waypoints/{checkpoint_ids[1]}/arrive", {})
        self.assertEqual(completed["completed_count"], 2)
        completed = self.explorer.data("POST", f"/follow-sessions/{follow['id']}/waypoints/{checkpoint_ids[2]}/arrive", {})
        self.assertEqual(completed["completed_count"], 3)
        ended = self.explorer.data("PATCH", f"/api/follow-sessions/{follow['id']}/finish", {})
        self.assertEqual(ended["status"], "completed")

    def test_v2_waypoint_order_rebuilds_only_adjacent_legs(self):
        _, route_id = self.make_draft("标记点顺序测试")
        ids = self.add_stops(route_id)
        original = self.author.data("GET", f"/routes/{route_id}/legs")
        self.assertEqual([(leg["from_waypoint_id"], leg["to_waypoint_id"]) for leg in original], [(ids[0], ids[1]), (ids[1], ids[2])])
        route = self.author.data("GET", f"/routes/{route_id}")
        reordered = self.author.data("PATCH", f"/routes/{route_id}/waypoints/order", {
            "waypoint_ids": [ids[2], ids[1], ids[0]], "expected_version": route["version"],
        })
        updated = self.author.data("GET", f"/routes/{route_id}/legs")
        self.assertEqual([(leg["from_waypoint_id"], leg["to_waypoint_id"]) for leg in updated], [(ids[2], ids[1]), (ids[1], ids[0])])
        self.assertEqual(len({leg["id"] for leg in updated}), 2)
        self.assertTrue(all(not leg["mode_confirmed"] for leg in updated))
        self.assertEqual(reordered["waypoint_ids"], [ids[2], ids[1], ids[0]])
        stale, _ = self.author.request("PATCH", f"/routes/{route_id}/waypoints/order", {
            "waypoint_ids": ids, "expected_version": route["version"],
        })
        self.assertEqual(stale, 409)
        invalid, _ = self.author.request("POST", f"/routes/{route_id}/submit", {"privacy_confirmed": True})
        self.assertEqual(invalid, 422)

    def test_v2_migration_preserves_existing_checkpoint_and_photo_rows(self):
        original = {name: getattr(app, name) for name in ("DATA_DIR", "MODE_DIR", "DB_PATH", "UPLOAD_DIR", "APP_MODE")}
        with tempfile.TemporaryDirectory(prefix="citytrace-v2-migration-") as directory:
            root = Path(directory)
            mode_dir = root / "demo"
            mode_dir.mkdir()
            database = mode_dir / "legacy.sqlite3"
            db = sqlite3.connect(database)
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript((Path(app.ROOT) / "migrations" / "001_initial.sql").read_text())
            db.execute("PRAGMA user_version=1")
            db.executescript((Path(app.ROOT) / "migrations" / "002_track_pause_intervals.sql").read_text())
            db.execute("PRAGMA user_version=2")
            stamp = app.now()
            db.execute("INSERT INTO users(id,nickname,email,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)",
                       ("legacy-user", "旧用户", "legacy@example.com", "unused", "user", 1, stamp))
            db.execute("INSERT INTO routes(id,user_id,title,status,created_at,updated_at,published_at) VALUES(?,?,?,?,?,?,?)",
                       ("legacy-route", "legacy-user", "已存在的路线", "published", stamp, stamp, stamp))
            db.execute("""INSERT INTO route_checkpoints(id,route_id,user_id,position,name,kind,lat,lon,location_source,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?)""",
                       ("legacy-point", "legacy-route", "legacy-user", 0, "旧标记点", "美食", 26.08, 119.3, "manual", stamp))
            db.execute("""INSERT INTO route_photos(id,route_id,checkpoint_id,user_id,kind,stored_name,mime,size_bytes,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                       ("legacy-photo", "legacy-route", "legacy-point", "legacy-user", "checkpoint", "legacy.png", "image/png", 10, stamp))
            db.execute("""INSERT INTO follow_sessions(id,user_id,route_id,route_version,title_snapshot,geometry_snapshot,
                       segments_snapshot,checkpoints_snapshot,status,started_at,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                       ("legacy-follow", "legacy-user", "legacy-route", 1, "旧复刻", "[[119.3,26.08]]", "[]",
                        json.dumps([{"id": "legacy-point", "name": "旧标记点", "lat": 26.08, "lon": 119.3}], ensure_ascii=False),
                        "active", stamp, stamp))
            db.commit()
            db.close()
            app.DATA_DIR, app.MODE_DIR, app.DB_PATH, app.UPLOAD_DIR, app.APP_MODE = root, mode_dir, database, mode_dir / "uploads", "demo"
            try:
                app.schema()
                with app.connect() as migrated:
                    self.assertEqual(migrated.execute("PRAGMA user_version").fetchone()[0], 3)
                    self.assertEqual(migrated.execute("SELECT title FROM route_waypoints WHERE id='legacy-point'").fetchone()[0], "旧标记点")
                    self.assertEqual(migrated.execute("SELECT storage_key FROM waypoint_photos WHERE id='legacy-photo'").fetchone()[0], "legacy.png")
                    self.assertEqual(migrated.execute("SELECT COUNT(*) FROM routes WHERE id='legacy-route'").fetchone()[0], 1)
                    follow = migrated.execute("SELECT route_version_id,waypoints_snapshot FROM follow_sessions WHERE id='legacy-follow'").fetchone()
                    self.assertIsNotNone(follow["route_version_id"])
                    self.assertEqual(json.loads(follow["waypoints_snapshot"])[0]["id"], "legacy-point")
            finally:
                for name, value in original.items():
                    setattr(app, name, value)

    def test_photo_upload_report_and_admin_unpublish(self):
        _, route_id = self.make_draft("照片与举报测试路线")
        checkpoint_ids = self.add_stops(route_id)
        png = "data:image/png;base64," + base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082")).decode()
        photo = self.author.data("POST", f"/api/routes/{route_id}/photos", {"data_url": png, "kind": "cover"}, expected=201)
        self.assertTrue(photo["url"].startswith("/api/photos/"))
        status, _ = self.explorer.request("GET", photo["url"])
        self.assertEqual(status, 404)
        self.author.data("POST", f"/waypoints/{checkpoint_ids[0]}/photos", {"data_url": png, "kind": "checkpoint"}, expected=200)
        self.publish(route_id)
        detail = ApiClient(self.port).data("GET", f"/api/routes/{route_id}")
        self.assertTrue(detail["cover"].endswith(photo["id"]))
        self.assertTrue(detail["checkpoints"][0]["photos"])
        status, public_photo = ApiClient(self.port).request("GET", photo["url"])
        self.assertEqual(status, 200)
        self.assertIsInstance(public_photo, bytes)
        follow = self.explorer.data("POST", f"/api/routes/{route_id}/follow", {}, expected=201)
        self.explorer.data("POST", f"/api/routes/{route_id}/report", {"reason": "隐私风险", "note": "测试说明"}, expected=201)
        reports = self.admin.data("GET", "/api/admin/reports")
        self.assertTrue(any(x["route_id"] == route_id for x in reports))
        self.admin.data("POST", f"/api/admin/routes/{route_id}/unpublish", {"note": "测试下架"})
        status, _ = ApiClient(self.port).request("GET", f"/api/routes/{route_id}")
        self.assertEqual(status, 404)
        status, _ = self.explorer.request("GET", f"/api/follow-sessions/{follow['id']}")
        self.assertEqual(status, 404)

    def test_admin_boundary_and_invalid_segment(self):
        _, route_id = self.make_draft("权限校验路线")
        status, _ = self.author.request("POST", f"/api/routes/{route_id}/segments", {"mode": "直升机", "position": 0})
        self.assertEqual(status, 422)
        status, _ = self.explorer.request("GET", "/api/admin/routes/pending")
        self.assertEqual(status, 403)
        status, _ = ApiClient(self.port).request("GET", "/api/admin/routes/pending")
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
