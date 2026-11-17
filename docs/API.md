# CityTrace REST API

Base path: `/api`. JSON requests use `Content-Type: application/json`. Responses follow `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": ..., "message": ... } }`. Authenticated sessions use an HttpOnly, SameSite=Lax cookie. Dates are UTC ISO-8601 unless noted.

## Auth and recording

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Register `{nickname,email,password}` |
| POST | `/auth/login` | public | Login `{email,password}` |
| POST | `/auth/logout` | session | Revoke session |
| GET | `/auth/me` | session | Current user |
| DELETE | `/auth/me` | session | Soft delete account and revoke sessions |
| POST | `/tracks` | user | Start foreground GPS session; optional `idempotency_key` makes retries safe |
| GET | `/tracks/active` | user | Restore active session |
| GET | `/tracks/{id}` | owner | Read original samples |
| POST | `/tracks/{id}/points` | owner | Idempotently batch upload `{samples:[{client_id,lat,lon,accuracy,ts}]}`; paused sessions accept delayed pre-pause samples, while pause-interval samples and uploads after finish are rejected/filtered |
| POST | `/tracks/{id}/pause` | owner | Pause |
| POST | `/tracks/{id}/resume` | owner | Resume |
| POST | `/tracks/{id}/finish` | owner | Finish and compute active duration |

## Routes

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/routes?q=&city=&category=&min_duration=&max_duration=&page=&page_size=&bbox=` | public | Search approved public routes; bbox filtering precedes pagination and total counting |
| GET | `/routes/{id}` | public/owner/admin | Route details; original points are owner-only |
| POST | `/routes` | user | Create draft from finished owned track |
| PATCH | `/routes/{id}` | owner | Edit draft metadata |
| POST | `/routes/{id}/segments` | owner | Add transport segment |
| PATCH | `/routes/{id}/segments/{segment_id}` | owner | Edit transport mode, labels and time interval |
| DELETE | `/routes/{id}/segments/{segment_id}` | owner | Delete a draft segment |
| POST | `/routes/{id}/waypoints` | owner | Add a route waypoint (alias of the legacy checkpoints path) |
| PATCH | `/waypoints/{id}` | owner | Edit waypoint position, details, source and coordinate system |
| DELETE | `/waypoints/{id}` | owner | Delete a waypoint and reconcile adjacent legs transactionally |
| PATCH | `/routes/{id}/waypoints/order` | owner | Set the complete order using `{waypoint_ids, expected_version}` |
| GET | `/routes/{id}/legs` | public/owner/admin | Read the ordered legs between adjacent waypoints |
| PATCH | `/legs/{id}` | owner | Confirm/edit transport mode, duration, notes and line details |
| POST | `/routes/{id}/checkpoints` | owner | Add a checkpoint |
| PATCH | `/routes/{id}/checkpoints/{checkpoint_id}` | owner | Edit stop details, position and location |
| DELETE | `/routes/{id}/checkpoints/{checkpoint_id}` | owner | Delete a draft checkpoint |
| POST | `/routes/{id}/photos` | owner | Upload base64 data URL (`image/jpeg`, PNG, WebP) |
| POST | `/waypoints/{id}/photos` | owner | Upload an additional photo to a waypoint |
| POST | `/routes/{id}/submit` | owner | Requires `privacy_confirmed:true`, a real track, 2+ waypoints, a photo per waypoint and a confirmed leg per adjacent pair; trims public GPS and submits for review |
| POST | `/routes/{id}/withdraw` | owner | Withdraw pending or published route |
| POST/DELETE | `/routes/{id}/favorite` | user | Add/remove unique favorite |
| POST | `/routes/{id}/report` | user | Report a public route |
| GET | `/me/routes` | user | Own routes, including drafts |
| GET | `/me/favorites` | user | Saved public routes |

`bbox=west,south,east,north` filters by public GPS points within the range. Invalid, empty, repeated, non-finite, out-of-range or reversed bounds return 422. Results use stable ordering by publication time descending and route ID ascending; `page_size` is capped at 30. Photo responses use `Cache-Control: no-store` so withdrawal or logout requires a fresh authorization check.

## Replication and moderation

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/routes/{id}/follow` | user | Create independent versioned follow snapshot |
| GET | `/me/follows` | user | Follow history |
| GET | `/follow-sessions/{id}` | owner | Read follow session and arrival records |
| PATCH | `/follow-sessions/{id}/pause|resume|finish` | owner | Change follow state |
| POST | `/follow-sessions/{id}/checkpoints` | owner | Confirm the next checkpoint in route order; paused/completed sessions return 409 |
| POST | `/follow-sessions/{id}/points` | owner | Idempotently store the follower's own GPS samples, separately from the author's track |
| POST | `/follow-sessions/{id}/waypoints/{waypoint_id}/arrive` | owner | Confirm arrival (alias of the legacy ordered checkpoint endpoint) |
| GET | `/admin/routes/pending` | admin | Review queue |
| POST | `/admin/routes/{id}/approve|reject|unpublish` | admin | Moderate route |
| GET | `/admin/reports` | admin | Open reports |
| POST | `/admin/reports/resolve` | admin | Resolve report |

Common error status codes: 400 malformed JSON, 401 unauthenticated, 403 forbidden, 404 absent/private resource, 409 invalid state or duplicate workflow, 413 body/image too large, 422 validation error, 503 SQLite temporarily unavailable. `GET /health` reports database readiness. `GET /api/config` returns map-key status, not server-side secrets beyond the public JS API credentials explicitly intended for browser use.
