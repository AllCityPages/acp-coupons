// shared.js — v28
// - Distance text under logo (same height as brand text)
// - Address block with multi-location support + nearest calculation
// - Backward compatible with simple string address

const BRAND = {
  name: 'Local Deals Hub',
  logo: '/logo.png',
  home: '/offers.html'
};

const Shared = (function(){
  // ====== Independent storage keys ======
  const LS_FAV = 'acp_favorites_v1';
  const LS_WAL = 'acp_wallet_v1';

  const QKEYS = ['q','brand','category','sortNearby'];

  let _statsCache = null;
  let _nearby = { lat:null, lng:null, brandDist: new Map() };
  let _categories = ['All','Burgers','Chicken','Pizza','Mexican','Sandwiches'];

  /* ---------- utils ---------- */
  const debounce=(fn,ms=300)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};

  function readQuery(){
    const u=new URL(location.href);
    const st={};
    for(const k of QKEYS){
      if(u.searchParams.has(k)) st[k]=u.searchParams.get(k);
    }
    if(st.sortNearby!=null) st.sortNearby = st.sortNearby === 'true';
    return st;
  }
  function writeQuery(state){
    const u=new URL(location.href);
    QKEYS.forEach(k=>{
      if(state[k]==null || state[k]==='' || state[k]===false) u.searchParams.delete(k);
      else u.searchParams.set(k,String(state[k]));
    });
    history.replaceState(null,'',u.toString());
  }

  /* ---------- branding ---------- */
  function initBranding(){
    const els = document.querySelectorAll('[data-logo]');
    els.forEach(el => {
      if (BRAND.logo) {
        el.classList.add('has-img');
        el.innerHTML = `<img src="${BRAND.logo}" alt="${BRAND.name || 'Logo'}">`;
      } else {
        const letter = (BRAND.name || 'A').slice(0,1).toUpperCase();
        el.textContent = letter;
      }
    });
    if (BRAND.name) {
      const h1 = document.querySelector('.title h1');
      if (h1 && !h1.dataset.locked) h1.textContent = BRAND.name;
    }
  }

  /* ---------- local storage helpers ---------- */
  function loadSet(key){
    try {
      const raw = localStorage.getItem(key);
      if(!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch(_) { return new Set(); }
  }
  function saveSet(key, set){
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  }

  let _fav = loadSet(LS_FAV);
  let _wal = loadSet(LS_WAL);

  (function migrateOld(){
    try{
      const raw = localStorage.getItem('acp_saved_offers');
      if(!raw) return;
      const old = JSON.parse(raw);
      if(old && typeof old === 'object'){
        if(Array.isArray(old.favorites)) _fav = new Set(old.favorites);
        if(Array.isArray(old.wallet)) _wal = new Set(old.wallet);
        if(Array.isArray(old)) _wal = new Set(old);
        saveSet(LS_FAV, _fav);
        saveSet(LS_WAL, _wal);
      }
      localStorage.removeItem('acp_saved_offers');
    }catch(_){}
  })();

  // Public getters
  function getFavoriteIds(){ return Array.from(_fav); }
  function getWalletIds(){ return Array.from(_wal); }
  function isFavorite(id){ return _fav.has(String(id)); }
  function isInWallet(id){ return _wal.has(String(id)); }

  // Mutators (independent)
  function toggleFavorite(id){
    id = String(id);
    if(_fav.has(id)) _fav.delete(id); else _fav.add(id);
    saveSet(LS_FAV, _fav);
  }
  function toggleWallet(id){
    id = String(id);
    if(_wal.has(id)) _wal.delete(id); else _wal.add(id);
    saveSet(LS_WAL, _wal);
  }

  /* ---------- filters ---------- */
  function populateBrandFilter(rows, selectEl){
    const brands=[...new Set(rows.map(r=>r.restaurant).filter(Boolean))].sort();
    brands.forEach(b=>{
      const o=document.createElement('option');
      o.value=b;
      o.textContent=b;
      selectEl.appendChild(o);
    });
  }

  function applyFilter(rows, state){
    const q=(state.q||'').toLowerCase();
    const brand=state.brand||'';
    const cat=(state.category||'').toLowerCase();
    return rows.filter(r=>{
      const hitsQ = !q || `${r.title} ${r.restaurant} ${r.description||''}`.toLowerCase().includes(q);
      const hitsB = !brand || r.restaurant === brand;
      const hitsC = !cat || cat==='all' || (r.category||'').toLowerCase()===cat;
      return hitsQ && hitsB && hitsC;
    });
  }

  /* ---------- category chips (optional) ---------- */
  function renderCategoryChips(host, state, onChange){
    host.innerHTML='';
    _categories.forEach(name=>{
      const pill=document.createElement('button');
      pill.className='pill'+(((state.category||'All').toLowerCase()===name.toLowerCase())?' active':'');
      pill.textContent=name;
      pill.onclick=()=>{
        state.category=(name==='All')?'':name;
        renderCategoryChips(host,state,onChange);
        onChange();
      };
      host.appendChild(pill);
    });
  }

  /* ---------- expiration + stats ---------- */
  function expiryInfo(o){
    const days=Number(o.expires_days||0);
    const remaining=Math.max(0,Math.floor(days));
    let cls='warn', label=`Expires in ${remaining} days`;
    if(remaining<=3 && remaining>0){ cls='danger'; label=`Expires in ${remaining} day${remaining===1?'':'s'}`; }
    if(remaining===0){ cls='neutral'; label='Expired'; }
    return {remaining,cls,label,expired:remaining===0};
  }

  async function getStats(){
    if(_statsCache) return _statsCache;
    try{
      _statsCache = await fetch('/api/offer-stats').then(r=>r.json()).then(x=>x.stats||{});
    }catch{
      _statsCache = {};
    }
    return _statsCache;
  }

  /* ---------- geodistance helpers ---------- */
  function haversineKm(lat1,lng1,lat2,lng2){
    function toRad(d){return d*Math.PI/180;}
    const R=6371;
    const dLat=toRad(lat2-lat1);
    const dLng=toRad(lng2-lng1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function formatMiles(km){
    if(!isFinite(km)) return '';
    const mi = km * 0.621371;
    return (mi<10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }

  function normalizeAddresses(o){
    // Accept: o.address (string) OR o.addresses: [string | {label,lat,lng}]
    let list=[];
    if (Array.isArray(o.addresses)) list=[...o.addresses];
    else if (o.address) list=[o.address];
    return list.map(entry=>{
      if (typeof entry==='string') return { label: entry };
      const label = entry.label || [entry.street, entry.city, entry.state].filter(Boolean).join(', ');
      return { label, lat: entry.lat, lng: entry.lng };
    }).filter(a => a && a.label);
  }

  function nearestAddress(o){
    const addrs = normalizeAddresses(o);
    if (!addrs.length || _nearby.lat==null || _nearby.lng==null) return null;
    let bestIdx=-1, bestKm=Infinity;
    addrs.forEach((a,i)=>{
      if (isFinite(a.lat) && isFinite(a.lng)){
        const km = haversineKm(_nearby.lat,_nearby.lng,a.lat,a.lng);
        if (km<bestKm){ bestKm=km; bestIdx=i; }
      }
    });
    if (bestIdx<0) return null;
    return { index: bestIdx, distanceKm: bestKm, address: addrs[bestIdx], all:addrs };
  }

  /* ---------- nearby ---------- */
  async function computeNearbySort(){
    if(!navigator.geolocation) return;
    const pos = await new Promise((res,rej)=>
      navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:10000})
    ).catch(()=>null);
    if(!pos) return;
    _nearby.lat = pos.coords.latitude;
    _nearby.lng = pos.coords.longitude;

    // Brand-level distances (server-provided)
    const list = await fetch(`/api/nearby?lat=${_nearby.lat}&lng=${_nearby.lng}&radiusKm=50`)
      .then(r=>r.json())
      .then(x=>x.stores||[])
      .catch(()=>[]);
    _nearby.brandDist = new Map();
    list.forEach(s=>{
      if(isFinite(s.distanceKm))
        _nearby.brandDist.set((s.brand||'').toLowerCase(), s.distanceKm);
    });
  }

  function sortByNearby(rows){
    if(!_nearby.brandDist || !_nearby.brandDist.size) return rows;
    return rows.slice().sort((a,b)=>{
      const da = _nearby.brandDist.get((a.restaurant||'').toLowerCase()) ?? Infinity;
      const db = _nearby.brandDist.get((b.restaurant||'').toLowerCase()) ?? Infinity;
      return da - db;
    });
  }

  /* ---------- card builder ---------- */
  function makeCard(o, opts={}){
    const stats=(_statsCache&&_statsCache[o.id])?_statsCache[o.id]:{issued:0,redeemed:0};
    const exp=expiryInfo(o);

    const el=document.createElement('article');
    el.className='card';
    el.dataset.offerId = String(o.id);

    // HERO
    const hero=document.createElement('div');
    hero.className='hero hero--zoom';
    if (o.hero_nozoom === true) hero.classList.remove('hero--zoom');
    const img=document.createElement('img');
    img.className='img';
    img.src=o.hero_image||'';
    img.alt=o.title||'';
    hero.appendChild(img);
    el.appendChild(hero);

    const body=document.createElement('div');
    body.className='body';
    el.appendChild(body);

    // Title row: h3 + logo stack (logo + distance)
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';

    const h3=document.createElement('h3');
    h3.textContent=o.title||o.id;
    titleRow.appendChild(h3);

    if (o.logo){
      const stack = document.createElement('div');
      stack.className = 'brand-logo-stack';

      const logo = document.createElement('img');
      logo.className = 'brand-logo-inline';
      logo.src = o.logo;
      logo.alt = (o.restaurant || 'Brand') + ' logo';
      stack.appendChild(logo);

      // Distance text under the logo
      const distEl = document.createElement('div');
      distEl.className = 'brand-distance';

      let distText = '';
      const near = nearestAddress(o);
      if (near && isFinite(near.distanceKm)) {
        distText = `${formatMiles(near.distanceKm)} away`;
      } else if(_nearby.brandDist && _nearby.brandDist.size){
        const d = _nearby.brandDist.get((o.restaurant||'').toLowerCase());
        if (isFinite(d)) distText = `${formatMiles(d)} away`;
      }
      distEl.textContent = distText;
      if (distText) stack.appendChild(distEl);

      titleRow.appendChild(stack);
    }
    body.appendChild(titleRow);

    // Brand row (name)
    const brandRow = document.createElement('div');
    brandRow.className = 'brand-row';
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = o.restaurant || '';
    brandRow.appendChild(brand);
    body.appendChild(brandRow);

    // Address block (nearest + toggle for all)
    (function renderAddress(){
      const info = nearestAddress(o);
      const addrs = normalizeAddresses(o);
      if (!addrs.length) return;

      const addr = document.createElement('div');
      addr.className = 'addr';

      if (info){
        addr.innerHTML = `${info.address.label} <span class="addr-dist">• ${formatMiles(info.distanceKm)} away</span>` +
                         (addrs.length>1 ? ` <small class="toggle" role="button" tabindex="0">(view all)</small>` : '');
      } else {
        addr.textContent = addrs[0].label + (addrs.length>1 ? ` (+${addrs.length-1} more)` : '');
      }
      body.appendChild(addr);

      if (addrs.length>1){
        const list = document.createElement('div');
        list.className = 'addr-list';
        addrs.forEach(a=>{
          let line = a.label;
          if (isFinite(a.lat) && isFinite(a.lng) && _nearby.lat!=null){
            const km = haversineKm(_nearby.lat,_nearby.lng,a.lat,a.lng);
            line += ` — ${formatMiles(km)}`;
          }
          const item = document.createElement('div');
          item.textContent = line;
          list.appendChild(item);
        });
        body.appendChild(list);

        const toggle = addr.querySelector('.toggle');
        if (toggle){
          toggle.addEventListener('click', ()=> list.classList.toggle('show'));
          toggle.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); list.classList.toggle('show'); }});
        }
      }
    })();

    if(o.description){
      const p=document.createElement('p');
      p.className='desc';
      p.textContent=o.description;
      body.appendChild(p);
    }

    // Meta badges
    const meta=document.createElement('div');
    meta.className='meta';

    const expb=document.createElement('span');
    expb.className=`badge ${exp.cls}`;
    expb.textContent=exp.label;
    meta.appendChild(expb);

    const redb=document.createElement('span');
    redb.className='badge ok';
    redb.textContent=`${(stats.redeemed||0)} redeemed`;
    meta.appendChild(redb);

    body.appendChild(meta);

    // Buttons
    const row=document.createElement('div');
    row.className='btnrow';
    body.appendChild(row);

    const cta=document.createElement('a');
    cta.className='btn btn-cta';
    cta.textContent=opts.wallet ? 'Use Now' : 'Tap to Redeem';
    cta.href=`/coupon?offer=${encodeURIComponent(o.id)}`;
    if (exp.expired){
      cta.setAttribute('disabled','');
      cta.href='javascript:void(0)';
    }
    row.appendChild(cta);

    const fav=document.createElement('button');
    fav.className='btn btn-fav';
    fav.setAttribute('data-action','fav');
    fav.setAttribute('data-offer-id', String(o.id));
    row.appendChild(fav);

    const wal=document.createElement('button');
    wal.className='btn btn-wallet';
    wal.setAttribute('data-action','wallet');
    wal.setAttribute('data-offer-id', String(o.id));
    row.appendChild(wal);

    const print=document.createElement('a');
    print.className='btn btn-outline';
    print.textContent='Print';
    print.href=`/coupon-print.html?offer=${encodeURIComponent(o.id)}&src=card`;
    row.appendChild(print);

    updateButtonsFor(o.id);
    return el;
  }

  // Button state updater
  function updateButtonsFor(id){
    id = String(id);
    const favBtns = document.querySelectorAll(`.btn-fav[data-offer-id="${id}"]`);
    const walBtns = document.querySelectorAll(`.btn-wallet[data-offer-id="${id}"]`);

    favBtns.forEach(favBtn=>{
      if(isFavorite(id)){
        favBtn.classList.add('btn-on');
        favBtn.textContent = 'Saved ✓';
      } else {
        favBtn.classList.remove('btn-on');
        favBtn.textContent = '⭐ Favorite';
      }
    });

    walBtns.forEach(walBtn=>{
      if(isInWallet(id)){
        walBtn.classList.add('btn-on');
        walBtn.textContent = 'Saved ✓';
      } else {
        walBtn.classList.remove('btn-on');
        walBtn.textContent = 'Add to Wallet';
      }
    });
  }

  // Event delegation
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-action]');
    if(!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.offerId;
    if(!id) return;

    if(action === 'fav'){
      toggleFavorite(id);
      updateButtonsFor(id);
      return;
    }

    if(action === 'wallet'){
      const wasIn = isInWallet(id);
      toggleWallet(id);
      updateButtonsFor(id);
      if (wasIn && !isInWallet(id) && location.pathname.includes('wallet')) {
        const card = btn.closest('.card');
        if(card) card.remove();
        const countEl = document.querySelector('#count');
        if(countEl){
          const current = Number(countEl.textContent||'0');
          if(current>0) countEl.textContent = String(current-1);
        }
      }
      return;
    }
  });

  /* ---------- suggestions (wallet) ---------- */
  function suggest(all, state, n=8){
    const inWallet=new Set(getWalletIds());
    const pool=all.filter(o=>!inWallet.has(String(o.id)));
    const cat=(state.category||'').toLowerCase();
    const brand=(state.brand||'').toLowerCase();
    const byCat=pool.filter(o=>(o.category||'').toLowerCase()===cat && cat);
    const byBrand=pool.filter(o=>(o.restaurant||'').toLowerCase()===brand && brand);
    const rest=pool.filter(o=>!byCat.includes(o) && !byBrand.includes(o));
    return [...byCat,...byBrand,...rest].slice(0,n);
  }

  /* ---------- enable nearby alerts ---------- */
  async function enableNearbyAlerts(){
    try{
      const perm=await Notification.requestPermission();
      if(perm!=='granted') return alert('Notifications are blocked.');
      if(!navigator.geolocation) return alert('Location not available.');
      navigator.geolocation.getCurrentPosition(async(pos)=>{
        const {latitude,longitude}=pos.coords;
        fetch('/api/event',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'enable_nearby',meta:{latitude,longitude}})
        });
        alert('Nearby alerts enabled for this device.');
      },()=>alert('Could not get your location.'));
    }catch(e){
      alert('Unable to enable alerts.');
    }
  }

  return {
    readQuery, writeQuery, debounce,
    getFavoriteIds, getWalletIds, isFavorite, isInWallet, toggleFavorite, toggleWallet, updateButtonsFor,
    populateBrandFilter, applyFilter, renderCategoryChips,
    makeCard, suggest,
    renderNotifyCTA, enableNearbyAlerts,
    computeNearbySort, sortByNearby,
    get __nearbyReady(){ return Boolean(_nearby.brandDist && _nearby.brandDist.size); },
    set __nearbyReady(_v){},
    getStats,
    initBranding
  };
})();

// warm stats
(async ()=>{ try{ await Shared.getStats(); }catch{} })();

// branding on load
document.addEventListener('DOMContentLoaded', () => {
  if (typeof Shared.initBranding === 'function') {
    Shared.initBranding();
  }
});

// Simple debug helpers (optional)
window.ACP = Object.assign(window.ACP || {}, {
  favs: () => JSON.parse(localStorage.getItem('acp_favorites_v1')||'[]'),
  wals: () => JSON.parse(localStorage.getItem('acp_wallet_v1')||'[]')
});
