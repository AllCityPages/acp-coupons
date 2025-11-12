// shared.js — v31
// - New head-grid layout in makeCard(): Brand (row1), Title (row2),
//   Includes (row3 left) vs Logo+Mileage (right spanning all rows)
// - Everything else unchanged from v30

const BRAND = {
  name: 'Local Deals Hub',
  logo: '/logo.png',
  home: '/offers.html'
};

const Shared = (function(){
  const LS_FAV = 'acp_favorites_v1';
  const LS_WAL = 'acp_wallet_v1';
  const QKEYS = ['q','brand','category','sortNearby'];

  let _statsCache = null;
  let _nearby = { lat:null, lng:null, brandDist: new Map() };
  let _categories = ['All','Burgers','Chicken','Pizza','Mexican','Sandwiches'];

  const debounce=(fn,ms=300)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};

  function readQuery(){
    const u=new URL(location.href); const st={};
    for(const k of QKEYS){ if(u.searchParams.has(k)) st[k]=u.searchParams.get(k); }
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

  function initBranding(){
    const els = document.querySelectorAll('[data-logo]');
    els.forEach(el => {
      if (BRAND.logo) {
        el.classList.add('has-img');
        el.innerHTML = `<img src="${BRAND.logo}" alt="${BRAND.name || 'Logo'}">`;
      } else {
        el.textContent = (BRAND.name || 'A').slice(0,1).toUpperCase();
      }
    });
    if (BRAND.name) {
      const h1 = document.querySelector('.title h1');
      if (h1 && !h1.dataset.locked) h1.textContent = BRAND.name;
    }
  }

  function loadSet(key){ try{ const raw=localStorage.getItem(key); return raw?new Set(JSON.parse(raw)):new Set(); }catch{ return new Set(); } }
  function saveSet(key,set){ localStorage.setItem(key, JSON.stringify([...set])); }
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
        saveSet(LS_FAV,_fav); saveSet(LS_WAL,_wal);
      }
      localStorage.removeItem('acp_saved_offers');
    }catch(_){}
  })();

  const getFavoriteIds=()=>[..._fav];
  const getWalletIds=()=>[..._wal];
  const isFavorite=id=>_fav.has(String(id));
  const isInWallet=id=>_wal.has(String(id));
  function toggleFavorite(id){ id=String(id); _fav.has(id)?_fav.delete(id):_fav.add(id); saveSet(LS_FAV,_fav); }
  function toggleWallet(id){ id=String(id); _wal.has(id)?_wal.delete(id):_wal.add(id); saveSet(LS_WAL,_wal); }

  function populateBrandFilter(rows, selectEl){
    const brands=[...new Set(rows.map(r=>r.restaurant).filter(Boolean))].sort();
    brands.forEach(b=>{ const o=document.createElement('option'); o.value=b; o.textContent=b; selectEl.appendChild(o); });
  }

  function applyFilter(rows, state){
    const q=(state.q||'').toLowerCase();
    const brand=state.brand||'';
    const cat=(state.category||'').toLowerCase();
    return rows.filter(r=>{
      const hitsQ=!q || `${r.title} ${r.restaurant} ${r.description||''}`.toLowerCase().includes(q);
      const hitsB=!brand || r.restaurant===brand;
      const hitsC=!cat || cat==='all' || (r.category||'').toLowerCase()===cat;
      return hitsQ && hitsB && hitsC;
    });
  }

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
    try{ _statsCache = await fetch('/api/offer-stats').then(r=>r.json()).then(x=>x.stats||{}); }
    catch{ _statsCache = {}; }
    return _statsCache;
  }

  // distance helpers
  const toRad=d=>d*Math.PI/180;
  function haversineKm(lat1,lng1,lat2,lng2){
    const R=6371, dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function goodCoord(lat,lng){ if(lat==null||lng==null) return false; if(!isFinite(lat)||!isFinite(lng)) return false; if(Math.abs(lat)<.1&&Math.abs(lng)<.1) return false; return true; }
  function safeMiles(km,maxMiles=200){ if(!isFinite(km)) return ''; const mi=km*0.621371; if(mi>maxMiles) return ''; return (mi<10?mi.toFixed(1):Math.round(mi))+' mi'; }

  function normalizeAddresses(o){
    let list=[]; if(Array.isArray(o.addresses)) list=[...o.addresses]; else if(o.address) list=[o.address];
    return list.map(entry=>{
      if(typeof entry==='string') return {label:entry};
      const label=entry.label || [entry.street,entry.city,entry.state].filter(Boolean).join(', ');
      return { label, lat: entry.lat, lng: entry.lng };
    }).filter(a=>a && a.label);
  }
  function nearestAddress(o){
    const addrs=normalizeAddresses(o);
    if(!addrs.length || !goodCoord(_nearby.lat,_nearby.lng)) return null;
    let best=-1, bestKm=Infinity;
    addrs.forEach((a,i)=>{
      if(isFinite(a.lat)&&isFinite(a.lng)&&goodCoord(a.lat,a.lng)){
        const km=haversineKm(_nearby.lat,_nearby.lng,a.lat,a.lng);
        if(km<bestKm){ bestKm=km; best=i; }
      }
    });
    if(best<0) return null;
    return { index:best, distanceKm:bestKm, address:addrs[best], all:addrs };
  }

  async function computeNearbySort(){
    if(!navigator.geolocation) return;
    const pos = await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:10000})).catch(()=>null);
    if(!pos) return;
    const {latitude:lat,longitude:lng}=pos.coords;
    if(!goodCoord(lat,lng)) return;
    _nearby.lat=lat; _nearby.lng=lng;
    const list = await fetch(`/api/nearby?lat=${lat}&lng=${lng}&radiusKm=50`).then(r=>r.json()).then(x=>x.stores||[]).catch(()=>[]);
    _nearby.brandDist=new Map();
    list.forEach(s=>{ if(isFinite(s.distanceKm)) _nearby.brandDist.set((s.brand||'').toLowerCase(), s.distanceKm); });
  }

  function sortByNearby(rows){
    if(!_nearby.brandDist || !_nearby.brandDist.size) return rows;
    return rows.slice().sort((a,b)=>{
      const da=_nearby.brandDist.get((a.restaurant||'').toLowerCase()) ?? Infinity;
      const db=_nearby.brandDist.get((b.restaurant||'').toLowerCase()) ?? Infinity;
      return da-db;
    });
  }

  function makeCard(o, opts={}){
    const stats=(_statsCache&&_statsCache[o.id])?_statsCache[o.id]:{issued:0,redeemed:0};
    const exp=expiryInfo(o);

    const el=document.createElement('article');
    el.className='card';
    el.dataset.offerId=String(o.id);

    // hero
    const hero=document.createElement('div');
    hero.className='hero hero--zoom';
    if (o.hero_nozoom === true) hero.classList.remove('hero--zoom');
    const img=document.createElement('img');
    img.className='img'; img.src=o.hero_image||''; img.alt=o.title||'';
    hero.appendChild(img);
    el.appendChild(hero);

    const body=document.createElement('div');
    body.className='body';
    el.appendChild(body);

    // ------- NEW HEAD GRID -------
    const head=document.createElement('div');
    head.className='head-grid';

    // brand row (row 1, left)
    const brandRow=document.createElement('div');
    brandRow.className='brand-row';
    const brand=document.createElement('div');
    brand.className='brand';
    brand.textContent=o.restaurant||'';
    brandRow.appendChild(brand);
    head.appendChild(brandRow);

    // title (row 2, left)
    const h3=document.createElement('h3');
    h3.textContent=o.title||o.id;
    head.appendChild(h3);

    // includes (row 3, left) — only if provided
    const incText=(o.includes || o.Includes || o.bundle || '').trim();
    if(incText){
      const inc=document.createElement('div');
      inc.className='includes-row';
      inc.textContent = `Includes: ${incText}`;
      head.appendChild(inc);
    }

    // right column logo + distance (spans rows 1-3, top aligned to brand)
    if (o.logo){
      const stack=document.createElement('div');
      stack.className='brand-logo-stack';

      const logo=document.createElement('img');
      logo.className='brand-logo-inline';
      logo.src=o.logo;
      logo.alt=(o.restaurant||'Brand')+' logo';
      stack.appendChild(logo);

      const distEl=document.createElement('div');
      distEl.className='brand-distance';

      let distText='';
      const near=nearestAddress(o);
      if (near && isFinite(near.distanceKm)){
        distText = safeMiles(near.distanceKm);
      } else if(_nearby.brandDist && _nearby.brandDist.size){
        const d=_nearby.brandDist.get((o.restaurant||'').toLowerCase());
        if (isFinite(d)) distText = safeMiles(d);
      }
      distEl.textContent = distText;
      if (distText) stack.appendChild(distEl);

      head.appendChild(stack);
    }

    body.appendChild(head);
    // ------- /HEAD GRID -------

    // address block
    (function renderAddress(){
      const info=nearestAddress(o);
      const addrs=normalizeAddresses(o);
      if (!addrs.length) return;

      const addr=document.createElement('div');
      addr.className='addr';

      if (info){
        const sm = safeMiles(info.distanceKm);
        addr.innerHTML = `${info.address.label}` + (sm ? ` <span class="addr-dist">• ${sm} away</span>` : '') +
                         (addrs.length>1 ? ` <small class="toggle" role="button" tabindex="0">(view all)</small>` : '');
      } else {
        addr.textContent = addrs[0].label + (addrs.length>1 ? ` (+${addrs.length-1} more)` : '');
      }
      body.appendChild(addr);

      if (addrs.length>1){
        const list=document.createElement('div'); list.className='addr-list';
        addrs.forEach(a=>{
          let line=a.label;
          if (isFinite(a.lat) && isFinite(a.lng) && goodCoord(_nearby.lat,_nearby.lng)){
            const km=haversineKm(_nearby.lat,_nearby.lng,a.lat,a.lng);
            const sm = safeMiles(km);
            if (sm) line += ` — ${sm}`;
          }
          const item=document.createElement('div'); item.textContent=line; list.appendChild(item);
        });
        body.appendChild(list);

        const toggle=addr.querySelector('.toggle');
        if (toggle){
          toggle.addEventListener('click', ()=> list.classList.toggle('show'));
          toggle.addEventListener('keydown', (e)=>{
            if(e.key==='Enter'||e.key===' '){ e.preventDefault(); list.classList.toggle('show'); }
          });
        }
      }
    })();

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
    body.appendChild(meta);

    const row=document.createElement('div');
    row.className='btnrow';
    body.appendChild(row);

    const cta=document.createElement('a');
    cta.className='btn btn-cta';
    cta.textContent=opts.wallet?'Use Now':'Tap to Redeem';
    cta.href=`/coupon?offer=${encodeURIComponent(o.id)}`;
    if (exp.expired){ cta.setAttribute('disabled',''); cta.href='javascript:void(0)'; }
    row.appendChild(cta);

    const fav=document.createElement('button');
    fav.className='btn btn-fav';
    fav.dataset.action='fav';
    fav.dataset.offerId=String(o.id);
    row.appendChild(fav);

    const wal=document.createElement('button');
    wal.className='btn btn-wallet';
    wal.dataset.action='wallet';
    wal.dataset.offerId=String(o.id);
    row.appendChild(wal);

    const print=document.createElement('a');
    print.className='btn btn-outline';
    print.textContent='Print';
    print.href=`/coupon-print.html?offer=${encodeURIComponent(o.id)}&src=card`;
    row.appendChild(print);

    updateButtonsFor(o.id);
    return el;
  }

  function updateButtonsFor(id){
    id=String(id);
    const favBtns=document.querySelectorAll(`.btn-fav[data-offer-id="${id}"]`);
    const walBtns=document.querySelectorAll(`.btn-wallet[data-offer-id="${id}"]`);
    favBtns.forEach(b=>{
      if(isFavorite(id)){ b.classList.add('btn-on'); b.textContent='Saved ✓'; }
      else{ b.classList.remove('btn-on'); b.textContent='⭐ Favorite'; }
    });
    walBtns.forEach(b=>{
      if(isInWallet(id)){ b.classList.add('btn-on'); b.textContent='Saved ✓'; }
      else{ b.classList.remove('btn-on'); b.textContent='Add to Wallet'; }
    });
  }

  async function enableNearbyAlerts(){
    try{
      const perm=await Notification.requestPermission();
      if(perm!=='granted') return alert('Notifications are blocked.');
      if(!navigator.geolocation) return alert('Location not available.');
      navigator.geolocation.getCurrentPosition(async(pos)=>{
        const {latitude,longitude}=pos.coords;
        fetch('/api/event',{ method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'enable_nearby',meta:{latitude,longitude}}) });
        alert('Nearby alerts enabled for this device.');
      },()=>alert('Could not get your location.'));
    }catch(e){ alert('Unable to enable alerts.'); }
  }

  return {
    readQuery, writeQuery, debounce,
    getFavoriteIds, getWalletIds, isFavorite, isInWallet, toggleFavorite, toggleWallet, updateButtonsFor,
    populateBrandFilter, applyFilter,
    makeCard, 
    enableNearbyAlerts, computeNearbySort, sortByNearby,
    get __nearbyReady(){ return Boolean(_nearby.brandDist && _nearby.brandDist.size); },
    set __nearbyReady(_v){},
    getStats, initBranding
  };
})();

// prime stats early (non-blocking)
(async ()=>{ try{ await Shared.getStats(); }catch{} })();

// Branding on load
document.addEventListener('DOMContentLoaded', () => {
  if (typeof Shared.initBranding === 'function') Shared.initBranding();
});

// tiny helpers
window.ACP = Object.assign(window.ACP || {}, {
  favs: () => JSON.parse(localStorage.getItem('acp_favorites_v1')||'[]'),
  wals: () => JSON.parse(localStorage.getItem('acp_wallet_v1')||'[]')
});
