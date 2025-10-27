// shared.js — rendering + wallet helpers with brand-accent buttons
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
      try {
        fetch('/api/save', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ offer_id:id })
        });
      } catch {}
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

  /* ---------- Color helpers for brand accent ---------- */
  function hexToRgb(hex) {
    if (!hex) return null;
    const s = hex.trim();
    const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
    const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m3) {
      const v = m3[1];
      return {
        r: parseInt(v[0] + v[0], 16),
        g: parseInt(v[1] + v[1], 16),
        b: parseInt(v[2] + v[2], 16)
      };
    }
    if (m6) {
      const v = m6[1];
      return { r: parseInt(v.slice(0,2),16), g: parseInt(v.slice(2,4),16), b: parseInt(v.slice(4,6),16) };
    }
    return null;
  }
  function relLuminance({r,g,b}) {
    // WCAG relative luminance
    const toLin = c => {
      const cs = c/255;
      return cs <= 0.03928 ? cs/12.92 : Math.pow((cs+0.055)/1.055, 2.4);
    };
    return 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
  }
  function bestTextColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    return relLuminance(rgb) > 0.55 ? '#111827' : '#ffffff'; // dark text on light colors
  }
  function applyAccent(btnEl, hex) {
    if (!hex) return;
    const text = bestTextColor(hex);
    btnEl.classList.add('btn-accent');
    btnEl.style.background = hex;
    btnEl.style.color = text;
    btnEl.style.borderColor = hex;
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

    // Redeem (accented)
    const redeem = document.createElement('a');
    redeem.className = 'btn btn-primary';
    redeem.textContent = 'Tap to Redeem';
    redeem.href = `/coupon?offer=${encodeURIComponent(o.id)}`;
    row.appendChild(redeem);

    // Apply brand accent
    const accent = o.accent_color || o.brand_color || null;
    if (accent) applyAccent(redeem, accent);

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

  /* ---------- Nearby Alerts (safe stub) ---------- */
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
    state.q ? u.searchParams.set('q', state.q) : u.searchParams.delete('q');
    state.brand ? u.searchParams.set('brand', state.brand) : u.searchParams.delete('brand');
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
