// shared.js — v19 (independent Favorites & Wallet + branding + nearby)
const BRAND = {
  name: 'Local Deals Hub',
  // change this to wherever you actually put the file (e.g. '/img/acp-logo.png')
  logo: '/logo.png',
  home: '/offers.html'
};

const Shared = (function(){
  // ====== NEW: independent storage keys ======
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

  /* ---------- local storage helpers (NEW) ---------- */
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

  // One-time migration from old combined key, if it exists
  (function migrateOld(){
    try{
      const raw = localStorage.getItem('acp_saved_offers');
      if(!raw) return;
      const old = JSON.parse(raw);
      if(old && typeof old === 'object'){
        if(Array.isArray(old.favorites)) _fav = new Set(old.favorites);
        if(Array.isArray(old.wallet)) _wal = new Set(old.wallet);
        if(Array.isArray(old)) _wal = new Set(old); // legacy array treated as wallet
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

  /* ---------- category chips ---------- */
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

  /* ---------- nearby ---------- */
  async function computeNearbySort(){
    if(!navigator.geolocation) return;
    const pos = await new Promise((res,rej)=>
      navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:10000})
    ).catch(()=>null);
    if(!pos) return;
    _nearby.lat = pos.coords.latitude;
    _nearby.lng = pos.coords.longitude;
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

  function formatMiles(km){
    if(!isFinite(km)) return '';
    const mi = km * 0.621371;
    return (mi<10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }

  /* ---------- notify CTA ---------- */
  function renderNotifyCTA(actionbarEl){
    try{
      if(!('Notification' in window)) return;
      if(Notification.permission==='denied'){
        const b=document.createElement('button');
        b.className='chip btn-compact';
        b.textContent='🔔 Enable push notifications';
        b.onclick=async()=>{
          const p=await Notification.requestPermission();
          if(p==='granted'){ b.remove(); }
        };
        actionbarEl.appendChild(b);
      }
    }catch{}
  }

  /* ---------- card builder ---------- */
  function makeCard(o, opts={}){
    const stats=(_statsCache&&_statsCache[o.id])?_statsCache[o.id]:{issued:0,redeemed:0};
    const exp=expiryInfo(o);

    const el=document.createElement('article');
    el.className='card';
    el.dataset.offerId = String(o.id);

    const img=document.createElement('img');
    img.className='img';
    img.src=o.hero_image||'';
    img.alt=o.title||'';
    el.appendChild(img);

    const body=document.createElement('div');
    body.className='body';
    el.appendChild(body);

    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';

    const h3=document.createElement('h3');
    h3.textContent=o.title||o.id;
    titleRow.appendChild(h3);

    if (o.logo){
      const logo = document.createElement('img');
      logo.className = 'brand-logo-inline';
      logo.src = o.logo;
      logo.alt = (o.restaurant || 'Brand') + ' logo';
      titleRow.appendChild(logo);
    }

    body.appendChild(titleRow);

    const brandRow = document.createElement('div');
    brandRow.className = 'brand-row';

    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = o.restaurant || '';
    brandRow.appendChild(brand);

    body.appendChild(brandRow);

    if(o.description){
      const p=document.createElement('p');
      p.className='desc';
      p.textContent=o.description;
      body.appendChild(p);
    }

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

    if(_nearby.brandDist && _nearby.brandDist.size){
      const dist=_nearby.brandDist.get((o.restaurant||'').toLowerCase());
      if(isFinite(dist)){
        const xb=document.createElement('span');
        xb.className='badge ok';
        xb.textContent=formatMiles(dist);
        meta.appendChild(xb);
      }
    }

    body.appendChild(meta);

    const row=document.createElement('div');
    row.className='btnrow';
    body.appendChild(row);

    const cta=document.createElement('a');
    cta.className='btn btn-cta';
    cta.textContent=opts.wallet ? 'Use Now' : 'Tap to Redeem';
    cta.href=`/coupon?offer=${encodeURIComponent(o.id)}`;
    if (o.brand_color){
      cta.style.background = o.brand_color;
      cta.style.borderColor = o.brand_color;
    }
    if (exp.expired){
      cta.setAttribute('disabled','');
      cta.href='javascript:void(0)';
    }
    row.appendChild(cta);

    // Favorite button (independent)
    const fav=document.createElement('button');
    fav.className='btn btn-fav';
    fav.setAttribute('data-action','fav');
    fav.setAttribute('data-offer-id', String(o.id));
    row.appendChild(fav);

    // Wallet button (independent)
    const wal=document.createElement('button');
    wal.className='btn btn-wallet';
    wal.setAttribute('data-action','wallet');
    wal.setAttribute('data-offer-id', String(o.id));
    row.appendChild(wal);

    // Print
    const print=document.createElement('a');
    print.className='btn btn-outline';
    print.textContent='Print';
    print.href=`/coupon-print.html?offer=${encodeURIComponent(o.id)}&src=card`;
    row.appendChild(print);

    // Initial button state
    updateButtonsFor(o.id);

    return el;
  }

  // Button state updater for one offer id
  function updateButtonsFor(id){
    id = String(id);
    const favBtn = document.querySelector(`.btn-fav[data-offer-id="${id}"]`);
    const walBtn = document.querySelector(`.btn-wallet[data-offer-id="${id}"]`);

    if(favBtn){
      if(isFavorite(id)){
        favBtn.classList.add('btn-on');
        favBtn.textContent = 'Saved ✓';
      } else {
        favBtn.classList.remove('btn-on');
        favBtn.textContent = '⭐ Favorite';
      }
    }

    if(walBtn){
      if(isInWallet(id)){
        walBtn.classList.add('btn-on');
        walBtn.textContent = 'Saved ✓';
      } else {
        walBtn.classList.remove('btn-on');
        walBtn.textContent = 'Add to Wallet';
      }
    }
  }

  // Event delegation: keep actions separate
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
      // If we're on the wallet page and the user removed it, remove the card from DOM
      if (wasIn && !isInWallet(id) && location.pathname.includes('wallet')) {
        const card = btn.closest('.card');
        if(card) card.remove();
        // also update the count if present
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
    // NEW exports
    getFavoriteIds, getWalletIds, isFavorite, isInWallet, toggleFavorite, toggleWallet, updateButtonsFor,
    // unchanged
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

// run branding on load
document.addEventListener('DOMContentLoaded', () => {
  if (typeof Shared.initBranding === 'function') {
    Shared.initBranding();
  }
});
