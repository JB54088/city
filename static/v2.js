/* CityTrace V2 interaction layer. Loaded after app.js to keep the existing MVP shell. */
const legacyRouteDetailV2 = window.routeDetailLegacy;
const legacyEditorV2 = window.renderEditorLegacy;
const legacyFollowPageV2 = window.followPageLegacy;
const legacyRecordPageV2 = window.renderRecord;
const legacyMapPageV2 = window.mapPage;
let v2MapContext = '';
let followWatchId = null;
let followWatchSession = null;
let followGpsGeneration = 0;
let followCreating = false;
let followActionBusy = false;
const followFlushes = new Map();
const followMemoryQueues = new Map();
const followStorageBlocked = new Set();
let v2EditorId = null;
let v2EditorRefresh = 0;
let closeV2Lightbox = null;

const V2_MODES = [
  ['walking', '🚶 步行'], ['subway', '🚇 地铁'], ['bus', '🚌 公交'],
  ['cycling', '🚲 骑行'], ['taxi', '🚕 打车'], ['driving', '🚗 自驾'], ['other', '↗ 其他']
];
const modeText = value => V2_MODES.find(([key]) => key === value)?.[1] || '↗ 其他';
const jsonAttr = value => esc(JSON.stringify(value ?? []));
const validMapPoint = point => Array.isArray(point) && point.length >= 2 && point[0] != null && point[1] != null && point[0] !== '' && point[1] !== '' && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) && Math.abs(Number(point[0])) <= 180 && Math.abs(Number(point[1])) <= 90;
const cleanMapPath = path => Array.isArray(path) ? path.filter(validMapPoint).map(point => [Number(point[0]), Number(point[1])]) : [];
const currentV2Path = () => location.hash.replace(/^#\/?/, '');

function cleanupV2Page() {
  document.querySelector('.v2-route-actions')?.remove();
  document.body.classList.remove('has-route-actions');
  closeV2Lightbox?.();
  document.querySelectorAll('.map-plot[data-v2-map]').forEach(el => {
    el.dataset.mapDisposed = '1';
    el._citytraceMap?.destroy();
    el._citytraceMap = null;
  });
  state.v2PickWaypoint = false;
  if (followWatchSession && currentV2Path() !== `follow/${followWatchSession}`) stopFollowGps();
}
window.cleanupV2Page = cleanupV2Page;
window.addEventListener('hashchange', () => {
  if (followWatchSession && currentV2Path() !== `follow/${followWatchSession}`) stopFollowGps();
});
window.addEventListener('pagehide', () => stopFollowGps());

function v2MapPayload(points, opts) {
  const route = state.route;
  const follow = state.follow;
  const track = state.track;
  let paths = Array.isArray(points) && points.length ? [points] : [];
  let waypoints = [];
  let legs = [];
  let user = null;
  let ownPath = [];
  const classes = (opts.class || '').split(/\s+/);
  const context = opts.compact ? '' : classes.includes('follow-map') ? 'follow' : classes.includes('record-map') ? (currentV2Path().startsWith('edit/') ? 'editor' : 'record') : classes.includes('detail-map') ? v2MapContext : '';
  if (context === 'route' && route) {
    const privateView = opts.private === true && route.private_track;
    paths = privateView
      ? (route.private_track.geometry_segments?.length ? route.private_track.geometry_segments : [route.private_track.cleaned_geometry || []])
      : (route.geometry_segments?.length ? route.geometry_segments : paths);
    waypoints = route.waypoints || route.checkpoints || [];
    legs = route.legs || [];
  } else if (context === 'follow' && follow) {
    paths = follow.geometry_segments?.length ? follow.geometry_segments : paths;
    waypoints = follow.waypoints || follow.checkpoints || [];
    legs = follow.legs || [];
    ownPath = follow.my_track?.geometry || [];
    user = state.followPosition;
  } else if (context === 'editor' && state.editorRoute) {
    paths = state.editorRoute.private_track?.geometry_segments?.length
      ? state.editorRoute.private_track.geometry_segments
      : [state.editorRoute.private_track?.cleaned_geometry || []];
    waypoints = state.editorRoute.waypoints || state.editorRoute.checkpoints || [];
    legs = state.editorRoute.legs || [];
  } else if (context === 'record' && track) {
    paths = track.geometry_segments?.length ? track.geometry_segments : paths;
    user = state.recordPosition;
  }
  paths = paths.map(cleanMapPath).filter(path => path.length);
  waypoints = waypoints.filter(point => validMapPoint([point.longitude ?? point.lon, point.latitude ?? point.lat]));
  ownPath = cleanMapPath(ownPath);
  const ownPaths = context === 'follow' ? [ownPath, ...(state.v2FollowLivePaths || [])].filter(path => path.length) : [];
  return { paths, waypoints, legs, user, ownPath, ownPaths, context };
}

function mapPlot(points = [], opts = {}) {
  const data = v2MapPayload(points, opts);
  if (Array.isArray(opts.paths)) data.paths = opts.paths.map(cleanMapPath).filter(path => path.length);
  const all = data.paths.flat();
  const bounds = [...all, ...data.ownPaths.flat(), ...data.waypoints.map(point => [Number(point.longitude ?? point.lon), Number(point.latitude ?? point.lat)]), ...(data.user && validMapPoint([data.user.lon, data.user.lat]) ? [[Number(data.user.lon), Number(data.user.lat)]] : [])];
  const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]);
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
  const ownPlots = data.ownPaths.map(path => {
    if (path.length < 2) return '';
    const d = path.map(project).map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="#3979bf" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  let userDot = '';
  if (data.user && validMapPoint([data.user.lon, data.user.lat])) {
    const [x, y] = project([data.user.lon, data.user.lat]);
    userDot = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#3979bf" stroke="white" stroke-width="3"/>`;
  }
  const dots = data.waypoints.map((w, i) => {
    if (!bounds.length) return '';
    const [x, y] = project([w.longitude ?? w.lon, w.latitude ?? w.lat]);
    return `<circle cx="${x}" cy="${y}" r="10" fill="#3e704c" stroke="white" stroke-width="3"/><text x="${x}" y="${y + 3}" text-anchor="middle" fill="white" font-size="8">${i + 1}</text>`;
  }).join('');
  const first = all[0], last = all.at(-1);
  const endpoints = first && last ? [
    [first, '#df9359'], [last, '#3e704c']
  ].map(([point, color]) => { const [x, y] = project(point); return `<circle cx="${x}" cy="${y}" r="7" fill="white" stroke="${color}" stroke-width="4"/>`; }).join('') : '';
  const svg = bounds.length ? `<svg viewBox="0 0 500 250" preserveAspectRatio="none" role="img" aria-label="按真实坐标绘制的轨迹示意图">${plotPaths}${ownPlots}${dots}${endpoints}${userDot}</svg>` : '';
  const label = opts.label || '轨迹坐标示意 · 非地图底图';
  const hasMap = Boolean(state.config?.amap_key);
  if (opts.compact) return `<div class="map-plot ${opts.class || ''}">${svg}<span class="plot-label warn">轨迹坐标示意${opts.demo ? ' · 演示数据' : ''}</span></div>`;
  return `<div class="map-plot ${opts.class || ''}" data-v2-map="1" data-map-context="${data.context}" data-map-ready="0" data-private="${opts.private === true}" data-paths="${jsonAttr(data.paths)}" data-waypoints="${jsonAttr(data.waypoints)}" data-legs="${jsonAttr(data.legs)}" data-user="${jsonAttr(data.user)}" data-own-path="${jsonAttr(data.ownPath)}">${svg}<div class="v2-map-canvas"></div><span class="plot-label warn">${esc(label)}${opts.demo ? ' · 演示数据' : ''}</span><span class="v2-map-help" role="status">${hasMap ? '正在连接地图服务，当前显示坐标示意…' : '当前显示轨迹坐标示意。道路底图暂未启用，可从站点打开外部地图。'}</span></div>`;
}

function amapConvert(points) {
  if (!points.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('坐标转换超时')), 12000);
    AMap.convertFrom(points, 'gps', (status, result) => {
      clearTimeout(timer);
      if (status === 'complete' && result?.locations?.length === points.length) resolve(result.locations.map(p => [p.lng, p.lat]));
      else reject(new Error(result?.info || 'GPS 坐标转换失败'));
    });
  });
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
    row.addEventListener('click', event => {
      if (event.target.closest('button,a,input,img')) return;
      scrollWaypoint(waypoint.id);
      const marker = document.querySelector('.map-plot[data-v2-map="1"]')?._citytraceMarkers?.get(waypoint.id);
      if (marker) marker.emit('click', { target: marker });
    });
    row.addEventListener('keydown', event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); row.click(); } });
  });
}

