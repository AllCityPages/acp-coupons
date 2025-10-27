// shared.js — rendering + wallet helpers (no framework)
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
      s.push(id);
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      try { fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ offer_id:id }) }); } catch {}
    }
  }
  function remove(id) {
    const s = getSaved().filter(x => x !== id);
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  /* ---------- Filters / Search ---------- */
  function populateBrandFilter(rows, selectEl) {
    const brands = Array.from(new Set(rows.map(r => r.restaurant).filter(Boolean))).sort();
    brands.forEach(b => {
      const o = document.createElement('option');
      o.value = b; o.textContent = b;
      selectEl.appendChild(o);
    });
  }

  function applyFilter(rows, state) {
    const q = (state.q || '').toLowerCase();
    const brand = state.brand || '';
    return rows.filter(r => {
      const hitsQ = !q || `${r.title} ${r.restaurant}`.toLowerCase().includes(q);
      const hitsB = !brand || r.restaurant === brand;
      return hitsQ && hitsB;
    });
  }

  /* ---------- Rendering ---------- */
  function makeCard(o, opts = {}) {
    const el = document.createElement('article');
    el.className = 'card';

    const img = document.createElement('img');
    img.className = 'img';
    img.loading = 'lazy';
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
    fav.setAttribute('aria-pressed', isSaved(o.id));
    function setFavState() {
      const saved = isSaved(o.id);
      fav.setAttribute('aria-pressed', saved);
      fav.textContent = `${saved ? '★' : '☆'} Favorite`;
    }
    fav.onclick = () => {
      isSaved(o.id) ? remove(o.id) : save(o.id);
      setFavState();
      if (opts.wallet && !isSaved(o.id)) el.remove();
    };
    setFavState();
    row.appendChild(fav);

    // Add to Wallet (alias of save)
    const add = document.createElement('button');
    add.className = 'btn';
    add.textContent = 'Add to Wallet';
    add.onclick = () => { save(o.id); setFavState(); };
    row.appendChild(add);

    return el;
  }

  /* ---------- Nearby Alerts (stubbed safely) ---------- */
  async function enableNearbyAlerts() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { alert('Notifications are blocked.'); return; }
      if (!navigator.geolocation) { alert('Location not available.'); return; }
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        fetch('/api/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'enable_nearby', meta: { latitude, longitude } })
        });
        alert('Nearby alerts enabled for this device.');
      }, () => alert('Could not get your location.'));
    } catch { alert('Unable to enable alerts.'); }
  }

  /* ---------- URL helpers (q/brand sync) ---------- */
  function readQuery() {
    const u = new URL(location.href);
    return { q: u.searchParams.get('q') || '', brand: u.searchParams.get('brand') || '' };
  }
  function writeQuery(state) {
    const u = new URL(location.href);
    if (state.q) u.searchParams.set('q', state.q); else u.searchParams.delete('q');
    if (state.brand) u.searchParams.set('brand', state.brand); else u.searchParams.delete('brand');
    history.replaceState(null, '', u.toString());
  }

  /* ---------- Little util: debounce ---------- */
  function debounce(fn, ms = 200) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  return {
    getSaved, isSaved, save, remove,
    populateBrandFilter, applyFilter, makeCard,
    enableNearbyAlerts,
    readQuery, writeQuery, debounce
  };
})();
