// shared.js — compact buttons & print button (v=11)
const Shared = (function(){
  const LS_SAVED = 'acp_saved_offers';
  const QKEYS = ['q','brand','category','sortNearby'];

  let _statsCache = null;
  let _nearby = { lat:null, lng:null, brandDist: new Map() };
  let _categories = ['All','Burgers','Chicken','Pizza','Mexican','Sandwiches'];

  /* Utils */
  const debounce = (fn, ms=300) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  function readQuery(){
    const u = new URL(location.href); const st = {};
    for (const k of QKEYS){ if (u.searchParams.has(k)) st[k]=u.searchParams.get(k); }
    if (st.sortNearby != null) st.sortNearby = st.sortNearby === 'true';
    return st;
  }
  function writeQuery(state){
    const u = new URL(location.href);
    QKEYS.forEach(k => {
      if (state[k] == null || state[k] === '' || state[k] === false) u.searchParams.delete(k);
      else u.searchParams.set(k, String(state[k]));
    });
    history.replaceState(null, '', u.toString());
  }

  /* Storage */
  function getSaved(){ try { return JSON.parse(localStorage.getItem(LS_SAVED) || '[]'); } catch { return []; } }
  function isSaved(id){ return getSaved().includes(id); }
  function save(id){
    const s = getSaved();
    if (!s.includes(id)) { s.push(id); localStorage.setItem(LS_SAVED, JSON.stringify(s)); }
    try{ fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({offer_id:id})}); }catch{}
  }
  function remove(id){ const s = getSaved().filter(x=>x!==id); localStorage.setItem(LS_SAVED, JSON.stringify(s)); }

  /* Filters */
  function populateBrandFilter(rows, selectEl){
    const brands = Array.from(new Set(rows.map(r => r.restaurant).filter(Boolean))).sort();
    brands.forEach(b => { const o = document.createElement('option'); o.value=b; o.textContent=b; selectEl.appendChild(o); });
  }
  function applyFilter(rows, state){
    const q = (state.q||'').toLowerCase();
    const brand = state.brand || '';
    const cat = (state.category||'').toLowerCase();
    return rows.filter(r=>{
      const hitsQ = !q || `${r.title} ${r.restaurant} ${r.description||''}`.toLowerCase().includes(q);
      const hitsB = !brand || r.restaurant === brand;
      const hitsC = !cat || cat === 'all' || (r.category||'').toLowerCase() === cat;
      return hitsQ && hitsB && hitsC;
    });
  }

  /* Category chips */
  function renderCategoryChips(host, state, onChange){
    host.innerHTML = '';
    _categories.forEach(name=>{
      const pill = document.createElement('button');
      pill.className = 'pill' + ((state.category||'All').toLowerCase() === name.toLowerCase() ? ' active':'');
      pill.textContent = name;
      pill.onclick = ()=>{ state.category = name === 'All' ? '' : name; renderCategoryChips(host, state, onChange); onChange(); };
      host.appendChild(pill);
    });
  }

  /* Expiration + stats */
  function expiryInfo(o){
    const days = Number(o.expires_days || 0);
    const remaining = Math.max(0, Math.floor(days));
    let cls='warn', label=`Expires in ${remaining} days`;
    if (remaining <= 3 && remaining > 0){ cls='danger'; label=`Expires in ${remaining} day${remaining===1?'':'s'}`; }
    if (remaining === 0){ cls='neutral'; label='Expired'; }
    return { remaining, cls, label, expired: remaining === 0 };
  }
  async function getStats(){
    if (_statsCache) return _statsCache;
    try { _statsCache = await fetch('/api/offer-stats').then(r=>r.json()).then(x=>x.stats||{}); }
    catch { _statsCache = {}; }
    return _statsCache;
  }

  /* Nearby (distance & sort) */
  async function computeNearbySort(){
    if (!navigator.geolocation) return;
    const pos = await new Promise((resolve,reject)=>{
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:10000 });
    }).catch(()=>null);
    if (!pos) return;
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    _nearby.lat = lat; _nearby.lng = lng;
    const list = await fetch(`/api/nearby?lat=${lat}&lng=${lng}&radiusKm=50`).then(r=>r.json()).then(x=>x.stores||[]).catch(()=>[]);
    _nearby.brandDist = new Map();
    list.forEach(s => { if (isFinite(s.distanceKm)) _nearby.brandDist.set((s.brand||'').toLowerCase(), s.distanceKm); });
  }
  function sortByNearby(rows){
    if (!_nearby.brandDist || !_nearby.brandDist.size) return rows;
    return rows.slice().sort((a,b)=>{
      const da = _nearby.brandDist.get((a.restaurant||'').toLowerCase()) ?? Infinity;
      const db = _nearby.brandDist.get((b.restaurant||'').toLowerCase()) ?? Infinity;
      return da - db;
    });
  }
  function formatMiles(km){ if (!isFinite(km)) return ''; const mi = km * 0.621371; return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; }

  /* Notify CTA */
  function renderNotifyCTA(actionbarEl){
    try{
      if (!('Notification' in window)) return;
      if (Notification.permission === 'denied'){
        const b = document.createElement('button');
        b.className='chip';
        b.textContent='🔔 Enable push notifications';
        b.onclick = async ()=>{ const p = await Notification.requestPermission(); if (p === 'granted') { b.remove(); } };
        actionbarEl.appendChild(b);
      }
    }catch{}
  }

  /* Card renderer — ALL buttons = compact rectangle (24px / 12px) */
  function makeCard(o, opts={}){
    const stats = (_statsCache && _statsCache[o.id]) ? _statsCache[o.id] : { issued:0, redeemed:0 };
    const exp = expiryInfo(o);

    const el = document.createElement('article'); el.className = 'card';

    const img = document.createElement('img'); img.className = 'img'; img.src = o.hero_image || ''; img.alt = o.title || ''; el.appendChild(img);

    const body = document.createElement('div'); body.className = 'body'; el.appendChild(body);

    const h3 = document.createElement('h3'); h3.textContent = o.title || o.id; body.appendChild(h3);

    const brand = document.createElement('div'); brand.className = 'brand'; brand.textContent = o.restaurant || ''; body.appendChild(brand);

    if (o.description){ const p = document.createElement('p'); p.className='desc'; p.textContent = o.description; body.appendChild(p); }

    const meta = document.createElement('div'); meta.className='meta';
    const expb = document.createElement('span'); expb.className = `badge ${exp.cls}`; expb.textContent = exp.label; meta.appendChild(expb);
    const redb = document.createElement('span'); redb.className = 'badge ok'; redb.textContent = `${(stats.redeemed||0)} redeemed`; meta.appendChild(redb);
    if (_nearby.brandDist && _nearby.brandDist.size){
      const dist = _nearby.brandDist.get((o.restaurant||'').toLowerCase());
      if (isFinite(dist)){ const xb = document.createElement('span'); xb.className='badge ok'; xb.textContent = formatMiles(dist); meta.appendChild(xb); }
    }
    body.appendChild(meta);

    const row = document.createElement('div'); row.className='btnrow'; body.appendChild(row);

    // CTA
    const cta = document.createElement('a');
    cta.className = 'btn btn-cta btn-compact';
    cta.textContent = opts.wallet ? 'Use Now' : 'Tap to Redeem';
    cta.href = `/coupon?offer=${encodeURIComponent(o.id)}`;
    cta.style.background = o.brand_color || 'var(--cta)';
    cta.style.borderColor = o.brand_color || 'var(--cta)';
    if (exp.expired){ cta.setAttribute('disabled',''); cta.href = 'javascript:void(0)'; }
    row.appendChild(cta);

    // Favorite / Saved
    const fav = document.createElement('button'); fav.className='btn btn-compact';
    const setFav = ()=>{ const saved = isSaved(o.id); fav.textContent = saved ? 'Saved ✓' : '☆ Favorite'; fav.className = 'btn btn-compact ' + (saved ? 'btn-soft' : 'btn-outline'); };
    fav.onclick = ()=>{ if (isSaved(o.id)) { remove(o.id); if (opts.wallet) el.remove(); } else { save(o.id); } setFav(); };
    setFav(); row.appendChild(fav);

    // Add to Wallet
    const add = document.createElement('button'); add.className='btn btn-compact btn-outline'; add.textContent='Add to Wallet';
    add.onclick = ()=>{ save(o.id); setFav(); };
    row.appendChild(add);

    // Print — styled like the others
    const print = document.createElement('a');
    print.className = 'btn btn-compact btn-outline';
    print.textContent = 'Print';
    print.href = `/coupon-print.html?offer=${encodeURIComponent(o.id)}`;
    row.appendChild(print);

    return el;
  }

  /* Suggestions for wallet */
  function suggest(all, state, n=8){
    const saved = new Set(getSaved());
    const pool = all.filter(o => !saved.has(o.id));
    const cat = (state.category||'').toLowerCase();
    const brand = (state.brand||'').toLowerCase();
    const byCat = pool.filter(o => (o.category||'').toLowerCase() === cat && cat);
    const byBrand = pool.filter(o => (o.restaurant||'').toLowerCase() === brand && brand);
    const rest = pool.filter(o => !byCat.includes(o) && !byBrand.includes(o));
    return [...byCat, ...byBrand, ...rest].slice(0, n);
  }

  /* Nearby alerts */
  async function enableNearbyAlerts(){
    try{
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return alert('Notifications are blocked.');
      if (!navigator.geolocation) return alert('Location not available.');
      navigator.geolocation.getCurrentPosition(async (pos)=>{
        const { latitude, longitude } = pos.coords;
        fetch(`/api/event`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ type:'enable_nearby', meta:{ latitude, longitude } }) });
        alert('Nearby alerts enabled for this device.');
      }, ()=>alert('Could not get your location.'));
    }catch(e){ alert('Unable to enable alerts.'); }
  }

  /* Expose */
  return {
    readQuery, writeQuery, debounce,
    getSaved, isSaved, save, remove,
    populateBrandFilter, applyFilter, renderCategoryChips,
    makeCard, suggest,
    renderNotifyCTA, enableNearbyAlerts,
    computeNearbySort, sortByNearby,
    get __nearbyReady(){ return Boolean(_nearby.brandDist && _nearby.brandDist.size); },
    set __nearbyReady(v){ /* marker only */ },
    getStats,
  };
})();
(async ()=>{ try{ await Shared.getStats(); }catch{} })();