function showV2MapFailure(el, message) {
  if (!el.isConnected || el.dataset.mapDisposed === '1') return;
  el.dataset.mapReady = 'error';
  el._citytraceMap?.destroy();
  el._citytraceMap = null;
  el.classList.remove('has-real-map');
  el.querySelector('.plot-label')?.classList.remove('hidden');
  const help = el.querySelector('.v2-map-help');
  if (help) {
    help.classList.remove('hidden');
    help.classList.add('error');
    help.textContent = `${message}。当前仍可查看轨迹坐标示意。`;
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'v2-map-retry'; retry.textContent = '重试地图';
    retry.onclick = event => {
      event.stopPropagation();
      el.dataset.mapReady = '0';
      help.textContent = '正在重新连接地图服务…';
      help.classList.remove('error');
      initMapSdk();
    };
    help.append(' ', retry);
  }
}

async function initMapSdk() {
  if (!state.config?.amap_key) return;
  const pending = $$('.map-plot[data-v2-map="1"][data-map-ready="0"]');
  if (!pending.length) return;
  pending.forEach(el => { el.dataset.mapReady = 'loading'; });
  try {
    if (!window.AMap && !state.mapSdkPromise) {
      window._AMapSecurityConfig = { securityJsCode: state.config.amap_security_code || '' };
      state.mapSdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => { script.remove(); reject(new Error('地图服务连接超时')); }, 15000);
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.config.amap_key)}&plugin=AMap.Scale,AMap.ToolBar`;
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('地图服务暂时无法连接')); };
        document.head.append(script);
      });
    }
    if (state.mapSdkPromise) await state.mapSdkPromise;
    if (!window.AMap) throw new Error('地图服务未就绪');
  } catch (error) {
    state.mapSdkPromise = null;
    pending.forEach(el => showV2MapFailure(el, error.message));
    return;
  }
  for (const el of pending) {
    if (!el.isConnected || el.dataset.mapDisposed === '1') continue;
    try {
      const paths = JSON.parse(el.dataset.paths || '[]');
      const waypoints = JSON.parse(el.dataset.waypoints || '[]');
      const user = JSON.parse(el.dataset.user || 'null');
      const ownPath = JSON.parse(el.dataset.ownPath || '[]');
      const raw = paths.flat();
      const waypointCoords = waypoints.map(w => [Number(w.longitude ?? w.lon), Number(w.latitude ?? w.lat)]);
      const gpsWaypoints = waypointCoords.filter((point, index) => waypoints[index].coordinate_system !== 'GCJ-02');
      const convert = await convertPath([...raw, ...gpsWaypoints, ...ownPath, ...(user && validMapPoint([user.lon, user.lat]) ? [[user.lon, user.lat]] : [])]);
      if (!el.isConnected || el.dataset.mapDisposed === '1') continue;
      const convertedPaths = [];
      let cursor = 0;
      for (const path of paths) { convertedPaths.push(convert.slice(cursor, cursor + path.length)); cursor += path.length; }
      const convertedWaypoints = waypoints.map((waypoint, index) => waypoint.coordinate_system === 'GCJ-02' ? waypointCoords[index] : convert[cursor++]);
      const convertedOwn = convert.slice(cursor, cursor + ownPath.length); cursor += ownPath.length;
      const userPosition = convert[cursor];
      const overlays = [];
      const trackLines = [];
      const center = convertedPaths[0]?.[0] || convertedWaypoints[0] || userPosition || [119.3, 26.08];
      const map = new AMap.Map(el.querySelector('.v2-map-canvas'), { zoom: 14, center, viewMode: '2D', mapStyle: 'amap://styles/whitesmoke', resizeEnable: true });
      el._citytraceMap = map;
      map.on?.('error', () => showV2MapFailure(el, '地图底图加载失败，请检查网络或地图服务配置'));
      map.addControl(new AMap.Scale()); map.addControl(new AMap.ToolBar({ position: 'RT' }));
      if (el.dataset.mapContext === 'editor') map.on('click', event => {
        if (!state.v2PickWaypoint) return;
        state.v2PickWaypoint = false;
        const lat = document.querySelector('#cp-lat'), lon = document.querySelector('#cp-lon');
        if (lat && lon) {
          lat.value = event.lnglat.lat; lon.value = event.lnglat.lng;
          state.cpLocationSource = 'manual'; state.cpCoordinateSystem = 'GCJ-02';
          updateEditorLocationStatus('已选地图位置，保存后注明为手动补充');
          document.querySelector('#cp-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          toast('已选地图位置，请补充打卡名称后保存');
        }
      });
      convertedPaths.forEach((path, index) => {
        if (path.length < 2) return;
        const line = new AMap.Polyline({ path, strokeColor: index ? '#7c9a79' : '#458258', strokeWeight: 5, strokeOpacity: .92, lineJoin: 'round', lineCap: 'round' });
        map.add(line); overlays.push(line); trackLines.push(line);
      });
      const markerMap = new Map();
      waypoints.forEach((waypoint, index) => {
        const pos = convertedWaypoints[index]; if (!pos) return;
        const marker = new AMap.Marker({ position: pos, content: `<div class="v2-waypoint-marker">${index + 1}</div>`, offset: new AMap.Pixel(-13, -13), title: waypoint.title || waypoint.name });
        marker.on('click', () => { scrollWaypoint(waypoint.id); new AMap.InfoWindow({ content: photoPopup(waypoint), offset: new AMap.Pixel(0, -12) }).open(map, pos); });
        map.add(marker); overlays.push(marker); markerMap.set(waypoint.id, marker);
      });
      if (convertedOwn.length > 1) {
        const line = new AMap.Polyline({ path: convertedOwn, strokeColor: '#3979bf', strokeWeight: 4, strokeOpacity: .85, lineJoin: 'round' });
        map.add(line); overlays.push(line);
      }
      let userMarker = null;
      if (userPosition) {
        userMarker = new AMap.Marker({ position: userPosition, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '我的当前位置' });
        map.add(userMarker); overlays.push(userMarker);
      }
      if (overlays.length) map.setFitView(overlays, false, [36, 36, 36, 36]);
      el._citytraceMarkers = markerMap; el._citytraceUserMarker = userMarker;
      if (el.dataset.mapContext === 'record') el._citytraceTrackLines = trackLines;
      el.dataset.mapReady = '1';
      el.classList.add('has-real-map');
      el.querySelector('.plot-label')?.classList.add('hidden');
      el.querySelector('.v2-map-help')?.classList.add('hidden');
      if (el.dataset.mapContext === 'record') refreshRecordMapV2();
    } catch (error) {
      showV2MapFailure(el, error.message || '地图加载失败');
    }
  }
}
function mountMaps() { initMapSdk(); }

async function routeDetail(id) {
  const view = state.viewToken;
  v2MapContext = 'route';
  await legacyRouteDetailV2(id);
  const route = state.route;
  if (view !== state.viewToken || currentV2Path() !== `route/${id}` || !route || route.id !== id || !document.querySelector('.detail-map')) return;
  installWaypointTimeline(document.querySelector('#app'), route.waypoints || route.checkpoints || [], route.legs || []);
  makeV2PhotosAccessible();
  document.querySelector('.detail-map')?.classList.add('v2-route-map');
  document.querySelector('.route-detail-actions')?.classList.add('v2-top-actions');
  const infoPanel = document.querySelector('.detail-aside .panel');
  const oldLegList = infoPanel?.querySelector('div[style*="margin-top"]');
  if (oldLegList) oldLegList.innerHTML = (route.legs || []).map(leg => `<div class="leg-item"><span>${esc(leg.start_label)} → ${esc(leg.end_label)}</span><strong class="leg-mode">${modeText(leg.transport_mode)}${leg.actual_duration_seconds ? ` · ${fmtDuration(leg.actual_duration_seconds)}` : ''}</strong></div>`).join('') || '<div class="field-hint">作者还没有设置交通路段</div>';
  const topFollow = document.querySelector('#start-follow');
  const favorite = document.querySelector('#detail-favorite');
  if (favorite) favorite.hidden = route.status !== 'published';
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
  document.body.classList.add('has-route-actions');
  bar.setAttribute('aria-label', '路线操作');
  bar.querySelectorAll('button').forEach(button => { button.type = 'button'; });
  bar.querySelector('[data-v2-favorite]').onclick = async () => {
    const favorite = document.querySelector('#detail-favorite');
    if (favorite && !favorite.disabled) favorite.click();
  };
  bar.querySelector('[data-v2-follow]').onclick = () => createFollow(route.id);
}

async function createFollow(routeId) {
  if (!state.me) { openAuth(); return; }
  if (followCreating) return;
  followCreating = true;
  const buttons = document.querySelectorAll('#start-follow,[data-v2-follow]');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const session = await api(`/routes/${routeId}/follow`, { method: 'POST', body: {} });
    stopFollowGps();
    state.followPosition = null;
    state.followGpsMessage = '';
    state.followGpsRequestedId = session.id;
    toast('复刻行程已创建，路线版本已固定'); navigate(`follow/${session.id}`);
  } catch (error) { toast(error.message, 'error'); }
  finally { followCreating = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
}

function v2LocationIssue() {
  if (window.isSecureContext === false) return '手机通过局域网 HTTP 访问时，浏览器无法使用定位。请使用 HTTPS 地址开启 GPS；当前仍可查看路线并手动确认到站。';
  if (!navigator.geolocation) return '此浏览器不支持定位；仍可查看路线并手动确认到站。';
  return '';
}

function stopFollowGps() {
  followGpsGeneration += 1;
  if (followWatchId !== null) navigator.geolocation?.clearWatch(followWatchId);
  followWatchId = null;
  followWatchSession = null;
  state.v2PreviousFollowPosition = null;
}

function refreshFollowSketchV2(position, previous) {
  if (position.accuracy <= 100) {
    const paths = state.v2FollowLivePaths ||= [];
    const seconds = previous ? (position.ts - previous.ts) / 1000 : 0;
    const continuous = previous && previous.accuracy <= 100 && seconds > 0 && seconds <= 30 && safeDistanceMeters(previous, position) / seconds <= 9;
    if (!continuous || !paths.length) paths.push([]);
    paths.at(-1).push([position.lon, position.lat]);
    while (paths.reduce((total, path) => total + path.length, 0) > 1500) { paths[0].shift(); if (!paths[0].length) paths.shift(); }
  }
  const el = document.querySelector('.follow-map');
  if (!el || el._citytraceMap) return;
  const template = document.createElement('template');
  template.innerHTML = mapPlot(state.follow?.geometry || [], { class: 'follow-map', label: '历史路线与本次轨迹坐标示意' });
  const svg = template.content.querySelector('svg');
  if (svg) {
    const old = el.querySelector(':scope > svg');
    if (old) old.replaceWith(svg); else el.prepend(svg);
  }
  el.dataset.user = JSON.stringify(position);
}

function followLocationText() {
  const issue = v2LocationIssue();
  if (issue) return issue;
  if (state.followGpsMessage) return state.followGpsMessage;
  if (state.follow?.status === 'paused') return '行程已暂停，GPS 记录也已暂停。继续行程后可恢复定位。';
  if (state.follow?.status === 'completed') return '复刻已完成，GPS 记录已停止。';
  if (followWatchId !== null && state.followPosition) return `GPS 记录中 · 位置精度约 ${Math.round(state.followPosition.accuracy)} 米。已独立记录本次轨迹，到站仍需手动确认。`;
  if (followWatchId !== null) return '正在获取当前位置，请允许浏览器访问位置…';
  return '点击“开启 GPS 记录”显示当前位置并记录本次轨迹。也可以按站点手动复刻。';
}

function updateFollowLocationStatus() {
  const note = document.querySelector('.v2-follow-location');
  if (note) note.textContent = followLocationText();
  const locate = document.querySelector('#locate-follow');
  if (locate) {
    locate.textContent = followWatchId !== null ? '◎ GPS 记录中' : '◎ 开启 GPS 记录';
    locate.disabled = followWatchId !== null || state.follow?.status !== 'active';
  }
}

function startFollowGps(id) {
  if (followWatchSession === id && followWatchId !== null) return;
  const issue = v2LocationIssue();
  if (issue) { state.followGpsMessage = issue; updateFollowLocationStatus(); return; }
  if (state.follow?.id !== id || state.follow?.status !== 'active') return;
  stopFollowGps();
  const generation = followGpsGeneration;
  state.followId = id;
  followWatchSession = id;
  state.followGpsMessage = '正在获取当前位置，请允许浏览器访问位置…';
  try {
    followWatchId = navigator.geolocation.watchPosition(position => {
      if (generation !== followGpsGeneration || followWatchSession !== id || currentV2Path() !== `follow/${id}`) return;
      const previous = state.v2PreviousFollowPosition;
      const fix = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, ts: position.timestamp || Date.now() };
      state.followPosition = fix;
      state.followGpsMessage = fix.accuracy > 100 ? `当前位置精度约 ${Math.round(fix.accuracy)} 米，暂时不连入轨迹；请到开阔位置等待定位。` : '';
      updateFollowLocationStatus();
      refreshFollowSketchV2(fix, previous);
      const map = document.querySelector('.follow-map');
      if (map?._citytraceMap) {
        const mapInstance = map._citytraceMap;
        convertPath([[fix.lon, fix.lat]]).then(([point]) => {
          if (!map.isConnected || map._citytraceMap !== mapInstance || generation !== followGpsGeneration) return;
          if (map._citytraceUserMarker) map._citytraceUserMarker.setPosition(point);
          else { map._citytraceUserMarker = new AMap.Marker({ position: point, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '我的当前位置' }); mapInstance.add(map._citytraceUserMarker); }
        }).catch(() => {});
        if (previous && previous.accuracy <= 100 && fix.accuracy <= 100) {
          const seconds = (fix.ts - previous.ts) / 1000, distance = safeDistanceMeters(previous, fix);
          if (seconds > 0 && seconds <= 30 && distance / seconds <= 9 && distance >= 2) {
            convertPath([[previous.lon, previous.lat], [fix.lon, fix.lat]]).then(path => {
              if (map.isConnected && map._citytraceMap === mapInstance && generation === followGpsGeneration) mapInstance.add(new AMap.Polyline({ path, strokeColor: '#3979bf', strokeWeight: 4, strokeOpacity: .9, lineJoin: 'round' }));
            }).catch(() => {});
          }
        }
      }
      state.v2PreviousFollowPosition = fix;
      queueFollowPoint(id, fix);
    }, error => {
      if (generation !== followGpsGeneration) return;
      state.followGpsMessage = error.code === 1 ? '定位权限未开启。请在浏览器站点设置中允许位置访问，再点击开启 GPS；也可继续手动确认到站。' : error.code === 3 ? '定位超时，正在等待可用位置。请检查手机定位服务或移动到开阔位置。' : '暂时无法获取位置。请检查设备定位服务；也可继续手动确认到站。';
      if (error.code === 1) stopFollowGps();
      updateFollowLocationStatus();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  } catch (error) {
    stopFollowGps();
    state.followGpsMessage = error.message || '暂时无法开启定位，请检查浏览器权限。';
  }
  updateFollowLocationStatus();
}

function readFollowQueue(id) {
  if (followStorageBlocked.has(id)) return followMemoryQueues.get(id) || [];
  try {
    const stored = JSON.parse(localStorage.getItem(`citytrace_follow_queue_${id}`) || '[]');
    if (Array.isArray(stored)) return stored;
  } catch { /* Private browsing can disable local storage. Retain this tab's samples in memory. */ }
  return followMemoryQueues.get(id) || [];
}

function saveFollowQueue(id, queue) {
  followMemoryQueues.set(id, queue);
  try { localStorage.setItem(`citytrace_follow_queue_${id}`, JSON.stringify(queue)); }
  catch {
    followStorageBlocked.add(id);
    if (!state.followStorageWarning) { toast('浏览器无法保存离线轨迹，请保持本页打开直到同步完成', 'warn'); state.followStorageWarning = true; }
  }
}

function queueFollowPoint(id, position) {
  const queue = readFollowQueue(id);
  const ts = position.ts || Date.now();
  queue.push({ client_id: `${id}-${ts}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`, lat: position.lat, lon: position.lon, accuracy: position.accuracy, ts });
  if (queue.length > 1500 && !state.followQueueWarning) { toast('离线轨迹缓存已满，最早的未同步点将被替换。请恢复网络', 'warn'); state.followQueueWarning = true; }
  saveFollowQueue(id, queue.slice(-1500));
  flushFollowQueue(id);
}

function flushFollowQueue(id) {
  if (followFlushes.has(id)) return followFlushes.get(id);
  const flush = (async () => {
    if (!navigator.onLine) return readFollowQueue(id).length === 0;
    try {
      let queue = readFollowQueue(id);
      while (queue.length) {
        const batch = queue.slice(0, 300);
        await api(`/follow-sessions/${id}/points`, { method: 'POST', body: { samples: batch } });
        const sent = new Set(batch.map(point => point.client_id));
        queue = readFollowQueue(id).filter(point => !sent.has(point.client_id));
        saveFollowQueue(id, queue);
      }
      return true;
    } catch { return false; }
  })();
  followFlushes.set(id, flush);
  flush.finally(() => followFlushes.delete(id));
  return flush;
}
window.addEventListener('online', () => { if (state.followId && state.follow?.status === 'active') flushFollowQueue(state.followId); });

async function followPage(id) {
  const view = state.viewToken;
  if (state.follow?.id !== id) {
    stopFollowGps(); state.followPosition = null; state.followGpsMessage = ''; state.followResumeGps = false; state.v2FollowLivePaths = [];
  }
  v2MapContext = 'follow';
  await legacyFollowPageV2(id);
  const follow = state.follow;
  if (view !== state.viewToken || currentV2Path() !== `follow/${id}` || !follow || follow.id !== id || !document.querySelector('.follow-map')) return;
  installWaypointTimeline(document.querySelector('#app'), follow.waypoints || follow.checkpoints || [], follow.legs || []);
  const next = (follow.checkpoints || []).find(point => !point.arrived_at);
  const targetPanel = document.querySelector('.follow-hero .editor-stack .panel');
  if (next && targetPanel && next.photos?.length) {
    const image = document.createElement('img'); image.className = 'follow-target-photo'; image.src = next.photos[0].url; image.alt = `${next.name}现场参考照片`; image.dataset.lightbox = '1';
    targetPanel.insertBefore(image, targetPanel.querySelector('strong'));
  }
  if (next && targetPanel) {
    const leg = (follow.legs || []).find(item => item.to_waypoint_id === next.id);
    const oldMode = [...targetPanel.querySelectorAll('.leg-item')].find(item => item.firstElementChild?.textContent.includes('本段交通方式'));
    if (leg && oldMode) oldMode.lastElementChild.textContent = `${modeText(leg.transport_mode)}${leg.actual_duration_seconds ? ` · ${fmtDuration(leg.actual_duration_seconds)}` : ''}`;
    else if (!leg && oldMode) oldMode.remove();
  }
  const notice = document.createElement('div'); notice.className = 'v2-follow-location v2-gps-status';
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  document.querySelector('.follow-map')?.after(notice);
  const oldHint = document.querySelector('.follow-hero > .panel > p.field-hint');
  if (oldHint) oldHint.textContent = '开启 GPS 后会独立记录本次复刻轨迹；GPS 不会自动确认到站。请在各站点手动确认抵达。';
  if (follow.status !== 'active' && followWatchId !== null) stopFollowGps();
  const locate = document.querySelector('#locate-follow');
  if (locate) {
    const replacement = locate.cloneNode(true); locate.replaceWith(replacement);
    replacement.onclick = () => startFollowGps(id);
  }
  document.querySelectorAll('[data-checkin]').forEach(button => {
    const checkin = button.onclick;
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await checkin?.(); } finally { if (button.isConnected && follow.status === 'active') button.disabled = false; }
    };
  });
  makeV2PhotosAccessible();
  if (follow.status === 'active' && state.followGpsRequestedId === id) {
    state.followGpsRequestedId = null;
    startFollowGps(id);
  }
  updateFollowLocationStatus();
  if (follow.status === 'active') flushFollowQueue(id);
}

function renderEditor(route) {
  if (v2EditorId !== route.id) {
    state.editingCheckpoint = null; state.editingSegment = null;
    state.cpLocationSource = 'manual'; state.cpCoordinateSystem = 'WGS84';
  }
  v2EditorId = route.id;
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

let v2RecordMapSession = { id: null, status: null, breaks: [] };

function recordMapPathsV2() {
  const track = state.track;
  if (!track) return [];
  if (v2RecordMapSession.id !== track.id) v2RecordMapSession = { id: track.id, status: track.status, breaks: [] };
  if (v2RecordMapSession.status !== track.status) {
    v2RecordMapSession.breaks.push(Date.now());
    v2RecordMapSession.status = track.status;
  }
  const paths = (track.geometry_segments?.length ? track.geometry_segments : track.cleaned_geometry?.length ? [track.cleaned_geometry] : []).map(cleanMapPath).filter(path => path.length);
  const queued = (state.queue || []).filter(point => point.track_id === track.id && Number(point.accuracy) <= 100 && validMapPoint([point.lon, point.lat])).sort((a, b) => a.ts - b.ts);
  let pending = [], previous = null;
  for (const point of queued) {
    const seconds = previous ? (point.ts - previous.ts) / 1000 : 0;
    const paused = previous && v2RecordMapSession.breaks.some(time => previous.ts < time && point.ts >= time);
    const continuous = previous && seconds > 0 && seconds <= 30 && safeDistanceMeters(previous, point) / seconds <= 9 && !paused;
    if (!continuous && pending.length) { paths.push(pending); pending = []; }
    pending.push([Number(point.lon), Number(point.lat)]);
    previous = point;
  }
  if (pending.length) paths.push(pending);
  return paths;
}

function renderRecordSketchV2(el, paths, position) {
  const points = paths.flat();
  if (position && validMapPoint([position.lon, position.lat])) points.push([Number(position.lon), Number(position.lat)]);
  if (!points.length) return;
  const bounds = points.reduce((box, point) => [Math.min(box[0], point[0]), Math.max(box[1], point[0]), Math.min(box[2], point[1]), Math.max(box[3], point[1])], [Infinity, -Infinity, Infinity, -Infinity]);
  if (bounds[0] === bounds[1]) { bounds[0] -= .001; bounds[1] += .001; }
  if (bounds[2] === bounds[3]) { bounds[2] -= .001; bounds[3] += .001; }
  const project = point => [20 + (point[0] - bounds[0]) / (bounds[1] - bounds[0]) * 460, 20 + (bounds[3] - point[1]) / (bounds[3] - bounds[2]) * 210];
  const lines = paths.map(path => {
    if (path.length < 2) return '';
    const d = path.map(project).map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="#4c8158" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const pinPoint = position && validMapPoint([position.lon, position.lat]) ? [Number(position.lon), Number(position.lat)] : points.at(-1);
  const [x, y] = project(pinPoint);
  let svg = el.querySelector(':scope > svg');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 500 250'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '真实 GPS 轨迹与当前位置示意图'); el.prepend(svg); }
  svg.innerHTML = `${lines}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#3979bf" stroke="white" stroke-width="3"/>`;
}

