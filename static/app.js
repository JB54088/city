const API='/api';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const app=$('#app');
const state={me:null,config:{},routes:[],page:'discover',route:null,track:null,watch:null,lastFix:null,lastSampleAt:0,queue:[],syncTimer:null,tripTab:'routes',tripFilter:'all',follow:null,followId:null,editorRoute:null,authMode:'login',authReturn:null,filter:{q:'',city:'',category:'',duration:''}};
const STORE='citytrace.pendingPoints.v2', LAST_TRACK='citytrace.lastTrack.v2';
Object.assign(state, { viewToken: 0, discoverRequest: 0, flushPromise: null, recordActionBusy: false });
state.filter.page = 1;
const categories=['全部','Citywalk','美食','街巷','夜游','亲子','其他'];
const modes=['步行','地铁','公交','骑行','打车','自驾','其他'];
const kinds=['美食','景点','摄影','地铁站','公交站','休息点','其他'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDist=m=>m>=1000?`${(m/1000).toFixed(1)} 公里`:`${Math.round(m||0)} 米`;
const fmtDuration=s=>{const minutes=Math.max(1,Math.round(Number(s||0)/60));if(!Number(s))return'—';const hours=Math.floor(minutes/60),rest=minutes%60;return hours?`${hours}小时${rest?rest+'分':''}`:`${minutes}分钟`};
const fmtClock=s=>{s=Math.max(0,Math.floor(s||0));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':')};
const fmtDate=v=>v?new Date(v).toLocaleDateString('zh-CN',{month:'long',day:'numeric'}):'';
const initial=n=>(n||'迹').trim().slice(0,1);
function storageRead(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageWrite(key, value) {
  try { localStorage.setItem(key, value); state.storageError = ''; return true; }
  catch { state.storageError = '浏览器无法保存本机待同步轨迹，请保持联网并勿关闭页面。'; updateAppStatus(); return false; }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch {}
}
function trackStorageKey(prefix) { return `${prefix}.${state.me?.id || 'guest'}`; }
function updateAppStatus() {
  const status = $('#app-status');
  if (!status) return;
  const message = state.storageError || (!navigator.onLine ? '网络已断开 · 已采样轨迹会保留，联网后继续同步' : '');
  status.textContent = message;
  status.classList.toggle('hidden', !message);
  status.dataset.tone = state.storageError ? 'error' : 'offline';
}
function updateActiveJourney() {
  const banner = $('#active-journey');
  if (!banner) return;
  const track = state.me && state.track;
  const visible = track && ['recording', 'paused', 'finished'].includes(track.status) && state.page !== 'record';
  banner.classList.toggle('hidden', !visible);
  if (visible) banner.innerHTML = `<a href="#/record"><span><i class="journey-dot"></i>${track.status === 'paused' ? '有一段已暂停的记录' : track.status === 'finished' ? '有一段记录待保存为路线' : '有一段未结束的记录'}${state.queue.length ? ` · ${state.queue.length} 个点待同步` : ''}</span><strong>返回记录 →</strong></a>`;
}
function errorPage(title, error, retry) {
  return `<div class="empty-state"><div class="empty-icon">⌁</div><strong>${esc(title)}</strong><p>${esc(error?.message || '请稍后重试')}</p>${retry ? `<button class="button button-outline" onclick="${esc(retry)}">重新加载</button>` : ''}</div>`;
}
function discoveryResults(data, error) {
  if (error) return errorPage('路线暂时没有加载出来', error, 'discover({resultsOnly:true})');
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const cards = data.items.map(routeCard).join('');
  return `${cards ? `<div class="route-grid">${cards}</div>` : '<div class="empty-state"><div class="empty-icon">⌖</div><strong>没有找到匹配的路线</strong><p>试试其他关键词，或清除筛选看看全部路线。</p><button class="button button-outline" data-reset-filters>清除筛选</button></div>'}${pages > 1 ? `<nav class="pagination" aria-label="路线列表分页"><button class="button button-outline" data-discover-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.page} / ${pages} 页</span><button class="button button-outline" data-discover-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>下一页</button></nav>` : ''}`;
}
function updateFilterSummary(total) {
  const active = Boolean(state.filter.q || state.filter.city || state.filter.category && state.filter.category !== '全部' || state.filter.duration);
  const clear = $('#clear-filters');
  if (clear) clear.classList.toggle('hidden', !active);
  if ($('#discover-count')) $('#discover-count').textContent = total === null ? '加载失败，可重新尝试' : total === undefined ? '正在查找路线…' : `${total} 条${active ? '匹配' : '公开'}路线`;
  $$('[data-category]').forEach(button => {
    const selected = button.dataset.category === (state.filter.category || '全部');
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
function resetDiscoverFilters() {
  Object.assign(state.filter, { q: '', city: '', category: '', duration: '', page: 1 });
  if ($('#search-q')) $('#search-q').value = '';
  if ($('#search-city')) $('#search-city').value = '';
  if ($('#duration-filter')) $('#duration-filter').value = '';
  discover({ resultsOnly: true });
}
function bindDiscoverResults() {
  $$('[data-reset-filters]').forEach(b => b.onclick = resetDiscoverFilters);
  $$('[data-discover-page]').forEach(b => b.onclick = async () => {
    state.filter.page = Number(b.dataset.discoverPage);
    await discover({ resultsOnly: true });
    $('#discover-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $$('[data-favorite]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    if (!state.me) { openAuth(); return; }
    if (b.disabled) return;
    b.disabled = true;
    const favorite = !b.classList.contains('is-favorite');
    try {
      await api(`/routes/${b.dataset.favorite}/favorite`, { method: favorite ? 'POST' : 'DELETE' });
      b.classList.toggle('is-favorite', favorite);
      b.setAttribute('aria-pressed', String(favorite));
      b.setAttribute('aria-label', favorite ? '取消收藏' : '收藏路线');
      b.textContent = favorite ? '♥' : '♡';
      toast(favorite ? '已收藏到你的行程' : '已取消收藏');
    } catch (error) { toast(error.message, 'error'); } finally { b.disabled = false; }
  });
  $$('[data-route]').forEach(card => card.onclick = e => {
    if (e.target.closest('button,a,input')) return;
    navigate(`route/${card.dataset.route}`);
  });
}
function toast(message,type=''){const el=document.createElement('div');el.className='toast '+type;el.textContent=message;$('#toast-stack').append(el);setTimeout(()=>el.remove(),3400)}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 20000);
  const init = { method: options.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  try {
    const res = await fetch(API + path, init);
    let data;
    try { data = await res.json(); } catch { throw Error('服务暂时无法响应，请稍后重试。'); }
    if (!res.ok || !data.ok) {
      const error = Error(data?.error?.message || `请求失败（${res.status}）`);
      error.status = res.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data.data;
  } catch (error) {
    if (error.name === 'AbortError') throw Error('连接超时，请检查网络后重试。');
    if (error instanceof TypeError) throw Error(navigator.onLine ? '连接不到城迹服务，请确认服务已启动。' : '当前处于离线状态，请联网后重试。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function setUserUi() {
  const logged = Boolean(state.me);
  $('#top-login').classList.toggle('hidden', logged);
  $('#top-profile').classList.toggle('hidden', !logged);
  $('#top-profile').textContent = initial(state.me?.nickname);
  $('#rail-user').textContent = state.me?.nickname || '游客漫游中';
  $('#rail-avatar').textContent = initial(state.me?.nickname);
  $('#rail-login').title = logged ? '退出登录' : '登录';
  $('#rail-login').setAttribute('aria-label', logged ? '退出登录' : '登录');
}
function navActive(page) {
  $$('[data-nav]').forEach(a => {
    const active = a.dataset.nav === page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const labels = { discover: ['发现', '沿着城市慢慢走'], map: ['地图', '把路线铺在城市里'], record: ['记录', '把走过的路留下来'], trips: ['行程', '你的路线与下一站'], profile: ['我的', '每一段城市生活'] };
  const crumb = labels[page] || ['城迹', ''];
  $('#crumb').innerHTML = `${crumb[0]} <span>/</span> ${crumb[1]}`;
  state.page = page;
}
function mapPlot(points=[],opts={}){const path=Array.isArray(points)?points:[];const demo=opts.demo;let svg='';if(path.length){const xs=path.map(p=>Number(p[0])),ys=path.map(p=>Number(p[1]));let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);if(minX===maxX){minX-=.001;maxX+=.001}if(minY===maxY){minY-=.001;maxY+=.001}const pad=18,w=500,h=250;const xy=path.map(p=>[pad+(p[0]-minX)/(maxX-minX)*(w-2*pad),pad+(maxY-p[1])/(maxY-minY)*(h-2*pad)]);const d=xy.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');svg=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="轨迹坐标示意图"><path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#4c8158" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${xy.length?`<circle cx="${xy[0][0]}" cy="${xy[0][1]}" r="6" fill="#fff" stroke="#df9359" stroke-width="4"/><circle cx="${xy.at(-1)[0]}" cy="${xy.at(-1)[1]}" r="6" fill="#fff" stroke="#4c8158" stroke-width="4"/>`:''}</svg>`}const label=opts.label||(state.config.amap_key?'轨迹展示':'轨迹坐标示意 · 非地图底图');return `<div class="map-plot ${opts.class||''}" data-points="${esc(JSON.stringify(path))}" data-private="${opts.private===true}" data-map-ready="0">${svg}${state.config.amap_key?'<span class="map-unconfigured">正在连接高德地图</span>':''}<span class="plot-label ${state.config.amap_key?'hidden':'warn'}">${esc(label)}${demo?' · 演示数据':''}</span></div>`}
async function initMapSdk(){if(!state.config.amap_key)return;if(state.mapSdkPromise){await state.mapSdkPromise}else{window._AMapSecurityConfig={securityJsCode:state.config.amap_security_code||''};await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.config.amap_key)}&plugin=AMap.Scale,AMap.ToolBar`;s.onload=resolve;s.onerror=reject;document.head.append(s)}).catch(()=>{toast('高德地图加载失败，仍可查看轨迹坐标示意','warn');state.config.amap_key=''});state.mapSdkPromise=Promise.resolve();}if(!window.AMap)return;for(const el of $$('.map-plot[data-map-ready="0"]')){if(el.dataset.private==='true')continue;el.dataset.mapReady='1';try{const pts=JSON.parse(el.dataset.points||'[]');if(!pts.length)continue;const gps=pts.map(([lng,lat])=>[lng,lat]);const draw=coords=>{el.classList.add('has-real-map');const map=new AMap.Map(el,{zoom:14,center:coords[0],viewMode:'2D',mapStyle:'amap://styles/whitesmoke',resizeEnable:true});map.addControl(new AMap.Scale());map.addControl(new AMap.ToolBar({position:'RT'}));const line=new AMap.Polyline({path:coords,strokeColor:'#458258',strokeWeight:5,strokeOpacity:.9,lineJoin:'round',lineCap:'round'});map.add(line);map.add(new AMap.Marker({position:coords[0],content:'<div style="width:13px;height:13px;border:3px solid #e29557;background:white;border-radius:50%"></div>',offset:new AMap.Pixel(-6,-6)}));map.add(new AMap.Marker({position:coords.at(-1),content:'<div style="width:13px;height:13px;border:3px solid #458258;background:white;border-radius:50%"></div>',offset:new AMap.Pixel(-6,-6)}));map.setFitView([line],false,[35,35,35,35]);el.querySelector(':scope > svg')?.remove();$('.plot-label',el)?.classList.add('hidden');$('.map-unconfigured',el)?.classList.add('hidden')};AMap.convertFrom(gps,'gps',(status,result)=>{if(status==='complete')draw(result.locations);else if(status==='error')toast('坐标转换失败，当前显示轨迹坐标示意','warn')})}catch(e){console.error(e)}}}
function mountMaps(){initMapSdk()}
function svgHero(){return `<svg viewBox="0 0 340 190" fill="none" aria-hidden="true"><path d="M14 157C53 157 58 128 84 127c28-1 27 32 55 30 32-2 31-78 66-81 28-2 25 43 53 41 20-2 28-29 57-28" stroke="#9db697" stroke-width="1.5" stroke-dasharray="4 5"/><path d="M14 157C53 157 58 128 84 127c28-1 27 32 55 30 32-2 31-78 66-81 28-2 25 43 53 41 20-2 28-29 57-28" stroke="#4c7955" stroke-width="4" stroke-linecap="round"/><circle cx="14" cy="157" r="7" fill="white" stroke="#df9359" stroke-width="4"/><circle cx="315" cy="89" r="7" fill="white" stroke="#4c7955" stroke-width="4"/><g transform="translate(103 42) rotate(-8)"><rect width="98" height="52" rx="13" fill="white"/><circle cx="24" cy="26" r="13" fill="#eaf1e5"/><path d="M20 27l3 3 6-7" stroke="#50815a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="44" y="23" fill="#546457" font-size="9" font-family="sans-serif">沿途打卡</text><text x="44" y="37" fill="#9ba59b" font-size="7" font-family="sans-serif">真实走过 · 真实分享</text></g><circle cx="271" cy="28" r="3" fill="#cfdfbd"/><circle cx="289" cy="39" r="2" fill="#9ebd9f"/><circle cx="65" cy="53" r="3" fill="#d3dfc9"/></svg>`}
function routeCard(r) {
  const cover = r.cover ? `<img class="cover-photo" src="${esc(r.cover)}" alt="${esc(r.title)}路线封面" loading="lazy" decoding="async">` : `<div class="cover-placeholder"></div>${mapPlot(r.geometry || [], { demo: r.is_demo, compact: true })}`;
  return `<article class="route-card" data-route="${esc(r.id)}"><div class="route-cover">${cover}<div class="cover-shade"></div><div class="cover-label"><span>${esc(r.city || '城市漫游')}</span>${r.is_demo ? '<span class="demo-mark">演示路线</span>' : ''}</div><button class="favorite-button ${r.favorite ? 'is-favorite' : ''}" data-favorite="${esc(r.id)}" aria-pressed="${Boolean(r.favorite)}" aria-label="${r.favorite ? '取消收藏' : '收藏路线'}">${r.favorite ? '♥' : '♡'}</button></div><div class="route-card-body"><h3><a class="route-card-link" href="#/route/${esc(r.id)}">${esc(r.title)}</a></h3><div class="route-sub"><span>${esc(r.category || '城市漫游')}</span><span>·</span><span>${esc(r.nickname || '城迹用户')}</span></div><div class="route-meta"><div class="meta-group"><span>◷ ${fmtDuration(r.elapsed_seconds)}</span><span>↗ ${fmtDist(r.distance_m)}</span><span>⌖ ${r.checkpoint_count || 0}站</span></div><div class="author-line"><span class="mini-avatar">${esc(initial(r.nickname))}</span>${esc(r.nickname || '漫游者')}</div></div></div></article>`;
}
function setPage(html, page) {
  window.cleanupV2Page?.();
  navActive(page);
  app.innerHTML = html;
  app.dataset.page = page;
  app.setAttribute('aria-busy', 'false');
  app.querySelectorAll('.field').forEach((field, index) => {
    const label = field.querySelector(':scope > label');
    const input = field.querySelector('input:not([type=hidden]),select,textarea');
    if (label && input && !label.contains(input)) {
      if (!input.id) input.id = `field-${page}-${index}`;
      label.htmlFor = input.id;
    }
  });
  updateAppStatus();
  updateActiveJourney();
  mountMaps();
  if (state.focusNewPage) {
    const heading = app.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    state.focusNewPage = false;
  }
}
async function discover({ resultsOnly = false } = {}) {
  const view = state.viewToken, request = ++state.discoverRequest;
  const query = new URLSearchParams({ page: state.filter.page || 1, page_size: 12 });
  if (state.filter.q) query.set('q', state.filter.q);
  if (state.filter.city) query.set('city', state.filter.city);
  if (state.filter.category && state.filter.category !== '全部') query.set('category', state.filter.category);
  if (state.filter.duration) {
    const [min, max] = state.filter.duration.split('-');
    if (min) query.set('min_duration', min);
    if (max) query.set('max_duration', max);
  }
  const partial = resultsOnly && Boolean($('#discover-results'));
  if (partial) { $('#discover-results').setAttribute('aria-busy', 'true'); updateFilterSummary(); }
  let data, error;
  try { data = await api('/routes?' + query); } catch (e) { error = e; }
  if (view !== state.viewToken || request !== state.discoverRequest) return;
  if (data) state.routes = data.items;
  if (partial) {
    $('#discover-results').querySelectorAll('.map-plot').forEach(el => el._citytraceMap?.destroy());
    $('#discover-results').innerHTML = discoveryResults(data, error);
    $('#discover-results').setAttribute('aria-busy', 'false');
    updateFilterSummary(error ? null : data.total);
    bindDiscoverResults();
    mountMaps();
    return;
  }
  const cats = categories.map(c => `<button class="chip ${(state.filter.category || '全部') === c ? 'active' : ''}" data-category="${esc(c)}" aria-pressed="${(state.filter.category || '全部') === c}">${esc(c)}</button>`).join('');
  setPage(`<section class="hero"><div class="hero-copy"><span class="hero-tag"><i></i>真实路线 · 城市生活</span><h1>把走过的路，<br><em>分享给下一位。</em></h1><button class="button button-green" onclick="navigate('record')">◎&nbsp; 记录漫游</button></div><div class="hero-art">${svgHero()}<div class="hero-stamp"><strong>走过，才知道。</strong>在自己的城市里遇见新故事</div></div></section><div class="page-heading"><div><div class="eyebrow">ROUTES FROM REAL WALKS</div><h1>发现城市路线</h1><p>从真实轨迹里，找到下一段想去的地方。</p></div></div><div class="filter-row"><label class="searchbox"><span aria-hidden="true">⌕</span><input id="search-q" type="search" aria-label="搜索路线、城市或体验" placeholder="搜索路线、城市或体验" value="${esc(state.filter.q)}" enterkeyhint="search"></label><label class="searchbox city-search"><span aria-hidden="true">⌖</span><input id="search-city" type="search" aria-label="筛选城市" placeholder="城市" value="${esc(state.filter.city)}" enterkeyhint="search"></label><select class="filter-select" id="duration-filter" aria-label="路线时长"><option value="">不限时长</option><option value="0-7200" ${state.filter.duration === '0-7200' ? 'selected' : ''}>2 小时以内</option><option value="7200-18000" ${state.filter.duration === '7200-18000' ? 'selected' : ''}>2–5 小时</option><option value="18000-999999" ${state.filter.duration === '18000-999999' ? 'selected' : ''}>5 小时以上</option></select></div><div class="chip-row" aria-label="路线主题">${cats}</div><div class="section-head"><div><h2>最近发布</h2><p id="discover-count" role="status">${data ? `${data.total} 条公开路线` : '暂时无法加载'}</p></div><div class="filter-summary"><button class="text-link hidden" id="clear-filters">清除筛选</button><a class="text-link" href="#/map">地图查看 ↗</a></div></div><div class="discovery-results" id="discover-results" aria-busy="false">${discoveryResults(data, error)}</div>`, 'discover');
  bindDiscover();
  updateFilterSummary(error ? null : data.total);
}
function bindDiscover() {
  clearTimeout(state.searchTimer);
  const search = () => {
    clearTimeout(state.searchTimer);
    state.filter.q = $('#search-q')?.value.trim() || '';
    state.filter.city = $('#search-city')?.value.trim() || '';
    state.filter.duration = $('#duration-filter')?.value || '';
    state.filter.page = 1;
    discover({ resultsOnly: true });
  };
  for (const input of [$('#search-q'), $('#search-city')]) {
    input?.addEventListener('input', event => {
      if (event.isComposing) return;
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(search, 350);
    });
    input?.addEventListener('compositionend', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(search, 350); });
    input?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); search(); } });
  }
  $('#duration-filter')?.addEventListener('change', search);
  $('#clear-filters')?.addEventListener('click', resetDiscoverFilters);
  $$('[data-category]').forEach(b => b.onclick = () => { state.filter.category = b.dataset.category; search(); });
  bindDiscoverResults();
}
async function mapPage() {
  const view = state.viewToken, page = state.mapPage || 1;
  let data;
  try { data = await api(`/routes?page=${page}&page_size=30`); }
  catch (error) {
    if (view !== state.viewToken) return;
    setPage(errorPage('地图路线暂时无法加载', error, "navigate('map')"), 'map'); return;
  }
  if (view !== state.viewToken) return;
  if (!data.items.length && data.total && page > 1) { state.mapPage = 1; return mapPage(); }
  state.routes = data.items;
  const routes = data.items, pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const groups = routes.map(route => `<button class="trip-card" data-map-route="${esc(route.id)}" style="text-align:left;width:100%"><span class="trip-icon" aria-hidden="true">⌖</span><span class="trip-copy"><strong>${esc(route.title)}</strong><span class="field-hint">${esc(route.city)} · ${fmtDist(route.distance_m)} · ${route.checkpoint_count || 0} 个打卡点</span></span><span class="text-link">查看 →</span></button>`).join('');
  const paths = routes.flatMap(route => route.geometry_segments?.length ? route.geometry_segments : route.geometry?.length ? [route.geometry] : []);
  setPage(`<div class="page-heading"><div><div class="eyebrow">CITY ROUTES</div><h1>路线地图</h1><p>在城市里，看看下一段想走的路。</p></div><span class="demo-badge">${state.config.amap_key ? '高德地图' : '轨迹坐标示意'}</span></div><div class="panel map-page-panel">${mapPlot([], { class: 'detail-map', paths, label: '本页公开路线 · 坐标示意，非道路导航', demo: routes.length && routes.every(route => route.is_demo) })}</div><div class="notice-banner">${state.config.amap_key ? '地图展示本页公开路线，点击下方路线可查看沿途地点与路书。' : '地图服务尚未配置，当前按真实 GPS 坐标显示路线线稿。可打开路线查看沿途地点，并用外部地图导航。'}</div><div class="section-head"><div><h2>公开的城市路线</h2><p>共 ${data.total} 条${pages > 1 ? ` · 本页 ${routes.length} 条` : ''}</p></div><a class="text-link" href="#/discover">搜索路线 ↗</a></div>${groups || '<div class="empty-state"><strong>还没有公开路线</strong><p>从一段真实记录开始，整理你的第一条城市路线。</p><a class="button button-outline" href="#/record">开始记录</a></div>'}${pages > 1 ? `<nav class="pagination" aria-label="地图路线分页"><button class="button button-outline" data-map-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${pages} 页</span><button class="button button-outline" data-map-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button></nav>` : ''}`, 'map');
  $$('[data-map-route]').forEach(button => button.onclick = () => navigate(`route/${button.dataset.mapRoute}`));
  $$('[data-map-page]').forEach(button => button.onclick = () => { state.mapPage = Number(button.dataset.mapPage); mapPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}
async function routeDetailLegacy(id){const view=state.viewToken;try{const value=await api(`/routes/${id}`);if(view!==state.viewToken)return;state.route=value}catch(e){if(view!==state.viewToken)return;setPage(`<div class="empty-state"><div class="empty-icon">⌖</div><strong>这条路线暂时无法查看</strong><p>${esc(e.message)}</p><button class="button button-outline" onclick="navigate('discover')">返回发现</button></div>`,'discover');return}const r=state.route;const owner=state.me?.id===r.user_id;const privateMap=owner&&r.status!=='published';const routeMapGeometry=privateMap?(r.private_track?.cleaned_geometry||[]):r.geometry;const cplist=r.checkpoints||[];const first=cplist[0];const timeline=cplist.map((c,i)=>`<div class="timeline-item"><div class="timeline-dot">${i+1}</div><div class="timeline-body"><strong>${esc(c.name)}</strong><p>${esc(c.note||c.recommended||`${c.kind}打卡点`)}</p>${c.recommended?`<div class="timeline-meta">推荐：${esc(c.recommended)}${c.spend?` · 约 ¥${c.spend}`:''}</div>`:''}${c.photos?.length?`<div style="display:flex;gap:7px;margin-top:8px">${c.photos.map(p=>`<img class="photo-thumb" src="${esc(p.url)}" alt="打卡照片">`).join('')}</div>`:''}</div></div>`).join('');const segments=r.segments?.length?r.segments.map(s=>`<div class="leg-item"><span>${esc(s.start_label||`路段 ${s.position+1}`)} → ${esc(s.end_label||'下一站')}</span><span class="leg-mode">${esc(s.mode)}</span></div>`).join(''):'<div class="leg-item"><span>作者尚未补充交通路段</span><span class="leg-mode">—</span></div>';
setPage(`<div class="route-detail-head"><button class="back-link" onclick="navigate('discover')" aria-label="返回">←</button><div class="route-detail-title"><h1>${esc(r.title)}</h1><p>${esc(r.city||'城市漫游')} · ${esc(r.category)} · ${esc(r.nickname||'城迹用户')} · ${r.is_demo?'<span class="demo-badge">演示数据</span>':''}</p></div><div class="route-detail-actions">${owner&&['draft','rejected'].includes(r.status)?`<button class="button button-outline" onclick="navigate('edit/${r.id}')">编辑路线</button>`:''}<button class="button button-outline" id="detail-favorite">${r.favorite?'♥ 已收藏':'♡ 收藏路线'}</button><button class="button button-green" id="start-follow">↗ 开始复刻</button><button class="button button-outline" id="share-route" ${r.status==='published'?'':'disabled'}>${r.status==='published'?'分享':'公开后分享'}</button></div></div>${owner&&r.status!=='published'?`<div class="owner-notice">当前状态：${esc(statusLabel(r.status))}。${r.status==='draft'?'这是仅你可见的路线草稿。':''}</div>`:''}<div class="detail-layout"><div class="detail-main"><section class="panel"><div class="panel-heading"><h2>这段城市轨迹</h2><small>${r.is_demo?'演示路线':privateMap?'作者私有 GPS 轨迹':'公开轨迹已隐藏起终点约 150 米'}</small></div>${mapPlot(routeMapGeometry,{class:'detail-map',demo:r.is_demo,private:privateMap})}<div class="stats-row"><div class="stat"><strong>${fmtDuration(r.elapsed_seconds)}</strong><small>实际行程</small></div><div class="stat"><strong>${fmtDist(r.distance_m)}</strong><small>移动距离</small></div><div class="stat"><strong>${r.moving_seconds?fmtDuration(r.moving_seconds):'未记录'}</strong><small>有效采样估算</small></div><div class="stat"><strong>${cplist.length}</strong><small>打卡地点</small></div></div></section><section class="panel"><div class="panel-heading"><h2>沿途打卡</h2><small>按路线顺序</small></div>${timeline||'<div class="empty-state" style="padding:22px">作者还没有添加打卡点。</div>'}</section>${r.description?`<section class="panel"><div class="panel-heading"><h2>路线介绍</h2></div><div style="font-size:11px;line-height:1.8;color:#718075;white-space:pre-wrap">${esc(r.description)}</div></section>`:''}</div><aside class="detail-aside"><section class="panel"><div class="panel-heading"><h2>路线信息</h2><small>来自一次真实记录</small></div><div class="leg-item"><span>城市</span><strong>${esc(r.city||'未标注')}</strong></div><div class="leg-item"><span>主题</span><strong>${esc(r.category)}</strong></div><div class="leg-item"><span>收藏</span><strong>${r.favorite_count||0}</strong></div><div style="margin-top:15px">${segments}</div></section>${first?`<section class="panel"><div class="panel-heading"><h2>从第一站开始</h2><small>${esc(first.kind)}</small></div><strong style="font-size:13px">${esc(first.name)}</strong><p style="font-size:10px;color:#869188;line-height:1.7">${esc(first.note||'沿着路线，去看看这里。')}</p><button class="button button-outline button-wide" data-external-map data-map-lat="${Number(first.lat)}" data-map-lon="${Number(first.lon)}" data-map-name="${esc(first.name)}">↗ 打开外部地图</button></section>`:''}<div class="owner-notice">公开轨迹只展示隐私处理后的路线。真实 GPS 原始采样点仅路线作者可见。</div><button class="text-link" id="report-route" style="justify-self:start">举报这条路线</button></aside></div>`,'discover');$$('[data-external-map]').forEach(b=>b.onclick=()=>openExternalMap(Number(b.dataset.mapLat),Number(b.dataset.mapLon),b.dataset.mapName));$('#detail-favorite').onclick=async()=>{if(!state.me){openAuth();return}try{await api(`/routes/${r.id}/favorite`,{method:r.favorite?'DELETE':'POST'});toast(r.favorite?'已取消收藏':'已收藏');routeDetail(r.id)}catch(e){toast(e.message,'error')}};$('#start-follow').onclick=async()=>{if(!state.me){openAuth();return}const button=$('#start-follow');if(button.disabled)return;button.disabled=true;try{const f=await api(`/routes/${r.id}/follow`,{method:'POST',body:{}});toast('复刻行程已创建，路线内容已保存快照');navigate(`follow/${f.id}`)}catch(e){toast(e.message,'error')}finally{button.disabled=false}};$('#share-route').onclick=()=>shareRouteLink(r);$('#report-route').onclick=()=>openReport(r.id)}
function openExternalMap(lat,lon,name){if(!Number.isFinite(lat)||!Number.isFinite(lon)){toast('这个站点没有有效坐标','error');return}window.open(`https://maps.apple.com/?daddr=${encodeURIComponent(`${lat},${lon}`)}&dirflg=w`,'_blank','noopener,noreferrer')}

function locationCapability() {
  if (!window.isSecureContext) return '手机定位需要安全连接。请通过 HTTPS 地址打开城迹，再开始记录；当前地址仍可浏览和手动确认复刻站点。';
  if (!navigator.geolocation) return '当前浏览器无法提供定位，请使用支持定位的浏览器并开启系统位置服务。';
  return '';
}
function ensureTrackSync() {
  if (state.syncTimer) clearInterval(state.syncTimer);
  if (state.track && ['recording', 'paused'].includes(state.track.status)) state.syncTimer = setInterval(flushQueue, 6000);
  else state.syncTimer = null;
}
async function drainTrackQueue() {
  if (state.flushPromise) await state.flushPromise;
  while (state.track && state.queue.some(point => point.track_id === state.track.id)) {
    const before = state.queue.length;
    if (!await flushQueue() || state.queue.length >= before) return false;
  }
  return true;
}
function setRecordActionBusy(busy, message = '') {
  state.recordActionBusy = busy;
  $$('.record-actions .button,.record-start').forEach(button => { button.disabled = busy; });
  if (message && $('#record-status-message')) $('#record-status-message').textContent = message;
}
async function ensureTrack() {
  if (!state.me) return;
  if (state.trackLoadPromise) return state.trackLoadPromise;
  const userId = state.me.id;
  state.trackLoadPromise = (async () => {
    try {
      let track = await api('/tracks/active');
      if (!track) {
        const last = storageRead(trackStorageKey(LAST_TRACK)) || storageRead('citytrace.lastTrack.v1');
        if (last) {
          try {
            const saved = await api(`/tracks/${last}`);
            if (saved.status === 'finished') track = saved;
            else storageRemove(trackStorageKey(LAST_TRACK));
          } catch (error) { if ([403, 404].includes(error.status)) storageRemove(trackStorageKey(LAST_TRACK)); }
        }
      }
      if (state.me?.id !== userId) return;
      state.track = track;
      state.queue = readQueue();
      if (track) {
        storageWrite(trackStorageKey(LAST_TRACK), track.id);
        // Only migrate legacy GPS after the server confirms this user's ownership.
        let legacy = [];
        try { legacy = JSON.parse(storageRead('citytrace.pendingPoints.v1', '[]')); } catch {}
        if (Array.isArray(legacy)) {
          const own = legacy.filter(point => point.track_id === track.id);
          const known = new Set(state.queue.map(point => point.client_id));
          state.queue.push(...own.filter(point => !known.has(point.client_id)));
          if (own.length && saveQueue()) storageWrite('citytrace.pendingPoints.v1', JSON.stringify(legacy.filter(point => point.track_id !== track.id)));
        }
        ensureTrackSync();
        if (state.queue.some(point => point.track_id === track.id)) flushQueue();
      }
      updateActiveJourney();
    } catch (error) { if (error.status !== 401) toast(error.message, 'error'); }
  })().finally(() => { state.trackLoadPromise = null; });
  return state.trackLoadPromise;
}
function readQueue() {
  if (!state.me) return [];
  try {
    const points = JSON.parse(storageRead(trackStorageKey(STORE), '[]'));
    return Array.isArray(points) ? points.filter(point => point && typeof point.track_id === 'string' && typeof point.client_id === 'string') : [];
  } catch { return []; }
}
function saveQueue() {
  if (!state.me) return false;
  return storageWrite(trackStorageKey(STORE), JSON.stringify(state.queue.slice(-2000)));
}
async function flushQueue() {
  if (state.flushPromise) return state.flushPromise;
  const track = state.track;
  if (!state.me || !track || track.status === 'finished' || !navigator.onLine) return false;
  const batch = state.queue.filter(point => point.track_id === track.id).slice(0, 100);
  if (!batch.length) return true;
  const userId = state.me.id;
  state.flushPromise = (async () => {
    try {
      await api(`/tracks/${track.id}/points`, { method: 'POST', body: { samples: batch } });
      if (state.me?.id !== userId || state.track?.id !== track.id) return false;
      const sent = new Set(batch.map(point => point.client_id));
      state.queue = state.queue.filter(point => !sent.has(point.client_id));
      saveQueue();
      state.syncError = '';
      state.lastSyncedAt = Date.now();
      try {
        const fresh = await api(`/tracks/${track.id}`);
        if (state.me?.id === userId && state.track?.id === track.id) state.track = fresh;
      } catch { /* Upload was acknowledged; retain the last confirmed summary until the next sync. */ }
      updateRecordReadout();
      return true;
    } catch (error) {
      state.syncError = error.message;
      updateRecordReadout();
      return false;
    }
  })().finally(() => { state.flushPromise = null; });
  return state.flushPromise;
}
function enqueueFix(pos) {
  if (!state.track || state.track.status !== 'recording' || state.suspendSampling) return;
  const c = pos.coords, time = Date.now();
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
  state.lastFix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, ts: pos.timestamp };
  state.recordPosition = state.lastFix;
  state.geoStatus = 'ready';
  state.geoMessage = c.accuracy > 100 ? `定位精度约 ${Math.round(c.accuracy)} 米，信号较弱；原始采样保留，但异常点不会计入有效距离。` : `定位正常 · 精度约 ${Math.round(c.accuracy)} 米`;
  updateRecordReadout();
  if (time - state.lastSampleAt < 4500) return;
  state.lastSampleAt = time;
  state.queue.push({ track_id: state.track.id, client_id: globalThis.crypto?.randomUUID?.() || `${time}-${Math.random().toString(36).slice(2)}`, lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, ts: pos.timestamp });
  if (state.queue.length > 2000) {
    state.queue = state.queue.slice(-2000);
    toast('待同步采样已达本机上限，请尽快联网保存。', 'warn');
  }
  saveQueue();
  flushQueue();
  updateRecordReadout();
}
function geoError(err) {
  const messages = { 1: '定位权限被拒绝。请在浏览器的站点设置中允许位置访问，再点击重试定位。', 2: '暂时无法确定位置。请开启系统定位服务，并移到信号较好的位置后重试。', 3: '定位超时。请保持页面在前台，在开阔位置重试。' };
  const message = locationCapability() || messages[err.code] || '定位失败，请检查系统和浏览器的位置权限。';
  if (state.geoMessage !== message) toast(message, 'warn');
  state.geoMessage = message;
  state.geoStatus = 'error';
  if ($('#record-status-message')) $('#record-status-message').textContent = message;
  updateRecordReadout();
}
function watchTrack() {
  if (state.watch !== null || state.track?.status !== 'recording') return;
  const unavailable = locationCapability();
  if (unavailable) { state.geoMessage = unavailable; state.geoStatus = 'error'; updateRecordReadout(); return; }
  state.geoStatus = 'waiting';
  state.geoMessage = '正在获取位置，请保持页面在前台…';
  state.watch = navigator.geolocation.watchPosition(enqueueFix, geoError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  updateRecordReadout();
}
function stopWatch() {
  if (state.watch !== null) navigator.geolocation?.clearWatch(state.watch);
  state.watch = null;
}
async function startTrack() {
  if (state.recordActionBusy) return;
  if (!state.me) { openAuth(); return; }
  const unavailable = locationCapability();
  if (unavailable) { state.geoMessage = unavailable; renderRecord(); toast(unavailable, 'warn'); return; }
  if (!navigator.onLine) { toast('开始记录需要先联网，已有记录的采样可离线暂存。', 'warn'); return; }
  setRecordActionBusy(true, '正在确认定位权限…');
  try {
    const first = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }));
    state.track = await api('/tracks', { method: 'POST', body: { idempotency_key: globalThis.crypto?.randomUUID?.() || `track-${Date.now()}` } });
    storageWrite(trackStorageKey(LAST_TRACK), state.track.id);
    state.queue = readQueue();
    state.lastSampleAt = 0;
    state.lastFix = null;
    state.syncError = '';
    state.suspendSampling = false;
    enqueueFix(first);
    ensureTrackSync();
    if (state.page === 'record') renderRecord();
    else updateActiveJourney();
    watchTrack();
    toast('已开始记录，请保持页面在前台。');
  } catch (error) {
    if (typeof error.code === 'number') geoError(error);
    else {
      if (error.status === 409) { await ensureTrack(); if (state.page === 'record') renderRecord(); }
      toast(error.message, 'error');
    }
  } finally { setRecordActionBusy(false); }
}
async function pauseTrack() {
  if (state.recordActionBusy || state.track?.status !== 'recording') return;
  setRecordActionBusy(true, '正在保存采样并暂停…');
  const id = state.track.id;
  state.suspendSampling = true;
  stopWatch();
  try {
    if (!await drainTrackQueue()) throw Error('仍有轨迹尚未同步，请联网后再暂停。');
    state.track = await api(`/tracks/${id}/pause`, { method: 'POST', body: {} });
    state.geoMessage = '已暂停采样，暂停时段不会连接成连续轨迹。';
    if (state.page === 'record') renderRecord();
    updateActiveJourney();
    toast('记录已暂停');
  } catch (error) { toast(error.message, 'error'); }
  finally {
    state.suspendSampling = false;
    if (state.track?.status === 'recording') watchTrack();
    setRecordActionBusy(false);
  }
}
async function resumeTrack() {
  if (state.recordActionBusy || state.track?.status !== 'paused') return;
  const unavailable = locationCapability();
  if (unavailable) { state.geoMessage = unavailable; updateRecordReadout(); toast(unavailable, 'warn'); return; }
  setRecordActionBusy(true, '正在继续记录…');
  try {
    state.track = await api(`/tracks/${state.track.id}/resume`, { method: 'POST', body: {} });
    state.suspendSampling = false;
    ensureTrackSync();
    watchTrack();
    if (state.page === 'record') renderRecord();
    updateActiveJourney();
    toast('已继续记录');
  } catch (error) { toast(error.message, 'error'); } finally { setRecordActionBusy(false); }
}
async function finishTrack() {
  if (state.recordActionBusy || !state.track) return;
  setRecordActionBusy(true, '正在同步并保存路线…');
  state.suspendSampling = true;
  stopWatch();
  const id = state.track.id;
  try {
    if (!await drainTrackQueue()) throw Error('还有未同步的 GPS 点，已保留在本机；联网后再结束。');
    if (state.track.status !== 'finished') state.track = await api(`/tracks/${id}/finish`, { method: 'POST', body: {} });
    clearInterval(state.syncTimer);
    state.syncTimer = null;
    const route = await api('/routes', { method: 'POST', body: { track_id: id, title: '未命名城市路线' } });
    storageRemove(trackStorageKey(LAST_TRACK));
    if (storageRead('citytrace.lastTrack.v1') === id) storageRemove('citytrace.lastTrack.v1');
    state.queue = state.queue.filter(point => point.track_id !== id);
    saveQueue();
    state.track = null;
    clearInterval(state.recordTicker);
    state.recordTicker = null;
    updateActiveJourney();
    toast('记录已保存为私有草稿');
    navigate(`edit/${route.id}`);
  } catch (error) {
    if (state.page === 'record') renderRecord();
    toast(`尚未保存为路线：${error.message}`, 'error');
  } finally {
    state.suspendSampling = false;
    if (state.track?.status === 'recording') watchTrack();
    setRecordActionBusy(false);
    updateActiveJourney();
  }
}
function recordElapsed(){if(!state.track)return 0;const start=new Date(state.track.started_at).getTime();const end=state.track.ended_at?new Date(state.track.ended_at).getTime():Date.now();let paused=Number(state.track.paused_seconds||0);if(state.track.status==='paused'&&state.track.pause_started_at)paused+=Math.max(0,(Date.now()-new Date(state.track.pause_started_at).getTime())/1000);return Math.max(0,(end-start)/1000-paused)}
function recordPath() { return state.track?.cleaned_geometry || []; }
function renderRecord() {
  const tr = state.track, unavailable = locationCapability();
  if (!tr) {
    setPage(`<div class="page-heading"><div><div class="eyebrow">YOUR REAL ROUTE</div><h1>记录一段路</h1><p>沿着城市走一走，把真实发生的体验留下来。</p></div><span class="demo-badge">原始轨迹默认私有</span></div><div class="panel record-panel"><div>${mapPlot([], { class: 'record-map', label: '等待真实 GPS 采样' })}</div><div class="record-controls"><div class="record-state"><i></i>准备出发</div><div class="record-clock">00:00:00</div><div class="record-caption">实际记录时长</div><div class="record-stats"><div class="record-stat"><strong>0 米</strong><small>移动距离</small></div><div class="record-stat"><strong>${unavailable ? '定位不可用' : '等待授权'}</strong><small>GPS 状态</small></div></div><button class="button button-green button-wide record-start" onclick="startTrack()" ${unavailable ? 'disabled' : ''}>${unavailable ? '需要安全连接才能记录' : '◎ 开始记录'}</button><div id="record-status-message" class="permission-box" role="status">${esc(unavailable || state.geoMessage || '开始时请求定位权限，确认获得位置后再创建记录。请保持页面在前台，锁屏或切换应用可能中断采样。')}</div></div></div><div class="section-head"><div><h2>记录，然后决定分享</h2><p>走过的每一步，都由你掌握。</p></div></div><div class="route-grid"><section class="panel"><div class="panel-heading"><h2>01 · 真实记录</h2></div><p class="field-hint">前台 GPS 采样。网络短暂中断时，已有记录的采样会在本机有限暂存。</p></section><section class="panel"><div class="panel-heading"><h2>02 · 留下沿途体验</h2></div><p class="field-hint">结束记录后，补充沿途地点、照片和交通方式，整理成自己的城市路书。</p></section><section class="panel"><div class="panel-heading"><h2>03 · 确认后再公开</h2></div><p class="field-hint">草稿仅自己可见。检查隐私范围并通过审核后，其他人才可收藏与复刻。</p></section></div>`, 'record');
    return;
  }
  const live = tr.status === 'recording', latest = state.lastFix || tr.points?.at(-1);
  setPage(`<div class="page-heading"><div><div class="eyebrow">GPS SESSION</div><h1>${tr.status === 'paused' ? '歇一歇，稍后继续' : tr.status === 'finished' ? '记录已结束' : '正在记录这段路'}</h1><p>${tr.status === 'finished' ? '轨迹已保存在服务器，可以继续保存为路线草稿。' : '保持页面在前台，采样会自动同步。'}</p></div><span class="demo-badge">${tr.is_demo ? '演示数据' : '原始轨迹私有'}</span></div><div class="panel record-panel"><div>${mapPlot(recordPath(), { class: 'record-map', label: '真实采样轨迹 · 非道路导航', private: true })}</div><div class="record-controls"><div class="record-state ${live ? 'live' : ''}"><i></i>${live ? '记录进行中' : tr.status === 'paused' ? '已暂停采样' : '采样已保存'}</div><div class="record-clock" id="record-clock">${fmtClock(recordElapsed())}</div><div class="record-caption">实际记录时长 · 已扣除暂停时间</div><div class="record-stats"><div class="record-stat"><strong id="record-distance">${fmtDist(tr.distance_m)}</strong><small>有效移动距离</small></div><div class="record-stat"><strong id="record-accuracy">${latest ? `± ${Math.round(latest.accuracy)} 米` : '等待定位'}</strong><small>当前 GPS 精度</small></div><div class="record-stat"><strong id="record-saved">${tr.point_count || 0}</strong><small>服务端已保存采样</small></div><div class="record-stat"><strong id="record-pending">${state.queue.filter(point => point.track_id === tr.id).length}</strong><small>本机待同步采样</small></div></div><div class="record-actions">${live ? '<button class="button button-outline" onclick="pauseTrack()">Ⅱ 暂停</button>' : tr.status === 'paused' ? '<button class="button button-green" onclick="resumeTrack()">▶ 继续</button>' : ''}<button class="button button-dark" onclick="finishTrack()">${tr.status === 'finished' ? '保存为路线草稿' : '结束并保存'}</button></div><div class="permission-box" id="record-status-message" role="status">${esc(state.geoMessage || (tr.status === 'paused' ? '暂停期间不采样，可随时继续。' : unavailable || '正在等待位置…'))}</div>${live ? '<button class="button button-outline button-wide" id="retry-record-location">重新获取位置</button>' : ''}<div class="privacy-callout"><strong id="record-sync-message"></strong><br>公开发布前可以再次检查路线；原始 GPS 始终保持私有。</div></div></div>`, 'record');
  $('#retry-record-location')?.addEventListener('click', () => { stopWatch(); watchTrack(); });
  if (live) {
    if (!state.recordTicker) state.recordTicker = setInterval(updateRecordReadout, 1000);
    if (!state.suspendSampling) watchTrack();
  } else {
    clearInterval(state.recordTicker); state.recordTicker = null;
  }
  ensureTrackSync();
  updateRecordReadout();
  setRecordActionBusy(state.recordActionBusy);
}
function updateRecordReadout() {
  const track = state.track;
  if (!track) return;
  const latest = state.lastFix || track.points?.at(-1);
  const values = {
    'record-clock': fmtClock(recordElapsed()),
    'record-distance': fmtDist(track.distance_m),
    'record-accuracy': latest ? `± ${Math.round(latest.accuracy)} 米` : '等待定位',
    'record-saved': track.point_count || 0,
    'record-pending': state.queue.filter(point => point.track_id === track.id).length,
    'record-status-message': state.geoMessage || '',
    'record-sync-message': state.syncError ? `同步尚未成功：${state.syncError} · 采样保留并继续重试` : !navigator.onLine ? '离线 · 待同步采样保存在本机' : state.queue.some(point => point.track_id === track.id) ? '正在同步采样…' : state.lastSyncedAt ? '采样已同步至服务器' : '联网中 · 等待真实采样'
  };
  for (const [id, value] of Object.entries(values)) {
    const node = $('#' + id);
    if (node && node.textContent !== String(value)) node.textContent = value;
  }
  updateActiveJourney();
  if (state.page === 'record') window.refreshRecordMapV2?.();
}
function loginRequired(title, copy, page, next) {
  setPage(`<section class="auth-card"><div class="eyebrow">YOUR CITYTRACE</div><h1>${esc(title)}</h1><p>${esc(copy)}</p><button class="button button-green button-wide" id="login-required">登录 / 注册</button><a class="button button-outline button-wide" href="#/discover" style="margin-top:12px">先去发现路线</a></section>`, page);
  $('#login-required').onclick = () => openAuth(next);
}
async function editor(id) {
  if (!state.me) { loginRequired('登录后继续编辑', '路线草稿和原始轨迹仅作者本人可见。', 'trips', `edit/${id}`); return; }
  const view=state.viewToken;
  try {
    const route=await api(`/routes/${id}`);
    if(view!==state.viewToken)return;
    state.editorRoute=route;
    renderEditor(route);
  } catch(error) {
    if(view!==state.viewToken)return;
    setPage(errorPage('无法打开路线编辑器',error,`navigate('edit/${id}')`),'trips');
  }
}
function renderEditorLegacy(r){if(!state.me||state.me.id!==r.user_id){navigate('trips');toast('只有路线作者可以编辑','error');return}const segments=r.segments||[],cps=r.checkpoints||[];const privatePts=r.private_track?.points||[];const locOptions=privatePts.slice(0,120).map((p,i)=>`<option value="${p.lat},${p.lon}">轨迹点 ${i+1} · ${new Date(p.ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</option>`).join('');const segRows=segments.map(s=>`<div class="list-row"><span class="trip-icon">↗</span><div class="row-main"><strong>${esc(s.start_label||'起点')} → ${esc(s.end_label||'下一站')} · ${esc(s.mode)}</strong><small>第 ${s.position+1} 段 · ${fmtClock(s.start_offset)}–${fmtClock(s.end_offset)} · ${s.source==='manual'?'手动确认':'轨迹关联'}</small></div><button class="row-action" data-edit-seg="${s.id}">编辑</button><button class="row-action" data-delete-seg="${s.id}">删除</button></div>`).join('');const cpRows=cps.map(c=>`<div class="list-row"><span class="step-number">${c.position+1}</span><div class="row-main"><strong>${esc(c.name)} · ${esc(c.kind)}</strong><small>${esc(c.location_source==='manual'?'手动确认位置':c.location_source==='track'?'轨迹选点':'实时定位')}${c.recommended?` · 推荐 ${esc(c.recommended)}`:''}${c.spend?` · ¥${c.spend}`:''}</small>${c.photos?.length?`<div style="display:flex;gap:5px;margin-top:6px">${c.photos.map(p=>`<img class="photo-thumb" src="${esc(p.url)}" alt="已上传照片">`).join('')}</div>`:''}</div><label class="row-action" title="上传现场照片">照片<input type="file" accept="image/jpeg,image/png,image/webp" data-photo-checkpoint="${c.id}" hidden></label><button class="row-action" data-edit-cp="${c.id}">编辑</button><button class="row-action" data-delete-cp="${c.id}">删除</button></div>`).join('');setPage(`<div class="page-heading"><div><div class="eyebrow">ROUTE STUDIO</div><h1>编辑你的路线</h1><p>这条路线从真实 GPS 记录开始，原始轨迹不会被编辑内容覆盖。</p></div><span class="status-pill ${r.status}">${statusLabel(r.status)}</span></div><div class="editor-grid"><div class="editor-stack"><section class="panel"><div class="panel-heading"><h2>路线信息</h2><small>草稿仅自己可见</small></div><div class="form-grid"><div class="field full"><label>路线名称</label><input id="edit-title" maxlength="100" value="${esc(r.title)}" placeholder="给这段城市路线起个名字"></div><div class="field"><label>所在城市</label><input id="edit-city" maxlength="80" value="${esc(r.city)}" placeholder="例如：福州"></div><div class="field"><label>路线主题</label><select id="edit-category">${categories.filter(c=>c!=='全部').map(c=>`<option ${r.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="field full"><label>路线介绍</label><textarea id="edit-description" maxlength="3000" placeholder="记下这一路上值得分享的体验">${esc(r.description)}</textarea></div><div class="field full"><label>路线封面</label><input id="cover-file" type="file" accept="image/jpeg,image/png,image/webp"><span class="field-hint">支持 JPG、PNG、WebP，最大 8 MB；上传时会清除照片中的 EXIF 与定位信息。</span></div></div><div class="form-actions"><button class="button button-green" id="save-route">保存路线信息</button></div></section><section class="panel"><div class="panel-heading"><h2>交通路段</h2><small>实际耗时 ${fmtDuration(r.elapsed_seconds)}</small></div>${segRows||'<p class="field-hint">还没有交通分段。可以补充分段和交通方式；地铁等 GPS 中断区间请标记为手动确认。</p>'}<div class="form-grid" style="margin-top:13px"><div class="field"><label>交通方式</label><select id="seg-mode">${modes.map(m=>`<option>${m}</option>`).join('')}</select></div><div class="field"><label>路段顺序</label><input id="seg-position" type="number" min="0" value="${segments.length}"></div><div class="field"><label>起点</label><input id="seg-from" maxlength="100" placeholder="起点/上车站"></div><div class="field"><label>终点</label><input id="seg-to" maxlength="100" placeholder="终点/下车站"></div><div class="field"><label>开始时间（行程后分钟）</label><input id="seg-start" type="number" min="0" value="0"></div><div class="field"><label>结束时间（行程后分钟）</label><input id="seg-end" type="number" min="0" value="0"></div></div><div class="form-actions"><button class="button button-outline" id="add-segment">＋ 添加路段</button></div></section><section class="panel"><div class="panel-heading"><h2>沿途打卡点</h2><small>${cps.length} 个地点</small></div>${cpRows||'<p class="field-hint">添加真实位置的沿途门店、景点或休息点。</p>'}<div class="form-grid" style="margin-top:13px"><div class="field full"><label>打卡名称</label><input id="cp-name" maxlength="120" placeholder="例如：巷口的一家鱼丸店"></div><div class="field"><label>打卡类型</label><select id="cp-kind">${kinds.map(k=>`<option>${k}</option>`).join('')}</select></div><div class="field"><label>路线顺序</label><input id="cp-position" type="number" min="0" value="${cps.length}"></div><div class="field full"><label>地点位置</label><div class="add-row"><select id="track-point" ${privatePts.length?'':'disabled'}><option value="">从历史轨迹选点</option>${locOptions}</select><button class="button button-outline button-small" id="use-location">定位</button></div><span class="field-hint">也可以手动填写经纬度；事后地图选点请标记为手动确认位置。</span></div><div class="field"><label>纬度</label><input id="cp-lat" type="number" step="any" placeholder="26.09"></div><div class="field"><label>经度</label><input id="cp-lon" type="number" step="any" placeholder="119.30"></div><div class="field full"><label>推荐美食 / 体验</label><input id="cp-recommended" maxlength="300" placeholder="招牌菜或值得体验的事"></div><div class="field"><label>消费金额（元）</label><input id="cp-spend" type="number" min="0" value="0"></div><div class="field"><label>停留时间（分钟）</label><input id="cp-stay" type="number" min="0" value="0"></div><div class="field full"><label>现场体验</label><textarea id="cp-note" maxlength="1200" placeholder="现场感受、排队情况、路线提示"></textarea></div></div><div class="form-actions"><button class="button button-green" id="add-checkpoint">＋ 添加打卡点</button></div></section></div><aside class="editor-stack"><section class="panel"><div class="panel-heading"><h2>真实轨迹预览</h2><small>${fmtDist(r.distance_m)}</small></div>${mapPlot(r.private_track?.cleaned_geometry||r.geometry,{class:'record-map',label:'本人轨迹坐标示意 · 私有',demo:r.is_demo,private:true})}<div class="stats-row"><div class="stat"><strong>${fmtDuration(r.elapsed_seconds)}</strong><small>实际耗时</small></div><div class="stat"><strong>${fmtDist(r.distance_m)}</strong><small>有效距离</small></div></div>${r.is_demo?'<div class="owner-notice" style="margin-top:13px">演示数据：请使用自己的实际记录创建真实路线。</div>':''}</section><section class="panel"><div class="panel-heading"><h2>发布前隐私预览</h2></div><p style="font-size:10px;line-height:1.7;color:#7d887f;margin:0">公开版本会从轨迹起点和终点各裁剪约 150 米。原始 GPS 坐标始终仅作者本人可查看。</p><label style="display:flex;align-items:flex-start;gap:8px;margin-top:13px;font-size:10px;line-height:1.6;color:#69766d"><input type="checkbox" id="privacy-confirm" style="margin-top:2px">我已检查路线与打卡点，不含不希望公开的住家、办公地点等敏感信息。</label></section><section class="panel"><div class="panel-heading"><h2>保存与提交</h2></div>${r.status==='pending_review'?'<div class="notice-banner">路线正在等待管理员审核，通过前不会出现在公开发现列表。</div>':''}<button class="button button-green button-wide" id="submit-route" ${r.status==='pending_review'?'disabled':''}>提交公开审核</button><p class="field-hint" style="margin:10px 0 0;line-height:1.6">发布需经过审核。用户只有在审核通过后，才能收藏和复刻。</p></section></aside></div>`,'trips');bindEditor(r)}
function statusLabel(s){return({draft:'草稿',pending_review:'审核中',published:'已公开',rejected:'未通过',withdrawn:'已撤回',unpublished:'已下架',active:'进行中',paused:'已暂停',completed:'已完成'})[s]||s}
function bindEditor(r){$('#save-route').onclick=async()=>{try{await api(`/routes/${r.id}`,{method:'PATCH',body:{title:$('#edit-title').value,city:$('#edit-city').value,category:$('#edit-category').value,description:$('#edit-description').value}});toast('路线信息已保存');editor(r.id)}catch(e){toast(e.message,'error')}};$('#cover-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=await fileData(f);await api(`/routes/${r.id}/photos`,{method:'POST',body:{data_url:data,kind:'cover'}});toast('路线封面上传成功');editor(r.id)}catch(err){toast(err.message,'error')}};$$('[data-edit-seg]').forEach(b=>b.onclick=()=>{const s=r.segments.find(x=>x.id===b.dataset.editSeg);if(!s)return;state.editingSegment=s.id;$('#seg-mode').value=s.mode;$('#seg-position').value=s.position;$('#seg-from').value=s.start_label;$('#seg-to').value=s.end_label;$('#seg-start').value=Math.round(s.start_offset/60);$('#seg-end').value=Math.round(s.end_offset/60);$('#add-segment').textContent='保存路段';$('#seg-mode').scrollIntoView({behavior:'smooth',block:'center'})});$('#add-segment').onclick=async()=>{try{const id=state.editingSegment;await api(`/routes/${r.id}/segments${id?`/${id}`:''}`,{method:id?'PATCH':'POST',body:{mode:$('#seg-mode').value,position:Number($('#seg-position').value),start_label:$('#seg-from').value,end_label:$('#seg-to').value,start_offset:Number($('#seg-start').value)*60,end_offset:Number($('#seg-end').value)*60}});state.editingSegment=null;toast(id?'交通路段已更新':'交通路段已添加');editor(r.id)}catch(e){toast(e.message,'error')}};$$('[data-delete-seg]').forEach(b=>b.onclick=async()=>{if(!confirm('删除这个交通路段？'))return;try{await api(`/routes/${r.id}/segments/${b.dataset.deleteSeg}`,{method:'DELETE'});editor(r.id)}catch(e){toast(e.message,'error')}});$$('[data-delete-cp]').forEach(b=>b.onclick=async()=>{if(!confirm('删除这个打卡点及其照片？'))return;try{await api(`/routes/${r.id}/checkpoints/${b.dataset.deleteCp}`,{method:'DELETE'});editor(r.id)}catch(e){toast(e.message,'error')}});$('#track-point').onchange=()=>{const v=$('#track-point').value;if(v){const [lat,lon]=v.split(',');$('#cp-lat').value=lat;$('#cp-lon').value=lon;state.cpLocationSource='track'}else state.cpLocationSource='manual'};$('#use-location').onclick=()=>{if(!navigator.geolocation){toast('浏览器不支持定位','error');return}navigator.geolocation.getCurrentPosition(p=>{$('#cp-lat').value=p.coords.latitude;$('#cp-lon').value=p.coords.longitude;state.cpLocationSource='live';toast(`定位精度约 ${Math.round(p.coords.accuracy)} 米`)},geoError,{enableHighAccuracy:true,timeout:15000})};$$('[data-edit-cp]').forEach(b=>b.onclick=()=>{const c=r.checkpoints.find(x=>x.id===b.dataset.editCp);if(!c)return;state.editingCheckpoint=c.id;$('#cp-name').value=c.name;$('#cp-kind').value=c.kind;$('#cp-position').value=c.position;$('#cp-lat').value=c.lat;$('#cp-lon').value=c.lon;state.cpCoordinateSystem=c.coordinate_system||'WGS84';$('#cp-recommended').value=c.recommended||'';$('#cp-spend').value=c.spend||0;$('#cp-stay').value=c.stay_minutes||0;$('#cp-note').value=c.note||'';state.cpLocationSource=c.location_source;$('#add-checkpoint').textContent='保存打卡点';$('#cp-name').scrollIntoView({behavior:'smooth',block:'center'})});$('#add-checkpoint').onclick=async()=>{try{const id=state.editingCheckpoint;await api(`/routes/${r.id}/checkpoints${id?`/${id}`:''}`,{method:id?'PATCH':'POST',body:{name:$('#cp-name').value,kind:$('#cp-kind').value,position:Number($('#cp-position').value),lat:Number($('#cp-lat').value),lon:Number($('#cp-lon').value),location_source:state.cpLocationSource||'manual',coordinate_system:state.cpCoordinateSystem||'WGS84',recommended:$('#cp-recommended').value,spend:Number($('#cp-spend').value||0),stay_minutes:Number($('#cp-stay').value||0),note:$('#cp-note').value}});state.cpLocationSource='manual';state.cpCoordinateSystem='WGS84';state.editingCheckpoint=null;toast(id?'打卡点已更新':'打卡点已保存');editor(r.id)}catch(e){toast(e.message,'error')}};$$('[data-photo-checkpoint]').forEach(i=>i.onchange=async()=>{const f=i.files[0];if(!f)return;try{await api(`/routes/${r.id}/photos`,{method:'POST',body:{checkpoint_id:i.dataset.photoCheckpoint,data_url:await fileData(f),kind:'checkpoint'}});toast('现场照片上传成功');editor(r.id)}catch(e){toast(e.message,'error')}});$('#submit-route').onclick=async()=>{if(!$('#privacy-confirm').checked){toast('请先确认已经检查公开范围与隐私','warn');return}try{await api(`/routes/${r.id}/submit`,{method:'POST',body:{privacy_confirmed:true,expected_version:r.version}});toast('路线已提交，等待管理员审核');editor(r.id)}catch(e){toast(e.message,'error')}}}
function fileData(file){return new Promise((resolve,reject)=>{if(file.size>8*1024*1024){reject(Error('图片最大 8 MB'));return}if(!['image/jpeg','image/png','image/webp'].includes(file.type)){reject(Error('只支持 JPEG、PNG 或 WebP 图片'));return}const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(file)})}

async function trips(){const view=state.viewToken;if(!state.me){setPage(`<div class="auth-card"><div class="eyebrow">YOUR CITYTRACE</div><h1>你的行程，在这里继续。</h1><p>登录后查看收藏的路线、已保存的草稿和复刻记录。</p><button class="button button-green button-wide" onclick="openAuth()">登录 / 注册</button><div class="demo-account">演示体验：explorer@citytrace.demo / trace123</div></div>`,'trips');return}let mine=[],favorites=[],follows=[];try{[mine,favorites,follows]=await Promise.all([api('/me/routes'),api('/me/favorites'),api('/me/follows')])}catch(e){if(view!==state.viewToken)return;setPage(errorPage('行程暂时无法加载',e,"navigate('trips')"),'trips');return}if(view!==state.viewToken)return;const tab=state.tripTab||'routes';let content='';if(tab==='routes'){let rows=mine;if(state.tripFilter!=='all')rows=rows.filter(r=>r.status===state.tripFilter);content=rows.map(r=>`<div class="trip-card"><div class="trip-icon">⌖</div><div class="trip-copy"><strong><a href="#/route/${r.id}">${esc(r.title)}</a> ${r.is_demo?'<span class="demo-badge">演示</span>':''}</strong><p>${esc(r.city||'未标注城市')} · ${fmtDist(r.distance_m)} · ${fmtDuration(r.elapsed_seconds)}</p></div><span class="status-pill ${r.status}">${statusLabel(r.status)}</span>${['draft','rejected'].includes(r.status)?`<button class="button button-outline button-small" onclick="navigate('edit/${r.id}')">编辑</button>`:''}${['published','pending_review','rejected'].includes(r.status)?`<button class="row-action" data-withdraw="${r.id}">撤回</button>`:''}</div>`).join('')||`<div class="empty-state"><div class="empty-icon">◎</div><strong>还没有自己的路线</strong><p>记录一次城市漫游，就能在这里编辑和发布。</p><button class="button button-green" onclick="navigate('record')">开始记录</button></div>`}else if(tab==='favorites'){content=favorites.map(r=>`<div class="trip-card"><div class="trip-icon">♡</div><div class="trip-copy"><strong><a href="#/route/${r.id}">${esc(r.title)}</a></strong><p>${esc(r.city)} · ${esc(r.nickname)} · ${fmtDist(r.distance_m)}</p></div><button class="button button-outline button-small" onclick="navigate('route/${r.id}')">查看路线</button></div>`).join('')||'<div class="empty-state"><div class="empty-icon">♡</div><strong>收藏一些想去的路线</strong><p>收藏后可以随时开始复刻。</p><a class="button button-outline" href="#/discover">去发现</a></div>'}else{content=follows.map(f=>`<div class="trip-card"><div class="trip-icon">↗</div><div class="trip-copy"><strong><a href="#/follow/${f.id}">${esc(f.title)}</a></strong><p>${f.completed_count}/${f.total_checkpoints} 个站点 · ${fmtDuration(f.elapsed_seconds)} · 路线版本 ${f.route_version}</p></div><span class="status-pill ${f.status==='active'||f.status==='paused'?'pending_review':f.status}">${statusLabel(f.status)}</span><button class="button button-outline button-small" onclick="navigate('follow/${f.id}')">打开行程</button></div>`).join('')||'<div class="empty-state"><div class="empty-icon">↗</div><strong>还没有复刻记录</strong><p>打开一条公开路线，按原作者的顺序走一遍。</p><a class="button button-outline" href="#/discover">去发现路线</a></div>'}setPage(`<div class="page-heading"><div><div class="eyebrow">YOUR ITINERARY</div><h1>行程</h1><p>从收藏到出发，再到完成，每一段都有记录。</p></div><button class="button button-green" onclick="navigate('record')">◎&nbsp; 记录新路线</button></div><div class="trips-tabs"><button data-trip-tab="routes" class="${tab==='routes'?'active':''}">我的路线（${mine.length}）</button><button data-trip-tab="favorites" class="${tab==='favorites'?'active':''}">已收藏（${favorites.length}）</button><button data-trip-tab="follows" class="${tab==='follows'?'active':''}">复刻记录（${follows.length}）</button></div>${tab==='routes'?`<div class="filter-row" style="margin-top:0"><select class="filter-select" id="mine-filter"><option value="all">所有状态</option>${['draft','pending_review','published','rejected','withdrawn','unpublished'].map(s=>`<option value="${s}" ${state.tripFilter===s?'selected':''}>${statusLabel(s)}</option>`).join('')}</select><span class="field-hint">草稿只有自己可以访问</span></div>`:''}${content}`,'trips');$$('[data-trip-tab]').forEach(b=>b.onclick=()=>{state.tripTab=b.dataset.tripTab;trips()});$('#mine-filter')?.addEventListener('change',e=>{state.tripFilter=e.target.value;trips()});$$('[data-withdraw]').forEach(b=>b.onclick=async()=>{if(!confirm('撤回这条路线？公开链接将不再显示路线内容。'))return;try{await api(`/routes/${b.dataset.withdraw}/withdraw`,{method:'POST',body:{}});toast('路线已撤回');trips()}catch(e){toast(e.message,'error')}})}

async function profile(){const view=state.viewToken;if(!state.me){setPage(`<div class="auth-card"><div class="eyebrow">YOUR PROFILE</div><h1>记录你的城市足迹。</h1><p>登录后管理自己的轨迹、路线草稿、收藏与复刻历史。</p><button class="button button-green button-wide" onclick="openAuth()">登录 / 注册</button><div class="demo-account">演示账号：<br>author@citytrace.demo / trace123<br>explorer@citytrace.demo / trace123<br>admin@citytrace.demo / admin123</div></div>`,'profile');return}let mine=[];try{mine=await api('/me/routes')}catch(e){if(view!==state.viewToken)return;setPage(errorPage('个人信息暂时无法加载',e,"navigate('profile')"),'profile');return}if(view!==state.viewToken)return;const published=mine.filter(r=>r.status==='published').length, drafts=mine.filter(r=>['draft','rejected'].includes(r.status)).length;setPage(`<div class="page-heading"><div><div class="eyebrow">YOUR ACCOUNT</div><h1>我的城迹</h1><p>真实记录，也认真决定分享给谁。</p></div></div><section class="profile-banner"><div class="profile-avatar">${initial(state.me.nickname)}</div><div><h2>${esc(state.me.nickname)}</h2><p>${esc(state.me.email)} · ${state.me.role==='admin'?'管理员':'注册用户'}</p></div><div class="profile-actions"><button class="button button-outline button-small" id="logout-button">退出登录</button></div></section><div class="route-grid" style="margin-bottom:17px"><div class="panel"><div class="eyebrow">MY ROUTES</div><strong style="font-size:24px;display:block;margin-top:9px">${mine.length}</strong><span class="field-hint">我的轨迹与路线</span></div><div class="panel"><div class="eyebrow">PUBLISHED</div><strong style="font-size:24px;display:block;margin-top:9px">${published}</strong><span class="field-hint">已公开路线</span></div><div class="panel"><div class="eyebrow">DRAFTS</div><strong style="font-size:24px;display:block;margin-top:9px">${drafts}</strong><span class="field-hint">待整理草稿</span></div></div><div class="route-grid"><button class="panel" style="text-align:left;border:1px solid #e8ebe5" onclick="state.tripTab='routes';navigate('trips')"><div class="panel-heading"><h2>我的路线</h2><span class="text-link">查看全部 →</span></div><p class="field-hint">管理真实轨迹、编辑草稿和撤回公开路线。</p></button><button class="panel" style="text-align:left;border:1px solid #e8ebe5" onclick="state.tripTab='favorites';navigate('trips')"><div class="panel-heading"><h2>收藏路线</h2><span class="text-link">查看全部 →</span></div><p class="field-hint">保存你想体验的城市路线。</p></button><button class="panel" style="text-align:left;border:1px solid #e8ebe5" onclick="state.tripTab='follows';navigate('trips')"><div class="panel-heading"><h2>复刻历史</h2><span class="text-link">查看全部 →</span></div><p class="field-hint">查看正在进行和已完成的复刻行程。</p></button></div><section class="panel" style="margin-top:16px"><div class="panel-heading"><h2>隐私与账号</h2><small>轨迹采集与公开发布分别授权</small></div><div class="notice-banner">原始 GPS 轨迹默认私有。发布后，公开版本会裁剪约 150 米的起点和终点。你可以随时撤回自己的公开路线。</div><div style="display:flex;justify-content:space-between;gap:20px;align-items:center"><div><strong style="font-size:11px">删除账号</strong><p class="field-hint">软删除账号并注销有效会话；关联路线按数据保留规则保留。</p></div><button class="button button-danger button-small" id="delete-account">删除我的账号</button></div></section>${state.me.role==='admin'?'<div class="section-head"><div><h2>审核工具</h2><p>基础内容审核和举报处理</p></div><button class="button button-dark button-small" onclick="navigate(\'admin\')">打开管理后台</button></div>':''}`,'profile');$('#logout-button').onclick=logout;$('#delete-account').onclick=deleteAccount}

async function followPageLegacy(id){if(!state.me){loginRequired('登录后继续行程','登录后可查看属于自己的复刻进度。','trips',`follow/${id}`);return}const view=state.viewToken;try{const value=await api(`/follow-sessions/${id}`);if(view!==state.viewToken)return;state.follow=value;state.followId=id}catch(e){if(view!==state.viewToken)return;setPage(`<div class="empty-state"><strong>无法打开这段复刻行程</strong><p>${esc(e.message)}</p><button class="button button-outline" onclick="navigate('trips')">返回行程</button></div>`,'trips');return}const f=state.follow,done=f.checkpoints.filter(c=>c.arrived_at).length,next=f.checkpoints.find(c=>!c.arrived_at);const currentSeg=next?f.segments.find(s=>s.position===next.position)||f.segments[next.position]||f.segments.at(-1):null;let gpsNote='';if(state.followPosition)gpsNote=`当前位置 ${state.followPosition.lat.toFixed(5)}, ${state.followPosition.lon.toFixed(5)}（±${Math.round(state.followPosition.accuracy)}m）`;const rows=f.checkpoints.map((c,i)=>`<div class="follow-step"><span class="step-number">${c.arrived_at?'✓':i+1}</span><div class="row-main"><strong style="font-size:10px">${esc(c.name)}</strong><small style="display:block;color:#8a958c;font-size:9px;margin-top:3px">${esc(c.kind)}${c.arrived_at?` · 已抵达 ${new Date(c.arrived_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:''}</small></div>${!c.arrived_at&&c.id===next?.id&&['active','paused'].includes(f.status)?`<button class="button button-green button-small" data-checkin="${c.id}" ${f.status==='paused'?'disabled':''}>确认到站</button>`:''}</div>`).join('');setPage(`<div class="page-heading"><div><div class="eyebrow">FOLLOW SESSION · VERSION ${f.route_version}</div><h1>${esc(f.title)}</h1><p>复刻是独立行程，原作者路线内容不会被你的到站记录修改。</p></div><span class="status-pill ${f.status==='active'||f.status==='paused'?'pending_review':f.status}">${statusLabel(f.status)}</span></div><div class="follow-hero"><section class="panel"><div class="panel-heading"><h2>原作者公开轨迹</h2><small>用于方向参考，不等于实时道路导航</small></div>${mapPlot(f.geometry,{class:'follow-map',label:'历史路线坐标示意 · 非地图'})}<div class="follow-progress"><strong style="font-size:11px">${done} / ${f.total_checkpoints} 站</strong><div class="progress-track"><i style="width:${f.total_checkpoints?done/f.total_checkpoints*100:0}%"></i></div><span class="field-hint">${f.total_checkpoints?Math.round(done/f.total_checkpoints*100):0}%</span></div>${gpsNote?`<div class="notice-banner">${esc(gpsNote)}</div>`:''}<div class="record-actions">${f.status==='active'?`<button class="button button-outline" id="follow-pause">Ⅱ 暂停</button>`:f.status==='paused'?`<button class="button button-green" id="follow-resume">▶ 继续</button>`:''}${['active','paused'].includes(f.status)?`<button class="button button-dark" id="follow-finish">■ 完成复刻</button>`:''}</div><p class="field-hint" style="line-height:1.7;margin-top:11px">复刻过程中浏览器定位仅用于显示当前位置，不会自动判定到站；每个站点需要你手动确认。</p></section><div class="editor-stack"><section class="panel"><div class="panel-heading"><h2>${next?'当前目标':'行程已完成'}</h2><small>${next?`${done+1} / ${f.total_checkpoints}`:'所有打卡点已确认'}</small></div>${next?`<strong style="font-size:15px">${esc(next.name)}</strong><p style="font-size:10px;color:#88938a;line-height:1.7">${esc(next.note||'到达后手动确认这一站。')}</p>${currentSeg?`<div class="leg-item"><span>本段交通方式</span><span class="leg-mode">${esc(currentSeg.mode)}</span></div>`:''}<button class="button button-outline button-wide" style="margin-top:12px" data-external-map data-map-lat="${Number(next.lat)}" data-map-lon="${Number(next.lon)}" data-map-name="${esc(next.name)}">↗ 在外部地图中导航</button><button class="button button-outline button-wide" style="margin-top:7px" id="locate-follow">◎ 显示当前位置</button>`:'<div class="notice-banner">你已查看并确认所有站点。结束本次复刻以保存完成时间。</div>'}</section><section class="panel"><div class="panel-heading"><h2>按顺序前往</h2><small>${f.checkpoints.length} 个打卡点</small></div>${rows||'<p class="field-hint">原路线没有设置打卡点。</p>'}</section><section class="panel"><div class="panel-heading"><h2>本次行程</h2></div><div class="leg-item"><span>已用时间</span><strong>${fmtDuration(f.elapsed_seconds)}</strong></div><div class="leg-item"><span>完成站点</span><strong>${done} / ${f.total_checkpoints}</strong></div><div class="leg-item"><span>固定路线版本</span><strong>${f.route_version}</strong></div></section></div></div>`,'trips');$$('[data-external-map]').forEach(b=>b.onclick=()=>openExternalMap(Number(b.dataset.mapLat),Number(b.dataset.mapLon),b.dataset.mapName));$$('[data-checkin]').forEach(b=>b.onclick=async()=>{try{state.follow=await api(`/follow-sessions/${f.id}/checkpoints`,{method:'POST',body:{checkpoint_id:b.dataset.checkin}});toast('已确认抵达，下一站已更新');await followPage(f.id)}catch(e){toast(e.message,'error')}});$('#follow-pause')?.addEventListener('click',()=>followAction(f.id,'pause'));$('#follow-resume')?.addEventListener('click',()=>followAction(f.id,'resume'));$('#follow-finish')?.addEventListener('click',()=>followAction(f.id,'finish'));$('#locate-follow')?.addEventListener('click',()=>{if(!navigator.geolocation){toast('浏览器不支持定位','error');return}navigator.geolocation.getCurrentPosition(p=>{state.followPosition={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy};followPage(f.id)},geoError,{enableHighAccuracy:true,timeout:15000})})}
async function followAction(id,action){try{state.follow=await api(`/follow-sessions/${id}/${action}`,{method:'PATCH',body:{}});toast(action==='finish'?'复刻行程已完成并保存':'行程状态已更新');followPage(id)}catch(e){toast(e.message,'error')}}

async function adminPage(){const view=state.viewToken;if(!state.me){loginRequired('登录后使用审核工具','此功能仅向管理员开放。','profile','admin');return}if(state.me.role!=='admin'){setPage('<div class="empty-state"><strong>无权访问管理后台</strong><p>此区域仅管理员可见。</p><button class="button button-outline" onclick="navigate(\'profile\')">返回我的</button></div>','profile');return}let pending=[],reports=[];try{[pending,reports]=await Promise.all([api('/admin/routes/pending'),api('/admin/reports')])}catch(e){if(view!==state.viewToken)return;setPage(errorPage('审核数据暂时无法加载',e,"navigate('admin')"),'profile');return}if(view!==state.viewToken)return;const routeRows=pending.map(r=>`<div class="admin-row"><div><h3>${esc(r.title)} ${r.is_demo?'<span class="demo-badge">演示</span>':''}</h3><p>${esc(r.nickname)} · ${esc(r.city)} · ${fmtDist(r.distance_m)} · ${r.checkpoint_count} 个打卡点<br>${esc(r.description||'无路线介绍')}</p><a class="text-link" href="#/route/${r.id}">检查路线详情 ↗</a></div><div class="admin-actions"><button class="button button-outline button-small" data-review="reject" data-id="${r.id}">拒绝</button><button class="button button-green button-small" data-review="approve" data-id="${r.id}">通过</button></div></div>`).join('');const reportRows=reports.map(x=>`<div class="admin-row"><div><h3>${esc(x.title)} · ${esc(x.reason)}</h3><p>举报人：${esc(x.reporter)} · ${fmtDate(x.created_at)}<br>${esc(x.note||'无补充说明')}</p><a class="text-link" href="#/route/${x.route_id}">打开路线 ↗</a></div><div class="admin-actions"><button class="button button-outline button-small" data-unpublish="${x.route_id}">下架路线</button><button class="button button-light button-small" data-resolve="${x.id}">标记处理完成</button></div></div>`).join('');setPage(`<div class="page-heading"><div><div class="eyebrow">CONTENT MODERATION</div><h1>内容管理</h1><p>审核公开路线，处理用户举报。</p></div><span class="demo-badge">管理员</span></div><section class="panel"><div class="panel-heading"><h2>待审核路线</h2><small>${pending.length} 条</small></div>${routeRows||'<div class="empty-state" style="padding:25px"><strong>当前没有待审核路线</strong><p>用户提交路线后会出现在这里。</p></div>'}</section><section class="panel" style="margin-top:15px"><div class="panel-heading"><h2>待处理举报</h2><small>${reports.length} 条</small></div>${reportRows||'<div class="empty-state" style="padding:25px"><strong>当前没有待处理举报</strong></div>'}</section>`,'profile');$$('[data-review]').forEach(b=>b.onclick=async()=>{let note='';if(b.dataset.review==='reject')note=prompt('填写审核未通过原因')||'内容需要补充或调整';try{await api(`/admin/routes/${b.dataset.id}/${b.dataset.review}`,{method:'POST',body:{note}});toast(b.dataset.review==='approve'?'路线已通过并公开':'已拒绝路线');adminPage()}catch(e){toast(e.message,'error')}});$$('[data-unpublish]').forEach(b=>b.onclick=async()=>{if(!confirm('下架这条公开路线？旧分享链接将不再显示内容。'))return;try{await api(`/admin/routes/${b.dataset.unpublish}/unpublish`,{method:'POST',body:{note:'根据用户举报下架'}});toast('路线已下架');adminPage()}catch(e){toast(e.message,'error')}});$$('[data-resolve]').forEach(b=>b.onclick=async()=>{try{await api('/admin/reports/resolve',{method:'POST',body:{report_id:b.dataset.resolve}});toast('举报已标记为处理完成');adminPage()}catch(e){toast(e.message,'error')}})}

function showModal(html) {
  const opener = $('#modal-root').firstElementChild ? state.modalOpener : document.activeElement;
  closeModal(false);
  state.modalOpener = opener;
  $('#modal-root').innerHTML = html;
  document.body.classList.add('no-scroll');
  $('.app-shell').inert = true;
  $('.bottom-nav').inert = true;
  const scrim = $('#modal-root').firstElementChild;
  scrim?.addEventListener('click', event => { if (event.target === scrim) closeModal(); });
  state.modalKeyHandler = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...$('#modal-root').querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', state.modalKeyHandler);
  requestAnimationFrame(() => $('#modal-root input:not([type=hidden]),#modal-root select,#modal-root button')?.focus());
}
function closeModal(restoreFocus = true) {
  if (state.modalKeyHandler) document.removeEventListener('keydown', state.modalKeyHandler);
  state.modalKeyHandler = null;
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('no-scroll');
  $('.app-shell').inert = false;
  $('.bottom-nav').inert = false;
  if (restoreFocus && state.modalOpener?.isConnected) state.modalOpener.focus({ preventScroll: true });
}
async function shareRouteLink(route) {
  const url = `${location.origin}/#/route/${route.id}`;
  if (navigator.share) {
    try { await navigator.share({ title: route.title, text: '在城迹，一起沿着真实路线走一走。', url }); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  showModal(`<div class="modal-scrim"><section class="auth-card share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title"><button class="icon-button modal-close" aria-label="关闭分享" id="close-share">×</button><div class="eyebrow">WALK TOGETHER</div><h1 id="share-title">把这段路分享出去</h1><p>对方可通过链接查看这条公开路线。局域网地址需要连接同一网络。</p><div class="field"><label for="share-link">路线链接</label><input class="share-link" id="share-link" readonly value="${esc(url)}"></div><button class="button button-green button-wide" id="copy-share">复制链接</button><p class="field-hint" id="share-status" role="status">也可以长按或选中链接复制。</p></section></div>`);
  $('#close-share').onclick = () => closeModal();
  $('#share-link').onclick = event => event.currentTarget.select();
  $('#copy-share').onclick = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else { $('#share-link').select(); if (!document.execCommand('copy')) throw Error('copy unavailable'); }
      $('#share-status').textContent = '路线链接已复制，可以发给朋友了。';
      toast('路线链接已复制');
    } catch { $('#share-link').focus(); $('#share-link').select(); $('#share-status').textContent = '请长按或选中上面的链接，手动复制。'; }
  };
}
function clearClientSession() {
  window.resetFollowClientV2?.();
  stopWatch();
  clearInterval(state.syncTimer); clearInterval(state.recordTicker);
  state.syncTimer = state.recordTicker = null;
  state.me = null; state.track = null; state.follow = null; state.followId = null;
  state.queue = []; state.lastFix = state.recordPosition = null;
  state.geoMessage = state.syncError = state.storageError = '';
  state.lastSampleAt = state.lastSyncedAt = 0;
  setUserUi(); updateActiveJourney();
}
function openAuth(next = '') {
  state.authReturn = next;
  state.authMode = 'login';
  state.authEmail = '';
  renderAuth();
}
function renderAuth() {
  const register = state.authMode === 'register';
  showModal(`<div class="modal-scrim"><section class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title"><button class="icon-button modal-close" id="close-auth" aria-label="关闭登录窗口">×</button><div class="eyebrow">CITYTRACE ACCOUNT</div><h1 id="auth-title">${register ? '加入城迹' : '欢迎回来'}</h1><p>${register ? '从一段真实发生的城市漫游开始。' : '登录后继续记录、收藏和复刻城市路线。'}</p><div class="auth-tabs" role="tablist" aria-label="登录方式"><button type="button" role="tab" aria-selected="${!register}" data-auth-mode="login" class="${!register ? 'active' : ''}">登录</button><button type="button" role="tab" aria-selected="${register}" data-auth-mode="register" class="${register ? 'active' : ''}">注册</button></div><form id="auth-form">${register ? '<div class="field"><label for="auth-nickname">昵称</label><input id="auth-nickname" name="nickname" maxlength="40" required autocomplete="nickname" placeholder="你想怎么被称呼"></div>' : ''}<div class="field"><label for="auth-email">邮箱</label><input id="auth-email" name="email" type="email" required autocomplete="email" inputmode="email" value="${esc(state.authEmail)}" placeholder="you@example.com"></div><div class="field"><label for="auth-password">密码</label><input id="auth-password" name="password" type="password" minlength="8" required autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="至少 8 位"></div><p class="field-hint auth-error hidden" id="auth-error" role="alert"></p><button class="button button-green button-wide" type="submit">${register ? '创建账号' : '登录'}</button></form>${state.config.demo_mode ? '<div class="demo-account">演示体验：explorer@citytrace.demo / trace123<br>路线作者：author@citytrace.demo / trace123</div>' : ''}</section></div>`);
  $('#close-auth').onclick = () => closeModal();
  $$('[data-auth-mode]').forEach(button => button.onclick = () => {
    state.authEmail = $('#auth-email').value;
    state.authMode = button.dataset.authMode;
    renderAuth();
  });
  $('#auth-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('[type=submit]');
    if (button.disabled) return;
    button.disabled = true; button.textContent = register ? '正在创建…' : '正在登录…';
    $('#auth-error').classList.add('hidden');
    try {
      state.me = await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form).entries()) });
      setUserUi();
      closeModal(false);
      const next = state.authReturn;
      state.authReturn = null;
      await ensureTrack();
      toast(register ? '账号创建成功' : '登录成功');
      if (next) navigate(next); else renderRoute();
    } catch (error) {
      if ($('#auth-error')) { $('#auth-error').textContent = error.message; $('#auth-error').classList.remove('hidden'); }
      button.disabled = false; button.textContent = register ? '创建账号' : '登录';
    }
  };
}
function openReport(id) {
  if (!state.me) { openAuth(); return; }
  showModal(`<div class="modal-scrim"><section class="auth-card" role="dialog" aria-modal="true" aria-labelledby="report-title"><button class="icon-button modal-close" id="close-report" aria-label="关闭举报窗口">×</button><div class="eyebrow">ROUTE REPORT</div><h1 id="report-title">举报路线</h1><p>请说明你发现的问题，管理员会进行处理。</p><div class="field"><label for="report-reason">举报类型</label><select id="report-reason">${['不实信息', '隐私风险', '危险路线', '侵权内容', '其他'].map(x => `<option>${x}</option>`).join('')}</select></div><div class="field"><label for="report-note">补充说明</label><textarea id="report-note" maxlength="1000" placeholder="请描述具体情况"></textarea></div><button class="button button-green button-wide" id="send-report">提交举报</button></section></div>`);
  $('#close-report').onclick = () => closeModal();
  $('#send-report').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/routes/${id}/report`, { method: 'POST', body: { reason: $('#report-reason').value, note: $('#report-note').value } });
      closeModal(); toast('举报已提交，感谢你的反馈');
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
async function logout() {
  if (state.logoutBusy) return;
  state.logoutBusy = true;
  try {
    if (state.track?.status === 'recording') {
      await pauseTrack();
      if (state.track?.status === 'recording') throw Error('记录尚未确认暂停，请联网保存后退出。');
    }
    if (state.track && !await drainTrackQueue()) throw Error('还有采样尚未同步，请联网后再退出。');
    if (window.hasPendingFollowPoints?.() && state.follow && ['active', 'paused'].includes(state.follow.status)) {
      await window.followAction(state.follow.id, 'pause');
      if (window.hasPendingFollowPoints?.()) throw Error('复刻轨迹尚未同步，请回到行程保存后退出。');
    }
    await api('/auth/logout', { method: 'POST', body: {} });
    clearClientSession();
    toast('已退出登录');
    navigate('discover');
  } catch (error) { toast(`尚未退出登录：${error.message}`, 'error'); }
  finally { state.logoutBusy = false; }
}
async function deleteAccount() {
  if (!confirm('停用账号并撤回关联公开路线？此操作会注销当前登录。')) return;
  try {
    await api('/auth/me', { method: 'DELETE' });
    storageRemove(trackStorageKey(STORE)); storageRemove(trackStorageKey(LAST_TRACK));
    clearClientSession();
    toast('账号已停用'); navigate('discover');
  } catch (error) { toast(error.message, 'error'); }
}
function navigate(path) {
  const hash = '#/' + path;
  if (location.hash === hash) renderRoute(); else location.hash = hash;
}
async function renderRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'discover', parts = raw.split('/'), root = parts[0];
  const view = ++state.viewToken;
  clearTimeout(state.searchTimer);
  window.cleanupV2Page?.();
  if ($('#modal-root').firstElementChild) closeModal(false);
  const page = ({ route: 'discover', edit: 'trips', follow: 'trips', admin: 'profile' })[root] || (['discover', 'map', 'record', 'trips', 'profile'].includes(root) ? root : 'discover');
  navActive(page);
  const changed = state.activeHash !== raw;
  state.activeHash = raw;
  state.focusNewPage = changed;
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  app.setAttribute('aria-busy', 'true');
  app.innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span>正在打开…</div>';
  updateActiveJourney();
  try {
    if (root === 'route' && parts[1]) return await routeDetail(parts[1]);
    if (root === 'edit' && parts[1]) return await editor(parts[1]);
    if (root === 'follow' && parts[1]) return await followPage(parts[1]);
    if (root === 'admin') return await adminPage();
    if (root === 'map') return await mapPage();
    if (root === 'record') {
      if (!state.track) await ensureTrack();
      if (view !== state.viewToken) return;
      return renderRecord();
    }
    if (root === 'trips') return await trips();
    if (root === 'profile') return await profile();
    return await discover();
  } catch (error) {
    if (view !== state.viewToken) return;
    setPage(errorPage('页面暂时没有加载出来', error, 'renderRoute()'), page);
  }
}
function updateKeyboardViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  document.documentElement.style.setProperty('--visual-viewport-height', `${viewport.height}px`);
  const field = document.activeElement;
  const editing = field && ['INPUT', 'TEXTAREA', 'SELECT'].includes(field.tagName) && !['checkbox', 'file', 'button', 'submit'].includes(field.type);
  document.body.classList.toggle('keyboard-open', window.innerWidth < 1024 && Boolean(editing) && viewport.height < window.innerHeight * 0.78);
}
async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  $('#today-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  try { state.config = await api('/config'); } catch {}
  try { state.me = await api('/auth/me'); } catch {}
  setUserUi();
  $('#top-login').onclick = () => openAuth();
  $('#top-profile').onclick = () => navigate('profile');
  $('#rail-login').onclick = () => state.me ? logout() : openAuth();
  window.visualViewport?.addEventListener('resize', updateKeyboardViewport);
  document.addEventListener('focusin', updateKeyboardViewport);
  document.addEventListener('focusout', () => requestAnimationFrame(updateKeyboardViewport));
  updateKeyboardViewport();
  $('.skip-link')?.addEventListener('click', event => { event.preventDefault(); $('#main-content').focus(); $('#main-content').scrollIntoView(); });
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('online', () => { updateAppStatus(); updateRecordReadout(); toast('网络已恢复，正在同步待上传轨迹'); flushQueue(); });
  window.addEventListener('offline', () => { updateAppStatus(); updateRecordReadout(); toast('网络已断开，已有记录的采样会在本机暂存', 'warn'); });
  window.addEventListener('beforeunload', event => {
    if (state.track?.status === 'recording' || state.queue.length || window.hasPendingFollowPoints?.() || window.isFollowingGpsV2?.()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { stopWatch(); clearInterval(state.syncTimer); state.syncTimer = null; });
  window.addEventListener('pageshow', event => {
    if (event.persisted && state.track) { ensureTrackSync(); if (state.page === 'record') watchTrack(); updateRecordReadout(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.track?.status === 'recording') {
      state.geoMessage = '页面已回到前台，正在重新确认位置。后台中断的区间不会补画轨迹。';
      stopWatch(); watchTrack(); flushQueue(); updateRecordReadout();
    }
  });
  if (state.me) await ensureTrack();
  updateAppStatus();
  await renderRoute();
}
window.followPageLegacy=followPageLegacy;window.navigate=navigate;window.startTrack=startTrack;window.pauseTrack=pauseTrack;window.resumeTrack=resumeTrack;window.finishTrack=finishTrack;window.openAuth=openAuth;window.closeModal=closeModal;window.shareRouteLink=shareRouteLink;window.openExternalMap=openExternalMap;window.addEventListener('DOMContentLoaded',boot);
