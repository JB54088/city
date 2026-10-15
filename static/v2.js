/* CityTrace V2 interaction layer. Loaded after app.js to keep the existing MVP shell. */
const legacyRouteDetailV2 = window.routeDetailLegacy;
const legacyEditorV2 = window.renderEditorLegacy;
const legacyFollowPageV2 = window.followPage;
const legacyRecordPageV2 = window.renderRecord;
const legacyMapPageV2 = window.mapPage;
let v2MapContext = '';
let followWatchId = null;
let followFlushBusy = false;

const V2_MODES = [
  ['walking', '🚶 步行'], ['subway', '🚇 地铁'], ['bus', '🚌 公交'],
  ['cycling', '🚲 骑行'], ['taxi', '🚕 打车'], ['driving', '🚗 自驾'], ['other', '↗ 其他']
];
const modeText = value => V2_MODES.find(([key]) => key === value)?.[1] || '↗ 其他';
const jsonAttr = value => esc(JSON.stringify(value ?? []));

function v2MapPayload(points, opts) {
  const route = state.route;
  const follow = state.follow;
  const track = state.track;
  let paths = Array.isArray(points) && points.length ? [points] : [];
  let waypoints = [];
  let legs = [];
  let user = null;
  let ownPath = [];
  if (v2MapContext === 'route' && route) {
    const privateView = opts.private === true && route.private_track;
    paths = privateView
      ? (route.private_track.geometry_segments?.length ? route.private_track.geometry_segments : [route.private_track.cleaned_geometry || []])
      : (route.geometry_segments?.length ? route.geometry_segments : paths);
    waypoints = route.waypoints || route.checkpoints || [];
    legs = route.legs || [];
  } else if (v2MapContext === 'follow' && follow) {
    paths = follow.geometry_segments?.length ? follow.geometry_segments : paths;
    waypoints = follow.waypoints || follow.checkpoints || [];
    legs = follow.legs || [];
    ownPath = follow.my_track?.geometry || [];
    user = state.followPosition;
  } else if (v2MapContext === 'editor' && state.editorRoute) {
    paths = state.editorRoute.private_track?.geometry_segments?.length
      ? state.editorRoute.private_track.geometry_segments
      : [state.editorRoute.private_track?.cleaned_geometry || []];
    waypoints = state.editorRoute.waypoints || state.editorRoute.checkpoints || [];
    legs = state.editorRoute.legs || [];
  } else if (v2MapContext === 'record' && track) {
    paths = track.geometry_segments?.length ? track.geometry_segments : paths;
    user = state.recordPosition;
  }
  paths = paths.filter(path => Array.isArray(path) && path.length);
  return { paths, waypoints, legs, user, ownPath };
}

