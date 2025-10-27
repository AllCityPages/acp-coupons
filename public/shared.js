// shared.js — cards with brand accent, badges, categories, nearby sort, stats, notify CTA, suggestions
const Shared = (function () {
  const LS_KEY = 'acp_saved_offers';

  /* ---------- Local Storage (Wallet) ---------- */
  function getSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }
  function isSaved(id) { return getSaved().includes(id); }
  function save(id) {
    const s = getSaved();
    if (!s.includes(id)) {
      s.push(id); localStorage.setItem(LS_KEY, JSON.stringify(s));
      try { fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ offer_id:id }) }); } catch {}
    }
  }
  function remove(id) {
    const s = getSaved().filter(x => x !== id);
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  /* ---------- Filters / Search / Categories ---------- */
  const CATS = ['Burgers','Chicken','Pizza','Mexican','Sandwiches'];
  function populateBrandFilter(rows, selectEl) {
    const brands = Array.from(new Set(rows.map(r => r.restaurant).filter(Boolean))).sort();
    brands.forEach(b => { const o=document.createElement('option'); o.value=b; o.textContent=b; selectEl.appendChild(o); });
  }
  function renderCategoryChips(container, state, onChange){
    container.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'chip' + (!state.category ? ' active':'');
    all.type = 'button'; all.textContent = 'All';
    all.onclick = ()=>{ state.category=''; onChange(); };
    container.appendChild(all);
    CATS.forEach(c=>{
      const b = document.createElement('button');
      b.className = 'chip' + (state.category===c?' active':'');
      b.type='button'; b.textContent=c;
      b.onclick = ()=>{ state.category = (state.category===c?'':c); onChange(); };
      container.appendChild(b);
    });
  }
  function applyFilter(rows, state) {
    const q = (state.q || '').toLowerCase();
    const brand = state.brand || '';
    const cat = state.category || '';
    return rows.filter(r => {
      const hitsQ = !q || `${r.title} ${r.restaurant} ${r.description||''}`.toLowerCase().includes(q);
      const hitsB = !brand || r.restaurant === brand;
      const hitsC = !cat || (r.category || '').toLowerCase() === cat.toLowerCase();
      return hitsQ && hitsB && hitsC;
    });
  }

  /* ---------- Nearby sort (brand distance) ---------- */
  let brandDistance = null; // { brandLower: km }
  async function computeNearbySort() {
    if (!navigator.geolocation) { alert('Location not available.'); return null; }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(async (pos)=>{
        try {
          const { latitude, longitude } = pos.coords;
          const nearby = await fetch(`/api/nearby?lat=${latitude}&lng=${longitude}&radiusKm=100`).then(r=>r.json());
          const map = {};
          (nearby.stores||[]).forEach(s=>{
            if (s.brand) {
              const k = String(s.brand).toLowerCase();
              map[k] = Math.min(map[k] ?? Infinity, Number(s.distanceKm)||Infinity);
            }
          });
          brandDistance = map; resolve(map);
        } catch { resolve(null); }
      }, ()=>resolve(null), { enableHighAccuracy:false, timeout:8000 });
    });
  }
  function sortByNearby(rows){
    if (!brandDistance) return rows.slice();
    return rows.slice().sort((a,b)=>{
      const da = brandDistance[(a.restaurant||'').toLowerCase()] ?? Infinity;
      const db = brandDistance[(b.restaurant||'').toLowerCase()] ?? Infinity;
      if (da===db) return (a.title||'').localeCompare(b.title||'');
      return da - db;
    });
  }

  /* ---------- Stats (issued/redeemed) ---------- */
  let STATS = null; // { [offerId]: {issued, redeemed} }
  async function loadStats(){
    if (STATS) return STATS;
    try { const data = await fetch('/api/offer-stats').then(r=>r.json()); STATS = data.stats || {}; }
    catch { STATS = {}; }
    return STATS;
  }

  /* ---------- Colors ---------- */
  function hexToRgb(hex) {
    if (!hex) return null;
    const s = hex.trim();
    const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
    const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m3) {
      const v = m3[1];
      return { r: parseInt(v[0]+v[0],16), g: parseInt(v[1]+v[1],16), b: parseInt(v[2]+v[2],16) };
    }
    if (m6) {
      const v = m6[1];
      return { r: parseInt(v.slice(0,2),16), g: parseInt(v.slice(2,4),16), b: parseInt(v.slice(4,6),16) };
    }
    return null;
  }
  function relLuminance({r,g,b}) {
    const toLin = c => { const cs=c/255; return cs<=0.03928 ? cs/12.92 : Math.pow((cs+0.055)/1.055,2.4); };
    return 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
  }
  function bestTextColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    return relLuminance(rgb) > 0.55 ? '#111827' : '#ffffff';
  }
  function applyAccent(btnEl, hex) {
    if (!hex) return;
    const text = bestTextColor(hex);
    btnEl.classList.add('btn-accent');
    btnEl.style.background = hex;
    btnEl.style.color = text;
    btnEl.style.borderColor = hex;
  }

  /* ---------- Badges helpers ---------- */
  function daysLeft(expiresDays){
    const n = Number(expiresDays||0);
    return n>0 ? n : null;
  }
  function distanceForBrand(brand){
    if (!brandDistance) return null;
    const d = brandDistance[(brand||'').toLowerCase()];
    return (isFinite(d) ? d : null);
  }

  /* ---------- Card rendering ---------- */
  function makeCard(o, opts = {}) {
    const el = document.createElement('article');
    el.className = 'card';

    const img = document.createElement('img');
    img.className = 'img'; img.loading = 'lazy';
    img.src = o.hero_image || ''; img.alt = o.title || '';
    el.appendChild(img);

    const body = document.createElement('div'); body.className = 'body'; el.appendChild(body);

    const h3 = document.createElement('h3'); h3.textContent = o.title || o.id; body.appendChild(h3);

    const brand = document.createElement('div'); brand.className = 'brand'; brand.textContent = o.restaurant || ''; body.appendChild(brand);

    if (o.description){ const p=document.createElement('p'); p.className='desc'; p.textContent=o.description; body.appendChild(p); }

    // badges row
    const badges = document.createElement('div'); badges.className = 'badges'; body.appendChild(badges);

    // expiration
    const dl = daysLeft(o.expires_days);
    if (dl !== null){
      const b = document.createElement('span'); b.className='badge exp';
      b.textContent = `Expires in ${dl} day${dl===1?'':'s'}`;
      badges.appendChild(b);
    }

    // redemptions (will backfill after STATS load)
    const redBadge = document.createElement('span'); redBadge.className='badge redeem'; redBadge.textContent = '— redeemed';
    badges.appendChild(redBadge);

    // distance (if known)
    const dist = distanceForBrand(o.restaurant);
    const distBadge = document.createElement('span'); distBadge.className='badge dist'; distBadge.style.display = dist!=null?'inline-flex':'none';
    if (dist!=null) distBadge.textContent = `${dist.toFixed(1)} km nearby`;
    badges.appendChild(distBadge);

    const row = document.createElement('div'); row.className='btnrow'; body.appendChild(row);

    // Primary CTA
    const redeem = document.createElement('a');
    redeem.className = 'btn btn-primary';
    redeem.textContent = opts.wallet ? 'Use Now' : 'Tap to Redeem';
    redeem.href = `/coupon?offer=${encodeURIComponent(o.id)}`;
    row.appendChild(redeem);

    // apply brand tint
    const accent = o.accent_color || o.brand_color || null;
    if (accent) applyAccent(redeem, accent);

    // Favorite toggle
    const fav = document.createElement('button'); fav.className='btn'; fav.setAttribute('aria-pressed', isSaved(o.id));
    const setFavState = ()=>{ const saved = isSaved(o.id); fav.setAttribute('aria-pressed', saved); fav.textContent = `${saved ? '★' : '☆'} Favorite`; };
    fav.onclick = ()=>{ isSaved(o.id) ? remove(o.id) : save(o.id); setFavState(); if (opts.wallet && !isSaved(o.id)) el.remove(); };
    setFavState(); row.appendChild(fav);

    // Add to Wallet
    const add = document.createElement('button'); add.className='btn'; add.textContent='Add to Wallet';
    add.onclick = ()=>{ save(o.id); setFavState(); };
    row.appendChild(add);

    // Print
    const print = document.createElement('a'); print.className='btn btn-outline'; print.textContent='Print';
    print.href = `/coupon-print.html?offer=${encodeURIComponent(o.id)}`;
    row.appendChild(print);

    // Backfill redemption stats async
    loadStats().then(stats=>{
      const s = stats[o.id] || { issued:0, redeemed:0 };
      redBadge.textContent = `${s.redeemed} redeemed`;
    });

    return el;
  }

  /* ---------- Notify CTA bar ---------- */
  function renderNotifyCTA(container){
    // Show only if notifications aren't granted
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    const bar = document.createElement('div');
    bar.className = 'notify';
    bar.innerHTML = `<span>🔔 Turn on nearby deal alerts for your area.</span>`;
    const btn = document.createElement('button'); btn.className='btn'; btn.textContent='Enable Alerts';
    btn.onclick = async ()=>{
      try{
        const perm = await Notification.requestPermission();
        if (perm === 'granted') { bar.remove(); alert('Alerts enabled!'); }
      }catch{}
    };
    bar.appendChild(btn);
    container.parentNode.insertBefore(bar, container.nextSibling);
  }

  /* ---------- Suggestions (unsaved offers) ---------- */
  function suggest(offers, state, limit=6){
    const saved = new Set(getSaved());
    let pool = offers.filter(o => !saved.has(o.id));
    // match by category first, then brand, else popular (redeemed desc)
    if (state.category) pool = pool.filter(o => (o.category||'').toLowerCase() === state.category.toLowerCase());
    else if (state.brand) pool = pool.filter(o => o.restaurant === state.brand);
    return pool.slice(0, limit);
  }

  /* ---------- URL helpers ---------- */
  function readQuery() {
    const u = new URL(location.href);
    return { q: u.searchParams.get('q') || '', brand: u.searchParams.get('brand') || '', category: u.searchParams.get('category') || '' };
  }
  function writeQuery(state) {
    const u = new URL(location.href);
    state.q ? u.searchParams.set('q', state.q) : u.searchParams.delete('q');
    state.brand ? u.searchParams.set('brand', state.brand) : u.searchParams.delete('brand');
    state.category ? u.searchParams.set('category', state.category) : u.searchParams.delete('category');
    history.replaceState(null, '', u.toString());
  }

  /* ---------- Utils ---------- */
  function debounce(fn, ms = 200) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  return {
    // wallet
    getSaved, isSaved, save, remove,
    // filters
    populateBrandFilter, renderCategoryChips, applyFilter,
    // geosort
    computeNearbySort, sortByNearby,
    // stats & notify
    loadStats, renderNotifyCTA,
    // cards & suggestions
    makeCard, suggest,
    // url
    readQuery, writeQuery, debounce
  };
})();
