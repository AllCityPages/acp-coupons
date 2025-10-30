// shared.js — v14
const Shared = (() => {

  function populateBrandFilter(offers, selectEl){
    const brands = Array.from(new Set(offers.map(o => o.brand).filter(Boolean))).sort();
    brands.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      selectEl.appendChild(opt);
    });
  }

  function applyFilter(offers, state){
    let rows = offers;
    if (state.q){
      const q = state.q.toLowerCase();
      rows = rows.filter(o =>
        (o.title && o.title.toLowerCase().includes(q)) ||
        (o.brand && o.brand.toLowerCase().includes(q)) ||
        (o.desc && o.desc.toLowerCase().includes(q))
      );
    }
    if (state.brand){
      rows = rows.filter(o => o.brand === state.brand);
    }
    return rows;
  }

  function makeCard(offer, opts={}){
    const card = document.createElement('article');
    card.className = 'card';

    // image
    const img = document.createElement('div');
    img.className = 'img';
    if (offer.image) {
      img.style.backgroundImage = `url(${offer.image})`;
      img.style.backgroundSize = 'cover';
      img.style.backgroundPosition = 'center';
    }
    card.appendChild(img);

    const body = document.createElement('div');
    body.className = 'body';

    const h3 = document.createElement('h3');
    h3.textContent = offer.title || 'Untitled offer';
    body.appendChild(h3);

    if (offer.brand){
      const b = document.createElement('div');
      b.className = 'brand';
      b.textContent = offer.brand;
      body.appendChild(b);
    }

    if (offer.desc){
      const p = document.createElement('p');
      p.className = 'desc';
      p.textContent = offer.desc;
      body.appendChild(p);
    }

    // meta badges (optional)
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (offer.category){
      const cat = document.createElement('span');
      cat.className = 'badge';
      cat.textContent = offer.category;
      meta.appendChild(cat);
    }
    if (offer.city){
      const ct = document.createElement('span');
      ct.className = 'badge';
      ct.textContent = offer.city;
      meta.appendChild(ct);
    }
    if (meta.childElementCount){
      body.appendChild(meta);
    }

    // actions
    const actions = document.createElement('div');
    actions.className = 'btnrow';

    // 1) Tap to Redeem (primary)
    const btnRedeem = document.createElement('button');
    btnRedeem.className = 'btn btn-cta';
    btnRedeem.textContent = 'Tap to Redeem';
    btnRedeem.onclick = () => {
      if (offer.redeem_url) {
        location.href = offer.redeem_url;
      }
    };
    actions.appendChild(btnRedeem);

    // 2) Add to Wallet — black/white
    const btnWallet = document.createElement('button');
    btnWallet.className = 'btn btn-add-wallet';
    btnWallet.textContent = 'Add to Wallet';
    btnWallet.onclick = () => {
      // stub – your save logic here
      const saved = JSON.parse(localStorage.getItem('acp:saved') || '[]');
      if (!saved.includes(offer.id)) {
        saved.push(offer.id);
        localStorage.setItem('acp:saved', JSON.stringify(saved));
      }
    };
    actions.appendChild(btnWallet);

    // 3) Favorite — yellow/black
    const btnFav = document.createElement('button');
    btnFav.className = 'btn btn-favorite';
    btnFav.textContent = 'Favorite';
    btnFav.onclick = () => {
      // stub – your favorite logic here
    };
    actions.appendChild(btnFav);

    // 4) Saved — green/white (only show if it's actually saved)
    const savedIds = new Set(JSON.parse(localStorage.getItem('acp:saved') || '[]'));
    if (savedIds.has(offer.id)) {
      const btnSaved = document.createElement('button');
      btnSaved.className = 'btn btn-saved';
      btnSaved.textContent = 'Saved';
      actions.appendChild(btnSaved);
    }

    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function getSaved(){
    return JSON.parse(localStorage.getItem('acp:saved') || '[]');
  }

  function readQuery(){
    const out = {};
    const url = new URL(location.href);
    url.searchParams.forEach((v,k) => out[k]=v);
    return out;
  }

  async function computeNearbySort(){
    // stub — your nearby code
  }

  function sortByNearby(rows){
    return rows;
  }

  function renderCategoryChips(){}

  function renderNotifyCTA(){}

  return {
    populateBrandFilter,
    applyFilter,
    makeCard,
    getSaved,
    readQuery,
    computeNearbySort,
    sortByNearby,
    renderCategoryChips,
    renderNotifyCTA,
  };
})();