function mapPlot(points = [], opts = {}) {
  const data = v2MapPayload(points, opts);
  if (Array.isArray(opts.paths)) data.paths = opts.paths.filter(path => Array.isArray(path) && path.length);
  const all = data.paths.flat();
  const xs = all.map(p => Number(p[0])), ys = all.map(p => Number(p[1]));
  let minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 1;
  let minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 1;
  if (minX === maxX) { minX -= .001; maxX += .001; }
  if (minY === maxY) { minY -= .001; maxY += .001; }
  const project = point => [20 + (Number(point[0]) - minX) / (maxX - minX) * 460, 20 + (maxY - Number(point[1])) / (maxY - minY) * 210];
  const plotPaths = data.paths.map(path => {
    if (path.length < 2) return '';
    const xy = path.map(project);
    const d = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#4c8158" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const dots = data.waypoints.map((w, i) => {
    if (!all.length) return '';
    const [x, y] = project([w.longitude ?? w.lon, w.latitude ?? w.lat]);
    return `<circle cx="${x}" cy="${y}" r="10" fill="#3e704c" stroke="white" stroke-width="3"/><text x="${x}" y="${y + 3}" text-anchor="middle" fill="white" font-size="8">${i + 1}</text>`;
  }).join('');
  const first = all[0], last = all.at(-1);
  const endpoints = first && last ? [
    [first, '#df9359'], [last, '#3e704c']
  ].map(([point, color]) => { const [x, y] = project(point); return `<circle cx="${x}" cy="${y}" r="7" fill="white" stroke="${color}" stroke-width="4"/>`; }).join('') : '';
  const svg = all.length ? `<svg viewBox="0 0 500 250" preserveAspectRatio="none" aria-label="按真实 GPS 坐标绘制的轨迹示意图">${plotPaths}${dots}${endpoints}</svg>` : '';
  const label = opts.label || '轨迹坐标示意 · 非地图底图';
  const hasMap = Boolean(state.config?.amap_key);
  return `<div class="map-plot ${opts.class || ''}" data-v2-map="1" data-map-ready="0" data-private="${opts.private === true}" data-paths="${jsonAttr(data.paths)}" data-waypoints="${jsonAttr(data.waypoints)}" data-legs="${jsonAttr(data.legs)}" data-user="${jsonAttr(data.user)}" data-own-path="${jsonAttr(data.ownPath)}">${svg}<div class="v2-map-canvas"></div><span class="plot-label ${hasMap ? 'hidden' : 'warn'}">${esc(label)}${opts.demo ? ' · 演示数据' : ''}</span>${!hasMap ? '<span class="v2-map-help">未配置高德地图 Key：这里仅按真实坐标显示线稿，不提供道路底图或导航。</span>' : '<span class="map-unconfigured">正在连接地图服务…</span>'}</div>`;
}

function amapConvert(points) {
  if (!points.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => AMap.convertFrom(points, 'gps', (status, result) => {
    if (status === 'complete' && result?.locations?.length === points.length) resolve(result.locations.map(p => [p.lng, p.lat]));
    else reject(new Error(result?.info || 'GPS 坐标转换失败'));
  }));
}

async function convertPath(points) {
  const output = [];
  for (let i = 0; i < points.length; i += 40) output.push(...await amapConvert(points.slice(i, i + 40)));
  return output;
}

function scrollWaypoint(id) {
  const item = document.querySelector(`[data-waypoint-id="${CSS.escape(String(id))}"]`);
  if (!item) return;
  document.querySelectorAll('.timeline-item.is-active,.follow-step.is-active').forEach(node => node.classList.remove('is-active'));
  item.classList.add('is-active');
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function photoPopup(waypoint) {
  const photo = waypoint.photos?.[0];
  const title = waypoint.title || waypoint.name || '';
  return `<div class="map-waypoint-card">${photo ? `<img src="${esc(photo.url)}" alt="${esc(title)}现场照片">` : ''}<strong>${esc(title)}</strong><p>${esc(waypoint.description || waypoint.note || waypoint.recommended || waypoint.marker_type || waypoint.kind || '')}</p>${waypoint.recommended ? `<small>推荐：${esc(waypoint.recommended)}</small>` : ''}</div>`;
}

function installWaypointTimeline(container, waypoints, legs) {
  const rows = [...container.querySelectorAll('.timeline-item,.follow-step')];
  waypoints.forEach((waypoint, index) => {
    const row = rows[index];
    if (!row) return;
    row.dataset.waypointId = waypoint.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `地图定位到${waypoint.title || waypoint.name}`);
    const leg = legs.find(item => item.from_waypoint_id === waypoint.id) || legs[index];
    if (leg && row.classList.contains('timeline-item')) {
      const mode = document.createElement('div');
      mode.className = 'v2-leg-summary';
      const duration = leg.actual_duration_seconds ? ` · ${fmtDuration(leg.actual_duration_seconds)}` : '';
      mode.textContent = `下一段 ${modeText(leg.transport_mode)}${duration}`;
      row.querySelector('.timeline-body')?.append(mode);
    }
    row.addEventListener('click', () => {
      scrollWaypoint(waypoint.id);
      const marker = document.querySelector('.map-plot[data-v2-map="1"]')?._citytraceMarkers?.get(waypoint.id);
      if (marker) marker.emit('click', { target: marker });
    });
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } });
  });
}