function refreshRecordMapV2() {
  if (currentV2Path() !== 'record' || !state.track) return;
  const el = document.querySelector('.record-map[data-v2-map="1"]');
  if (!el || el.dataset.mapDisposed === '1') return;
  const paths = recordMapPathsV2();
  const position = state.recordPosition || state.lastFix;
  const signature = JSON.stringify(paths);
  const positionSignature = position ? `${position.lon},${position.lat}` : '';
  el.dataset.paths = signature;
  el.dataset.user = JSON.stringify(position || null);
  if (paths.length || position) el.querySelector('.v2-empty-map')?.remove();
  const map = el._citytraceMap;
  if (!map || !window.AMap) {
    if (el._citytraceSketchSignature !== signature + positionSignature) {
      renderRecordSketchV2(el, paths, position);
      el._citytraceSketchSignature = signature + positionSignature;
    }
    return;
  }
  if (el._citytracePathSignature !== signature) {
    el._citytracePathSignature = signature;
    const revision = (el._citytracePathRevision || 0) + 1; el._citytracePathRevision = revision;
    convertPath(paths.flat()).then(converted => {
      if (!el.isConnected || el._citytraceMap !== map || el._citytracePathRevision !== revision) return;
      let cursor = 0;
      const lines = paths.map(path => {
        const coords = converted.slice(cursor, cursor + path.length); cursor += path.length;
        return coords.length > 1 ? new AMap.Polyline({ path: coords, strokeColor: '#458258', strokeWeight: 5, strokeOpacity: .95, lineJoin: 'round', lineCap: 'round' }) : null;
      }).filter(Boolean);
      if (el._citytraceTrackLines?.length) map.remove(el._citytraceTrackLines);
      if (lines.length) map.add(lines);
      el._citytraceTrackLines = lines;
    }).catch(() => { if (el._citytraceMap === map) el._citytracePathSignature = null; });
  }
  if (position && validMapPoint([position.lon, position.lat]) && el._citytracePositionSignature !== positionSignature) {
    el._citytracePositionSignature = positionSignature;
    convertPath([[Number(position.lon), Number(position.lat)]]).then(([point]) => {
      if (!el.isConnected || el._citytraceMap !== map || el._citytracePositionSignature !== positionSignature) return;
      if (el._citytraceUserMarker) el._citytraceUserMarker.setPosition(point);
      else {
        el._citytraceUserMarker = new AMap.Marker({ position: point, content: '<div class="v2-user-marker"><i></i></div>', offset: new AMap.Pixel(-10, -10), title: '当前位置' });
        map.add(el._citytraceUserMarker);
        if (!paths.length) map.setCenter(point);
      }
    }).catch(() => { if (el._citytraceMap === map) el._citytracePositionSignature = null; });
  }
}
window.refreshRecordMapV2 = refreshRecordMapV2;
window.hasPendingFollowPoints = () => [...new Set([state.followId, ...followMemoryQueues.keys()])].some(id => id && readFollowQueue(id).length > 0);
window.isFollowingGpsV2 = () => followWatchId !== null;
window.resetFollowClientV2 = () => {
  stopFollowGps();
  followMemoryQueues.clear();
  followStorageBlocked.clear();
  state.followPosition = null;
  state.followGpsRequestedId = null;
  state.followResumeGps = false;
  state.v2FollowLivePaths = [];
};

