// shared.js — rendering + wallet helpers (no framework)
const Shared = (function(){
  const LS_KEY = 'acp_saved_offers';

  function getSaved(){
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }
  function isSaved(id){ return getSaved().includes(id); }
  function save(id){
    const s = getSaved();
    if (!s.includes(id)) { s.push(id); localStorage.setItem(LS_KEY, JSON.stringify(s)); }
    try{ fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({offer_id:id})}); }catch{}
  }
  function remove(id){
    const s = getSaved().filter(x=>x!==id);
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  function populateBrandFilter(rows, selectEl){
    const brands = Array.from(new Set(rows.map(r => r.restaurant).filter(Boolean))).sort();
    brands.forEach(b => {
      const o = document.createElement('option');
      o.value = b; o.textContent = b;
      selectEl.appendChild(o);
    });
  }

  function applyFilter(rows, state){
    const q = (state.q||'').toLowerCase();
    const brand = state.brand || '';
    return rows.filter(r=>{
      const hitsQ = !q || `${r.title} ${r.restaurant}`.toLowerCase().includes(q);
      const hitsB = !brand || r.restaurant === brand;
      return hitsQ && hitsB;
    });
  }

  function makeCard(o, opts={}){
    const el = document.createElement('article');
    el.className = 'card';
    const img = document.createElement('img');
    img.className = 'img';
    img.src = o.hero_image || '';
    img.alt = o.title || '';
    el.appendChild(img);

    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);

    const h3 = document.createElement('h3');
    h3.textContent = o.title || o.id;
    body.appendChild(h3);

    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = o.restaurant || '';
    body.appendChild(brand);

    if (o.description) {
      const desc = document.createElement('p');
      desc.className = 'desc';
      desc.textContent = o.description;
      body.appendChild(desc);
    }

    const row = document.createElement('div');
    row.className = 'btnrow';
    body.appendChild(row);

    // Redeem
    const redeem = document.createElement('a');
    redeem.className = 'btn btn-primary';
    redeem.textContent = 'Tap to Redeem';
    redeem.href = `/coupon?offer=${encodeURIComponent(o.id)}`;
    row.appendChild(redeem);

    // Favorite / Saved toggle
    const fav = document.createElement('button');
    fav.className = 'btn';
    const setFavState = ()=>{
      const saved = isSaved(o.id);
      fav.innerHTML = `${saved ? '★' : '☆'} Favorite`;
    };
    fav.onclick = ()=>{
      if (isSaved(o.id)) { remove(o.id); } else { save(o.id); }
      setFavState();
      // If we're on wallet, removing should also remove the card
      if (opts.wallet && !isSaved(o.id)) el.remove();
    };
    setFavState();
    row.appendChild(fav);

    // Add to Wallet (same as favorite for now, but separate label)
    const add = document.createElement('button');
    add.className = 'btn';
    add.textContent = 'Add to Wallet';
    add.onclick = ()=>{ save(o.id); setFavState(); };
    row.appendChild(add);

    return el;
  }

  async function enableNearbyAlerts(){
    try{
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return alert('Notifications are blocked.');
      if (!navigator.geolocation) return alert('Location not available.');
      navigator.geolocation.getCurrentPosition(async (pos)=>{
        const { latitude, longitude } = pos.coords;
        fetch(`/api/event`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ type:'enable_nearby', meta:{ latitude, longitude } })
        });
        alert('Nearby alerts enabled for this device.');
      }, ()=>alert('Could not get your location.'));
    }catch(e){ alert('Unable to enable alerts.'); }
  }

  return { getSaved, populateBrandFilter, applyFilter, makeCard, enableNearbyAlerts };
})();