async function initMapSdk() {
  if (!state.config?.amap_key) return;
  try {
    if (state.mapSdkPromise) await state.mapSdkPromise;
    else {
      window._AMapSecurityConfig = { securityJsCode: state.config.amap_security_code || '' };
      state.mapSdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.config.amap_key)}&plugin=AMap.Scale,AMap.ToolBar`;
        script.onload = resolve; script.onerror = () => reject(new Error('地图脚本加载失败'));
        document.head.append(script);
      });
      await state.mapSdkPromise;
    }
    if (!window.AMap) throw new Error('地图 SDK 未就绪');
  } catch (error) {
    $$('.v2-map-help').forEach(node => { node.textContent = `地图加载失败：${error.message}。坐标线稿仍可查看。`; node.classList.add('error'); });
    return;
  }
  for (const el of $$('.map-plot[data-v2-map="1"][data-map-ready="0"]')) {
    el.dataset.mapReady = '1';
    try {
      const paths = JSON.parse(el.dataset.paths || '[]');
      const waypoints = JSON.parse(el.dataset.waypoints || '[]');
      const user = JSON.parse(el.dataset.user || 'null');
      const ownPath = JSON.parse(el.dataset.ownPath || '[]');
      const raw = paths.flat().map(([lng, lat]) => [Number(lng), Number(lat)]);
      const waypointCoords = waypoints.map(w => [Number(w.longitude ?? w.lon), Number(w.latitude ?? w.lat)]);
      const gpsWaypoints = waypointCoords.map((point, index) => waypoints[index].coordinate_system === 'GCJ-02' ? null : point).filter(Boolean);
      const convert = await convertPath([...raw, ...gpsWaypoints]);
      const convertedPaths = [];
      let cursor = 0;
      for (const path of paths) { convertedPaths.push(convert.slice(cursor, cursor + path.length)); cursor += path.length; }
      const convertedWaypoints = [];
      let gpsWaypointIndex = cursor;
      waypoints.forEach((waypoint, index) => {
        convertedWaypoints[index] = waypoint.coordinate_system === 'GCJ-02' ? waypointCoords[index] : convert[gpsWaypointIndex++];
      });
      const overlays = [];
      const center = convertedPaths[0]?.[0] || convertedWaypoints[0] || [119.3, 26.08];
      const map = new AMap.Map(el, { zoom: 14, center, viewMode: '2D', mapStyle: 'amap://styles/whitesmoke', resizeEnable: true });
      map.addControl(new AMap.Scale()); map.addControl(new AMap.ToolBar({ position: 'RT' }));
      if (v2MapContext === 'editor') map.on('click', event => {
        if (!state.v2PickWaypoint) return;
        state.v2PickWaypoint = false;
        const lat = document.querySelector('#cp-lat'), lon = document.querySelector('#cp-lon');
        if (lat && lon) { lat.value = event.lnglat.lat; lon.value = event.lnglat.lng; state.cpLocationSource = 'manual'; state.cpCoordinateSystem = 'GCJ-02'; toast('已选地图位置；保存时会注明为手动补充'); }
      });
      convertedPaths.forEach((path, index) => {
        if (!path.length) return;
        const line = new AMap.Polyline({ path, strokeColor: index ? '#7c9a79' : '#458258', strokeWeight: 5, strokeOpacity: .92, lineJoin: 'round', lineCap: 'round' });
        map.add(line); overlays.push(line);
      });
      const markerMap = new Map();
      waypoints.forEach((waypoint, index) => {
        const pos = convertedWaypoints[index]; if (!pos) return;
        const marker = new AMap.Marker({ position: pos, content: `<div class="v2-waypoint-marker">${index + 1}</div>`, offset: new AMap.Pixel(-13, -13), title: waypoint.title || waypoint.name });
        marker.on('click', () => { scrollWaypoint(waypoint.id); new AMap.InfoWindow({ content: photoPopup(waypoint), offset: new AMap.Pixel(0, -12) }).open(map, pos); });
        map.add(marker); overlays.push(marker); markerMap.set(waypoint.id, marker);
      });
      if (ownPath.length > 1) {
        const own = await convertPath(ownPath.map(([lng, lat]) => [Number(lng), Number(lat)]));
        const line = new AMap.Polyline({ path: own, strokeColor: '#3979bf', strokeWeight: 4, strokeOpacity: .85, lineJoin: 'round' });
        map.add(line); overlays.push(line);
      }
      let userMarker = null;
      if (user?.lat && user?.lon) {
        const [position] = await convertPath([[Number(user.lon), Number(user.lat)]]);
        userMarker = new AMap.Marker({ position, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '我的当前位置' });
        map.add(userMarker); overlays.push(userMarker);
      }
      if (overlays.length) map.setFitView(overlays, false, [36, 36, 36, 36]);
      el._citytraceMap = map; el._citytraceMarkers = markerMap; el._citytraceUserMarker = userMarker;
      el.classList.add('has-real-map');
      el.querySelector(':scope > svg')?.remove();
      el.querySelector('.plot-label')?.classList.add('hidden');
      el.querySelector('.map-unconfigured')?.classList.add('hidden');
      el.querySelector('.v2-map-help')?.classList.add('hidden');
    } catch (error) {
      console.warn('CityTrace map render failed', error);
      el.querySelector('.v2-map-help')?.classList.remove('hidden');
    }
  }
}
function mountMaps() { initMapSdk(); }

async function routeDetail(id) {
  v2MapContext = 'route';
  await legacyRouteDetailV2(id);
  const route = state.route;
  if (!route || !document.querySelector('.detail-map')) return;
  installWaypointTimeline(document.querySelector('#app'), route.waypoints || route.checkpoints || [], route.legs || []);
  document.querySelectorAll('.photo-thumb').forEach(img => img.dataset.lightbox = '1');
  document.querySelector('.detail-map')?.classList.add('v2-route-map');
  document.querySelector('.route-detail-actions')?.classList.add('v2-top-actions');
  const infoPanel = document.querySelector('.detail-aside .panel');
  const oldLegList = infoPanel?.querySelector('div[style*="margin-top"]');
  if (oldLegList) oldLegList.innerHTML = (route.legs || []).map(leg => `<div class="leg-item"><span>${esc(leg.start_label)} → ${esc(leg.end_label)}</span><strong class="leg-mode">${modeText(leg.transport_mode)}${leg.actual_duration_seconds ? ` · ${fmtDuration(leg.actual_duration_seconds)}` : ''}</strong></div>`).join('') || '<div class="field-hint">作者还没有设置交通路段</div>';
  const topFollow = document.querySelector('#start-follow');
  if (topFollow) {
    topFollow.hidden = route.status !== 'published';
    topFollow.onclick = () => createFollow(route.id);
  }
  if (route.status === 'published') installRouteActionBar(route);
}

function installRouteActionBar(route) {
  document.querySelector('.v2-route-actions')?.remove();
  const bar = document.createElement('div'); bar.className = 'v2-route-actions';
  bar.innerHTML = `<button class="button button-outline" data-v2-favorite>${route.favorite ? '♥ 已收藏' : '♡ 收藏路线'}</button><button class="button button-green" data-v2-follow>↗ 开始复刻</button>`;
  document.body.append(bar);
  bar.querySelector('[data-v2-favorite]').onclick = async () => {
    if (!state.me) { openAuth(); return; }
    try { await api(`/routes/${route.id}/favorite`, { method: route.favorite ? 'DELETE' : 'POST' }); await routeDetail(route.id); toast(route.favorite ? '已取消收藏' : '已收藏'); }
    catch (error) { toast(error.message, 'error'); }
  };
  bar.querySelector('[data-v2-follow]').onclick = () => createFollow(route.id);
}

async function createFollow(routeId) {
  if (!state.me) { openAuth(); return; }
  try {
    const session = await api(`/routes/${routeId}/follow`, { method: 'POST', body: {} });
    state.followPosition = null;
    try { startFollowGps(session.id); } catch (error) { state.followGpsMessage = error.message; }
    toast('复刻行程已创建，路线版本已固定'); navigate(`follow/${session.id}`);
  } catch (error) { toast(error.message, 'error'); }
}

function startFollowGps(id) {
  if (!navigator.geolocation) { state.followGpsMessage = '此浏览器不支持定位；你仍可手动按站点复刻。'; return; }
  if (followWatchId !== null) navigator.geolocation.clearWatch(followWatchId);
  state.followId = id;
  followWatchId = navigator.geolocation.watchPosition(position => {
    const previous = state.v2PreviousFollowPosition;
    state.followPosition = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, ts: position.timestamp || Date.now() };
    state.followGpsMessage = '';
    const note = document.querySelector('.v2-follow-location');
    if (note) note.textContent = `当前位置精度约 ${Math.round(state.followPosition.accuracy)} 米，蓝色线表示本次复刻记录。`;
    const map = document.querySelector('.follow-map');
    if (map?._citytraceMap) {
      convertPath([[state.followPosition.lon, state.followPosition.lat]]).then(([point]) => {
        if (map._citytraceUserMarker) map._citytraceUserMarker.setPosition(point);
        else { map._citytraceUserMarker = new AMap.Marker({ position: point, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '我的当前位置' }); map._citytraceMap.add(map._citytraceUserMarker); }
      }).catch(() => {});
      if (previous && previous.accuracy <= 100 && state.followPosition.accuracy <= 100) {
        const seconds = (state.followPosition.ts - previous.ts) / 1000, distance = safeDistanceMeters(previous, state.followPosition);
        if (seconds > 0 && seconds <= 30 && distance / seconds <= 9 && distance >= 2) {
          convertPath([[previous.lon, previous.lat], [state.followPosition.lon, state.followPosition.lat]]).then(path => {
            map._citytraceMap.add(new AMap.Polyline({ path, strokeColor: '#3979bf', strokeWeight: 4, strokeOpacity: .9, lineJoin: 'round' }));
          }).catch(() => {});
        }
      }
    }
    state.v2PreviousFollowPosition = state.followPosition;
    queueFollowPoint(id, state.followPosition);
  }, error => {
    state.followGpsMessage = error.code === 1 ? '定位权限未开启；可以继续手动确认站点。' : '暂时无法定位；可以继续手动确认站点。';
    const note = document.querySelector('.v2-follow-location'); if (note) note.textContent = state.followGpsMessage;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

function queueFollowPoint(id, position) {
  const key = `citytrace_follow_queue_${id}`;
  let queue = []; try { queue = JSON.parse(localStorage.getItem(key) || '[]'); } catch { queue = []; }
  const ts = Date.now();
  queue.push({ client_id: `${id}-${ts}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`, lat: position.lat, lon: position.lon, accuracy: position.accuracy, ts });
  localStorage.setItem(key, JSON.stringify(queue.slice(-1500)));
  flushFollowQueue(id);
}

async function flushFollowQueue(id) {
  if (followFlushBusy || !navigator.onLine) return;
  const key = `citytrace_follow_queue_${id}`;
  let queue = []; try { queue = JSON.parse(localStorage.getItem(key) || '[]'); } catch { return; }
  if (!queue.length) return;
  followFlushBusy = true;
  try {
    await api(`/follow-sessions/${id}/points`, { method: 'POST', body: { samples: queue.slice(0, 300) } });
    localStorage.setItem(key, JSON.stringify(queue.slice(300)));
  } catch { /* Keep samples locally; retry on the next position or online event. */ }
  finally { followFlushBusy = false; }
}
window.addEventListener('online', () => { if (state.followId) flushFollowQueue(state.followId); });

async function followPage(id) {
  v2MapContext = 'follow';
  await legacyFollowPageV2(id);
  const follow = state.follow;
  if (!follow || !document.querySelector('.follow-map')) return;
  installWaypointTimeline(document.querySelector('#app'), follow.waypoints || follow.checkpoints || [], follow.legs || []);
  const next = follow.checkpoints.find(point => !point.arrived_at);
  const targetPanel = document.querySelector('.follow-hero .editor-stack .panel');
  if (next && targetPanel && next.photos?.length) {
    const image = document.createElement('img'); image.className = 'follow-target-photo'; image.src = next.photos[0].url; image.alt = `${next.name}现场参考照片`; image.dataset.lightbox = '1';
    targetPanel.insertBefore(image, targetPanel.querySelector('strong'));
  }
  if (next && targetPanel) {
    const leg = (follow.legs || []).find(item => item.from_waypoint_id === next.id);
    const oldMode = [...targetPanel.querySelectorAll('.leg-item')].find(item => item.firstElementChild?.textContent.includes('本段交通方式'));
    if (leg && oldMode) oldMode.lastElementChild.textContent = `${modeText(leg.transport_mode)}${leg.actual_duration_seconds ? ` · ${fmtDuration(leg.actual_duration_seconds)}` : ''}`;
    else if (!leg && oldMode) oldMode.remove();
  }
  const notice = document.createElement('div'); notice.className = 'v2-follow-location';
  notice.textContent = state.followGpsMessage || (state.followPosition ? `当前位置精度约 ${Math.round(state.followPosition.accuracy)} 米，蓝色线表示本次复刻记录。` : '当前位置尚未开启；允许定位后会显示当前位置并独立记录本次复刻轨迹。');
  document.querySelector('.follow-map')?.after(notice);
  if (follow.status !== 'active' && followWatchId !== null) { navigator.geolocation.clearWatch(followWatchId); followWatchId = null; }
  const locate = document.querySelector('#locate-follow');
  if (locate) locate.onclick = () => startFollowGps(id);
  const pause = document.querySelector('#follow-pause');
  if (pause) pause.addEventListener('click', () => { if (followWatchId !== null) navigator.geolocation.clearWatch(followWatchId); followWatchId = null; }, { capture: true, once: true });
  const finish = document.querySelector('#follow-finish');
  if (finish) finish.addEventListener('click', () => { if (followWatchId !== null) navigator.geolocation.clearWatch(followWatchId); followWatchId = null; }, { capture: true, once: true });
}

function renderEditor(route) {
  state.editorRoute = route;
  v2MapContext = 'editor';
  legacyEditorV2(route);
  enhanceEditor(route);
}

function safeDistanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function updateLiveTrackMap(position) {
  const el = document.querySelector('.record-map[data-v2-map="1"]');
  if (!el) return;
  if (el._citytraceMap && window.AMap) {
    convertPath([[position.lon, position.lat]]).then(([point]) => {
      if (el._citytraceUserMarker) el._citytraceUserMarker.setPosition(point);
      else { el._citytraceUserMarker = new AMap.Marker({ position: point, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '当前位置' }); el._citytraceMap.add(el._citytraceUserMarker); }
      const previous = state.v2PreviousTrackPosition;
      if (previous && position.accuracy <= 100 && previous.accuracy <= 100) {
        const elapsed = (position.ts - previous.ts) / 1000, distance = safeDistanceMeters(previous, position);
        if (elapsed > 0 && elapsed <= 30 && distance / elapsed <= 9 && distance >= 2) {
          convertPath([[previous.lon, previous.lat], [position.lon, position.lat]]).then(path => {
            const line = new AMap.Polyline({ path, strokeColor: '#458258', strokeWeight: 5, strokeOpacity: .95, lineJoin: 'round' });
            el._citytraceMap.add(line);
          }).catch(() => {});
        }
      }
      state.v2PreviousTrackPosition = position;
    }).catch(() => {});
    return;
  }
  const samples = [...(state.track?.points || []), ...state.queue.filter(point => point.track_id === state.track?.id)]
    .filter(point => Number(point.accuracy) <= 100).sort((a, b) => a.ts - b.ts);
  if (!samples.length) samples.push({ ...position, ts: position.ts });
  const xs = samples.map(point => Number(point.lon)), ys = samples.map(point => Number(point.lat));
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minX === maxX) { minX -= .001; maxX += .001; }
  if (minY === maxY) { minY -= .001; maxY += .001; }
  const xy = samples.map(point => [20 + (point.lon - minX) / (maxX - minX) * 460, 20 + (maxY - point.lat) / (maxY - minY) * 210]);
  const d = xy.map((point, index) => `${index ? 'L' : 'M'}${point[0]} ${point[1]}`).join(' ');
  let svg = el.querySelector(':scope > svg');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 500 250'); el.prepend(svg); }
  svg.innerHTML = d ? `<path d="${d}" fill="none" stroke="#4c8158" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` : '';
}

const originalEnqueueFixV2 = window.enqueueFix;
if (originalEnqueueFixV2) window.enqueueFix = function (position) {
  state.recordPosition = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy };
  originalEnqueueFixV2(position);
  state.recordPosition.ts = position.timestamp || Date.now();
  updateLiveTrackMap(state.recordPosition);
};

const originalRecordPathV2 = window.recordPath;
if (originalRecordPathV2) window.recordPath = function () {
  const id = state.track?.id;
  const samples = [...(state.track?.points || []), ...state.queue.filter(point => point.track_id === id)]
    .filter(point => Number(point.accuracy) <= 100).sort((a, b) => a.ts - b.ts);
  return samples.map(point => [point.lon, point.lat]);
};

const originalFlushQueueV2 = window.flushQueue;
if (originalFlushQueueV2) window.flushQueue = async function () {
  const id = state.track?.id;
  const sent = await originalFlushQueueV2();
  if (sent && id && state.track?.id === id) {
    try { state.track = await api(`/tracks/${id}`); } catch { /* Keep the last known local view. */ }
  }
  return sent;
};

function enhanceEditor(route) {
  const legacyPanel = [...document.querySelectorAll('.editor-stack .panel')].find(panel => panel.querySelector('h2')?.textContent.trim() === '交通路段');
  if (!legacyPanel) return;
  const legs = route.legs || [];
  const rows = legs.map((leg, index) => `<div class="v2-leg-editor" data-leg="${esc(leg.id)}"><div class="v2-leg-heading"><strong>${esc(leg.start_label)} → ${esc(leg.end_label)}</strong><span>第 ${index + 1} 段</span></div><div class="form-grid"><label class="field"><span>交通方式</span><select data-leg-mode>${V2_MODES.map(([value, label]) => `<option value="${value}" ${leg.transport_mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>实际用时（分钟，可选）</span><input data-leg-duration type="number" min="0" value="${leg.actual_duration_seconds == null ? '' : Math.round(leg.actual_duration_seconds / 60)}"></label><label class="field full"><span>线路或站点说明</span><input data-leg-line maxlength="300" value="${esc(leg.line_info || '')}" placeholder="例如：地铁 1 号线，东街口站至南门兜站"></label><label class="field full"><span>备注</span><textarea data-leg-notes maxlength="1000">${esc(leg.notes || '')}</textarea></label></div><div class="form-actions"><button class="button button-outline button-small" data-save-leg>保存本段方式</button>${!leg.mode_confirmed ? '<span class="field-hint">此段需要作者确认</span>' : ''}</div></div>`).join('');
  legacyPanel.innerHTML = `<div class="panel-heading"><h2>相邻标记点之间的交通</h2><small>${legs.length} 段 · 不修改 GPS 原始轨迹</small></div>${rows || '<p class="field-hint">添加两个或更多标记点后，这里会自动生成相邻路段。</p>'}<div class="v2-map-pick"><button class="button button-outline button-small" type="button" id="v2-pick-waypoint">⌖ 在轨迹地图上选点</button><span class="field-hint">地图选点会标记为手动补充位置，不会伪装成 GPS 样本。</span></div>`;
  let currentVersion = route.version;
  legacyPanel.querySelectorAll('[data-save-leg]').forEach(button => button.onclick = async () => {
    const row = button.closest('[data-leg]');
    try {
      const duration = row.querySelector('[data-leg-duration]').value;
      await api(`/legs/${row.dataset.leg}`, { method: 'PATCH', body: {
        transport_mode: row.querySelector('[data-leg-mode]').value,
        actual_duration_seconds: duration === '' ? null : Number(duration) * 60,
        line_info: row.querySelector('[data-leg-line]').value,
        notes: row.querySelector('[data-leg-notes]').value,
        expected_version: currentVersion
      } });
      const fresh = await api(`/routes/${route.id}`); currentVersion = fresh.version;
      toast('交通方式已保存'); editor(route.id);
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-edit-cp]').forEach(button => {
    const cp = (route.waypoints || route.checkpoints || []).find(point => point.id === button.dataset.editCp);
    if (!cp) return;
    button.addEventListener('click', () => { state.cpCoordinateSystem = cp.coordinate_system || 'WGS84'; }, { capture: true });
  });
  document.querySelectorAll('[data-photo-checkpoint]').forEach(input => {
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      try {
        for (const file of files) await api(`/routes/${route.id}/photos`, { method: 'POST', body: { checkpoint_id: input.dataset.photoCheckpoint, data_url: await fileData(file), kind: 'checkpoint' } });
        toast(`${files.length} 张现场照片已上传`); editor(route.id);
      } catch (error) { toast(error.message, 'error'); }
    };
  });
  const pick = document.querySelector('#v2-pick-waypoint');
  if (pick) pick.onclick = () => {
    if (!document.querySelector('.record-map')?._citytraceMap) { toast('需要先配置可用地图 Key，或直接在经纬度框中填写位置'); return; }
    state.v2PickWaypoint = true;
    toast('点击右侧轨迹地图，选择标记点位置');
  };
  document.querySelectorAll('.editor-stack .panel .list-row').forEach(row => {
    const id = row.querySelector('[data-edit-cp]')?.dataset.editCp;
    if (!id) return;
    const controls = document.createElement('span'); controls.className = 'v2-sort-controls';
    controls.innerHTML = `<button type="button" aria-label="上移标记点" data-move="up">↑</button><button type="button" aria-label="下移标记点" data-move="down">↓</button>`;
    row.append(controls);
    controls.querySelectorAll('[data-move]').forEach(button => button.onclick = async () => {
      const points = [...(route.waypoints || route.checkpoints || [])].sort((a, b) => a.order_index - b.order_index);
      const from = points.findIndex(point => point.id === id), to = from + (button.dataset.move === 'up' ? -1 : 1);
      if (to < 0 || to >= points.length) return;
      [points[from], points[to]] = [points[to], points[from]];
      try { await api(`/routes/${route.id}/waypoints/order`, { method: 'PATCH', body: { waypoint_ids: points.map(point => point.id), expected_version: route.version } }); editor(route.id); }
      catch (error) { toast(error.message, 'error'); }
    });
  });
}