function captureEditorDraft() {
  const fields = {};
  document.querySelectorAll('#app input[id],#app textarea[id],#app select[id]').forEach(input => {
    if (input.type !== 'file') fields[input.id] = input.type === 'checkbox' ? input.checked : input.value;
  });
  const legFields = [...document.querySelectorAll('[data-leg]')].map(row => ({ id: row.dataset.leg, values: [...row.querySelectorAll('input,textarea,select')].map(input => input.value) }));
  return { fields, legFields, editingCheckpoint: state.editingCheckpoint, source: state.cpLocationSource, coordinates: state.cpCoordinateSystem };
}

async function refreshEditorPreservingDraft(id, draft = null) {
  const revision = ++v2EditorRefresh;
  const fresh = await api(`/routes/${id}`);
  if (revision !== v2EditorRefresh || currentV2Path() !== `edit/${id}`) return;
  const latest = captureEditorDraft();
  if (draft) {
    for (const key of Object.keys(draft.fields)) if (key in latest.fields) draft.fields[key] = latest.fields[key];
    draft.legFields = latest.legFields;
  } else draft = latest;
  renderEditor(fresh);
  for (const [name, value] of Object.entries(draft.fields)) {
    const input = document.getElementById(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  state.editingCheckpoint = draft.editingCheckpoint;
  state.cpLocationSource = draft.source;
  state.cpCoordinateSystem = draft.coordinates;
  for (const leg of draft.legFields || []) {
    document.querySelectorAll(`[data-leg="${CSS.escape(leg.id)}"] input,[data-leg="${CSS.escape(leg.id)}"] textarea,[data-leg="${CSS.escape(leg.id)}"] select`).forEach((input, index) => { if (leg.values[index] !== undefined) input.value = leg.values[index]; });
  }
  const cancel = document.querySelector('[data-cancel-checkpoint]');
  if (cancel) cancel.hidden = !state.editingCheckpoint;
  if (state.editingCheckpoint) {
    const add = document.querySelector('#add-checkpoint');
    if (add) add.textContent = '保存打卡点';
  }
  updateEditorLocationStatus();
}

function updateEditorLocationStatus(message = '') {
  const note = document.querySelector('.v2-editor-location-state');
  if (!note) return;
  const lat = document.querySelector('#cp-lat')?.value, lon = document.querySelector('#cp-lon')?.value;
  note.textContent = message || (lat !== '' && lon !== '' ? `位置已填写 · ${state.cpLocationSource === 'live' ? '当前位置' : state.cpLocationSource === 'track' ? '历史轨迹位置' : '手动补充位置'}` : '尚未选择位置。可从历史轨迹选点、定位，或手动填写经纬度。');
}

function resetEditorCheckpoint(route) {
  ['cp-name', 'cp-lat', 'cp-lon', 'cp-recommended', 'cp-note'].forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
  ['cp-spend', 'cp-stay'].forEach(id => { const input = document.getElementById(id); if (input) input.value = '0'; });
  document.querySelector('#cp-position').value = (route.waypoints || route.checkpoints || []).length;
  document.querySelector('#track-point').value = '';
  document.querySelector('#add-checkpoint').textContent = '＋ 添加打卡点';
  state.editingCheckpoint = null; state.cpLocationSource = 'manual'; state.cpCoordinateSystem = 'WGS84';
  updateEditorLocationStatus();
}

function enhanceEditor(route) {
  const legacyPanel = [...document.querySelectorAll('.editor-stack .panel')].find(panel => panel.querySelector('h2')?.textContent.trim() === '交通路段');
  if (!legacyPanel) return;
  const legs = route.legs || [];
  const rows = legs.map((leg, index) => `<div class="v2-leg-editor" data-leg="${esc(leg.id)}"><div class="v2-leg-heading"><strong>${esc(leg.start_label)} → ${esc(leg.end_label)}</strong><span>第 ${index + 1} 段</span></div><div class="form-grid"><label class="field"><span>交通方式</span><select data-leg-mode>${V2_MODES.map(([value, label]) => `<option value="${value}" ${leg.transport_mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>实际用时（分钟，可选）</span><input data-leg-duration type="number" min="0" value="${leg.actual_duration_seconds == null ? '' : Math.round(leg.actual_duration_seconds / 60)}"></label><label class="field full"><span>线路或站点说明</span><input data-leg-line maxlength="300" value="${esc(leg.line_info || '')}" placeholder="例如：地铁 1 号线，东街口站至南门兜站"></label><label class="field full"><span>备注</span><textarea data-leg-notes maxlength="1000">${esc(leg.notes || '')}</textarea></label></div><div class="form-actions"><button class="button button-outline button-small" data-save-leg>保存本段方式</button>${!leg.mode_confirmed ? '<span class="field-hint">此段需要作者确认</span>' : ''}</div></div>`).join('');
  legacyPanel.innerHTML = `<div class="panel-heading"><h2>相邻标记点之间的交通</h2><small>${legs.length} 段 · 不修改 GPS 原始轨迹</small></div>${rows || '<p class="field-hint">添加两个或更多标记点后，这里会自动生成相邻路段。</p>'}<div class="v2-map-pick"><button class="button button-outline button-small" type="button" id="v2-pick-waypoint">⌖ 在轨迹地图上选点</button><span class="field-hint">地图选点会标记为手动补充位置，不会伪装成 GPS 样本。</span></div>`;
  let currentVersion = route.version;
  legacyPanel.querySelectorAll('[data-save-leg]').forEach(button => button.onclick = async () => {
    if (button.disabled) return;
    const row = button.closest('[data-leg]');
    const duration = row.querySelector('[data-leg-duration]');
    if (!duration.reportValidity()) return;
    button.disabled = true;
    try {
      await api(`/legs/${row.dataset.leg}`, { method: 'PATCH', body: {
        transport_mode: row.querySelector('[data-leg-mode]').value,
        actual_duration_seconds: duration.value === '' ? null : Number(duration.value) * 60,
        line_info: row.querySelector('[data-leg-line]').value,
        notes: row.querySelector('[data-leg-notes]').value,
        expected_version: currentVersion
      } });
      toast('交通方式已保存'); await refreshEditorPreservingDraft(route.id);
    } catch (error) { toast(error.message, 'error'); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  document.querySelectorAll('[data-edit-cp]').forEach(button => {
    const cp = (route.waypoints || route.checkpoints || []).find(point => point.id === button.dataset.editCp);
    if (!cp) return;
    button.addEventListener('click', () => { state.cpCoordinateSystem = cp.coordinate_system || 'WGS84'; queueMicrotask(() => updateEditorLocationStatus()); }, { capture: true });
  });
  document.querySelectorAll('[data-photo-checkpoint],#cover-file').forEach(input => {
    input.multiple = true;
    if (input.id === 'cover-file') input.multiple = false;
    input.onchange = async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      const status = document.createElement('span'); status.className = 'v2-upload-status'; status.setAttribute('role', 'status');
      input.closest('label,.field')?.after(status);
      input.disabled = true;
      let uploaded = 0;
      try {
        for (const [index, file] of files.entries()) {
          status.textContent = `正在上传 ${index + 1} / ${files.length} 张照片…`;
          await api(`/routes/${route.id}/photos`, { method: 'POST', body: { ...(input.dataset.photoCheckpoint ? { checkpoint_id: input.dataset.photoCheckpoint } : {}), data_url: await fileData(file), kind: input.id === 'cover-file' ? 'cover' : 'checkpoint' } });
          uploaded += 1;
        }
        toast(input.id === 'cover-file' ? '路线封面已更新' : `${uploaded} 张现场照片已上传`);
      } catch (error) {
        toast(`${uploaded ? `已上传 ${uploaded} 张；` : ''}${error.message}`, 'error');
      } finally {
        input.value = ''; input.disabled = false; status.remove();
        if (uploaded) {
          try { await refreshEditorPreservingDraft(route.id); } catch (error) { toast(`照片已上传，刷新预览失败：${error.message}`, 'warn'); }
        }
      }
    };
  });
  const pick = document.querySelector('#v2-pick-waypoint');
  if (pick) pick.onclick = () => {
    const map = document.querySelector('.record-map');
    if (!map?._citytraceMap) { toast('地图底图暂不可用，可从历史轨迹选点、定位或填写经纬度'); document.querySelector('#track-point')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    state.v2PickWaypoint = !state.v2PickWaypoint;
    if (state.v2PickWaypoint) {
      map.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('点击轨迹地图选择位置；再次点选点按钮可取消');
    } else toast('已取消地图选点');
  };
  document.querySelectorAll('.editor-stack .panel .list-row').forEach(row => {
    const id = row.querySelector('[data-edit-cp]')?.dataset.editCp;
    if (!id) return;
    const controls = document.createElement('span'); controls.className = 'v2-sort-controls';
    controls.innerHTML = `<button type="button" aria-label="上移标记点" data-move="up">↑</button><button type="button" aria-label="下移标记点" data-move="down">↓</button>`;
    row.append(controls);
    const ordered = [...(route.waypoints || route.checkpoints || [])].sort((a, b) => a.order_index - b.order_index);
    const current = ordered.findIndex(point => point.id === id);
    controls.querySelector('[data-move="up"]').disabled = current <= 0;
    controls.querySelector('[data-move="down"]').disabled = current === ordered.length - 1;
    controls.querySelectorAll('[data-move]').forEach(button => button.onclick = async () => {
      const points = [...(route.waypoints || route.checkpoints || [])].sort((a, b) => a.order_index - b.order_index);
      const from = points.findIndex(point => point.id === id), to = from + (button.dataset.move === 'up' ? -1 : 1);
      if (to < 0 || to >= points.length) return;
      [points[from], points[to]] = [points[to], points[from]];
      button.disabled = true;
      try { await api(`/routes/${route.id}/waypoints/order`, { method: 'PATCH', body: { waypoint_ids: points.map(point => point.id), expected_version: route.version } }); await refreshEditorPreservingDraft(route.id); toast('打卡顺序已更新'); }
      catch (error) { toast(error.message, 'error'); }
      finally { if (button.isConnected) button.disabled = false; }
    });
  });
  installV2EditorLocation(route);
  makeV2PhotosAccessible();
}

function installV2EditorLocation(route) {
  const add = document.querySelector('#add-checkpoint');
  const lat = document.querySelector('#cp-lat'), lon = document.querySelector('#cp-lon');
  if (!add || !lat || !lon) return;
  const status = document.createElement('div'); status.className = 'v2-editor-location-state'; status.setAttribute('role', 'status');
  document.querySelector('#track-point')?.closest('.field')?.append(status);
  updateEditorLocationStatus(v2LocationIssue());
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button button-outline'; cancel.textContent = '取消编辑';
  cancel.dataset.cancelCheckpoint = '1';
  cancel.hidden = !state.editingCheckpoint;
  cancel.onclick = () => { resetEditorCheckpoint(route); cancel.hidden = true; };
  add.after(cancel);
  document.querySelectorAll('[data-edit-cp]').forEach(button => button.addEventListener('click', () => { cancel.hidden = false; updateEditorLocationStatus(); }));
  [lat, lon].forEach(input => input.addEventListener('input', () => { state.cpLocationSource = 'manual'; updateEditorLocationStatus(); }));
  document.querySelector('#track-point')?.addEventListener('change', () => { state.cpCoordinateSystem = 'WGS84'; updateEditorLocationStatus(); });
  const locate = document.querySelector('#use-location');
  if (locate) locate.onclick = () => {
    const issue = v2LocationIssue();
    if (issue) { updateEditorLocationStatus(issue); toast(issue, 'warn'); return; }
    locate.disabled = true;
    const editing = state.editingCheckpoint;
    updateEditorLocationStatus('正在获取当前位置，请允许浏览器访问位置…');
    navigator.geolocation.getCurrentPosition(position => {
      if (locate.isConnected) locate.disabled = false;
      if (currentV2Path() !== `edit/${route.id}` || !lat.isConnected || editing !== state.editingCheckpoint) return;
      lat.value = position.coords.latitude; lon.value = position.coords.longitude;
      state.cpLocationSource = 'live'; state.cpCoordinateSystem = 'WGS84';
      document.querySelector('#track-point').value = '';
      updateEditorLocationStatus(`已使用当前位置 · 定位精度约 ${Math.round(position.coords.accuracy)} 米`);
    }, error => {
      if (!locate.isConnected) return;
      locate.disabled = false;
      updateEditorLocationStatus(error.code === 1 ? '位置权限未开启，可从历史轨迹选点或手动填写位置。' : '暂时无法定位，可从历史轨迹选点或稍后重试。');
      toast(error.code === 1 ? '请在浏览器站点设置中允许位置访问' : '定位失败，请检查手机定位服务后重试', 'warn');
    }, { enableHighAccuracy: true, timeout: 15000 });
  };
  add.onclick = async () => {
    if (add.disabled) return;
    const name = document.querySelector('#cp-name');
    if (!name.value.trim()) { name.focus(); toast('请填写打卡名称', 'warn'); return; }
    if (lat.value === '' || lon.value === '' || !validMapPoint([lon.value, lat.value])) { lat.focus(); toast('请先选择有效位置或填写经纬度', 'warn'); return; }
    const inputs = ['cp-position', 'cp-spend', 'cp-stay'].map(id => document.getElementById(id));
    if (!inputs.every(input => input.reportValidity())) return;
    const id = state.editingCheckpoint;
    add.disabled = true;
    try {
      await api(`/routes/${route.id}/checkpoints${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: {
        name: name.value.trim(), kind: document.querySelector('#cp-kind').value,
        position: Number(document.querySelector('#cp-position').value), lat: Number(lat.value), lon: Number(lon.value),
        location_source: state.cpLocationSource || 'manual', coordinate_system: state.cpCoordinateSystem || 'WGS84',
        recommended: document.querySelector('#cp-recommended').value, spend: Number(document.querySelector('#cp-spend').value || 0),
        stay_minutes: Number(document.querySelector('#cp-stay').value || 0), note: document.querySelector('#cp-note').value
      } });
      const draft = captureEditorDraft();
      for (const key of Object.keys(draft.fields)) if (key.startsWith('cp-') || key === 'track-point') delete draft.fields[key];
      draft.editingCheckpoint = null; draft.source = 'manual'; draft.coordinates = 'WGS84';
      state.editingCheckpoint = null;
      await refreshEditorPreservingDraft(route.id, draft);
      toast(id ? '打卡点已更新' : '打卡点已保存，可继续添加或上传现场照片');
    } catch (error) { toast(error.message, 'error'); }
    finally { if (add.isConnected) add.disabled = false; }
  };
  const save = document.querySelector('#save-route');
  if (save) save.onclick = async () => {
    if (save.disabled) return;
    const title = document.querySelector('#edit-title');
    if (!title.value.trim()) { title.focus(); toast('请填写路线名称', 'warn'); return; }
    save.disabled = true;
    try {
      await api(`/routes/${route.id}`, { method: 'PATCH', body: { title: title.value.trim(), city: document.querySelector('#edit-city').value, category: document.querySelector('#edit-category').value, description: document.querySelector('#edit-description').value } });
      await refreshEditorPreservingDraft(route.id);
      toast('路线信息已保存');
    } catch (error) { toast(error.message, 'error'); }
    finally { if (save.isConnected) save.disabled = false; }
  };
}

const oldBindEditorV2 = window.bindEditor;
if (oldBindEditorV2) {
  window.bindEditor = function (route) {
    oldBindEditorV2(route);
    const add = document.querySelector('#add-checkpoint');
    if (add) add.addEventListener('click', () => { state.cpCoordinateSystem ||= 'WGS84'; }, { capture: true });
  };
}

window.followAction = async function (id, action) {
  if (followActionBusy) return;
  followActionBusy = true;
  const wasRecording = followWatchSession === id && followWatchId !== null;
  const controls = document.querySelectorAll('#follow-pause,#follow-resume,#follow-finish,[data-checkin]');
  controls.forEach(button => { button.disabled = true; });
  try {
    if (action === 'pause' || action === 'finish') {
      stopFollowGps();
      if (!await flushFollowQueue(id)) throw new Error('本次 GPS 轨迹尚未同步，请恢复网络后再暂停或完成行程');
    }
    state.follow = await api(`/follow-sessions/${id}/${action}`, { method: 'PATCH', body: {} });
    state.followGpsMessage = '';
    if (action === 'resume' && wasRecording) state.followGpsRequestedId = id;
    if (action === 'resume' && state.followResumeGps) state.followGpsRequestedId = id;
    if (action === 'pause') state.followResumeGps = wasRecording;
    if (action === 'finish') { state.followResumeGps = false; state.followGpsRequestedId = null; }
    toast(action === 'finish' ? '复刻行程已完成并保存' : '行程状态已更新');
    if (currentV2Path() === `follow/${id}`) await followPage(id);
  } catch (error) {
    toast(error.message, 'error');
    if (wasRecording && currentV2Path() === `follow/${id}`) startFollowGps(id);
  } finally {
    followActionBusy = false;
    controls.forEach(button => { if (button.isConnected) button.disabled = false; });
    updateFollowLocationStatus();
  }
};

function makeV2PhotosAccessible() {
  document.querySelectorAll('.photo-thumb,img[data-lightbox]').forEach(photo => {
    photo.dataset.lightbox = '1'; photo.tabIndex = 0;
    photo.setAttribute('role', 'button');
    photo.setAttribute('aria-label', `放大查看${photo.alt || '路线照片'}`);
    photo.loading = 'lazy'; photo.decoding = 'async';
  });
}

function openV2Lightbox(photo) {
  closeV2Lightbox?.();
  const focused = document.activeElement;
  const wasLocked = document.body.classList.contains('no-scroll');
  const scrim = document.createElement('div'); scrim.className = 'v2-lightbox';
  scrim.setAttribute('role', 'dialog'); scrim.setAttribute('aria-modal', 'true'); scrim.setAttribute('aria-label', '查看路线照片');
  scrim.innerHTML = `<button type="button" aria-label="关闭图片">×</button><img src="${esc(photo.currentSrc || photo.src)}" alt="${esc(photo.alt || '路线照片')}">`;
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeV2Lightbox?.(); }
    if (event.key === 'Tab') { event.preventDefault(); scrim.querySelector('button').focus(); }
  };
  closeV2Lightbox = () => {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    if (!wasLocked) document.body.classList.remove('no-scroll');
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    closeV2Lightbox = null;
  };
  scrim.onclick = () => closeV2Lightbox?.();
  document.addEventListener('keydown', onKey);
  document.body.append(scrim); document.body.classList.add('no-scroll'); scrim.querySelector('button').focus();
}

window.addEventListener('click', event => {
  const photo = event.target.closest?.('img[data-lightbox], .photo-thumb');
  if (photo) openV2Lightbox(photo);
});
window.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('img[data-lightbox],.photo-thumb')) {
    event.preventDefault(); openV2Lightbox(event.target);
  }
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