const oldBindEditorV2 = window.bindEditor;
if (oldBindEditorV2) {
  window.bindEditor = function (route) {
    oldBindEditorV2(route);
    const add = document.querySelector('#add-checkpoint');
    if (add) add.addEventListener('click', () => { state.cpCoordinateSystem ||= 'WGS84'; }, { capture: true });
  };
}

const originalFollowActionV2 = window.followAction;
window.followAction = async function (id, action) {
  await originalFollowActionV2(id, action);
  if (action === 'resume' && state.follow?.status === 'active') startFollowGps(id);
  if (action === 'finish' && followWatchId !== null) { navigator.geolocation.clearWatch(followWatchId); followWatchId = null; }
};

window.addEventListener('click', event => {
  const photo = event.target.closest('img[data-lightbox], .photo-thumb');
  if (!photo) return;
  const scrim = document.createElement('div'); scrim.className = 'v2-lightbox';
  scrim.innerHTML = `<button type="button" aria-label="关闭图片">×</button><img src="${esc(photo.src)}" alt="${esc(photo.alt || '路线照片')}">`;
  scrim.onclick = () => scrim.remove(); document.body.append(scrim);
});

window.routeDetail = routeDetail;
window.renderEditor = renderEditor;
window.followPage = followPage;
if (legacyMapPageV2) window.mapPage = function () { v2MapContext = 'map'; return legacyMapPageV2(); };
if (legacyRecordPageV2) window.renderRecord = function () {
  v2MapContext = 'record';
  legacyRecordPageV2();
  if (!state.track) {
    const map = document.querySelector('.record-map');
    map?.querySelector('svg')?.remove();
    if (map) map.insertAdjacentHTML('afterbegin', '<div class="v2-empty-map">开始真实 GPS 记录后，轨迹会显示在这里。</div>');
  }
};
