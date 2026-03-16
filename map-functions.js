const map = L.map("map", { scrollWheelZoom: true });

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const cluster = L.markerClusterGroup({ showCoverageOnHover: false });
cluster.addTo(map);

let searchMarker = null;

const els = {
  category: document.getElementById("category"),
  reset: document.getElementById("reset"),
  kpiVisible: document.getElementById("kpi-visible"),
  kpiTotal: document.getElementById("kpi-total"),
  ddGroup: document.getElementById("dd-group"),
  ddService: document.getElementById("dd-service"),
  ddRegion: document.getElementById("dd-region"),
  ddProvince: document.getElementById("dd-province"),
  ddCity: document.getElementById("dd-city"),

  addressSearch: document.getElementById("address-search"),
  addressSearchBtn: document.getElementById("address-search-btn"),
  addressClearBtn: document.getElementById("address-clear-btn"),
  addressResults: document.getElementById("address-results"),
};

const state = {
  geojson: null,
  items: [],
  initialBounds: null,

  selectedGroups: new Set(),
  selectedServices: new Set(),
  manualRegions: new Set(),
  derivedRegions: new Set(),
  selectedProvinces: new Set(),
  selectedCities: new Set(),

  groupsTouched: false,

  searchResults: [],
  activeSearchIndex: -1,
};

const norm = (s) => (s ?? "").toString().trim().toLowerCase();
const provCode = (p) => (p?.address_district || "").toUpperCase().trim();
const provRegion = (code) => (window.PROVINCE_INFO?.[code]?.region || "");

function provLabelSafe(code) {
  const info = window.PROVINCE_INFO?.[code];
  return info ? `${code} — ${info.name}` : code;
}

function groupValue(p) {
  const g = (p?.group_name ?? "").toString().trim();
  return g ? g : "Indipendenti";
}

function effectiveRegions() {
  return new Set([...state.manualRegions, ...state.derivedRegions]);
}

function hasManualScope() {
  return state.manualRegions.size > 0;
}

function inManualScope(region) {
  return !hasManualScope() || state.manualRegions.has(region);
}

function recomputeDerivedRegions() {
  const d = new Set();

  for (const code of state.selectedProvinces) {
    const reg = provRegion(code);
    if (reg) d.add(reg);
  }

  if (state.selectedCities.size > 0) {
    for (const it of state.items) {
      const p = it.feature.properties || {};
      const city = (p.address_city || "").trim();
      if (!city || !state.selectedCities.has(city)) continue;

      const reg = provRegion(provCode(p));
      if (reg) d.add(reg);
    }
  }

  state.derivedRegions = d;
}

function popupHtml(p) {
  const esc = (x) =>
    (x ?? "")
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const name = esc(p.name || "Esercente");
  const cat = p.establishment_category ? `<div><strong>Categoria:</strong> ${esc(p.establishment_category)}</div>` : "";
  const services = p.services ? `<div><strong>Servizi:</strong> ${esc(p.services)}</div>` : "";
  const addrParts = [p.address_line_1, p.address_zipcode, p.address_city, p.address_district].filter(Boolean);
  const address = addrParts.length ? `<div><strong>Indirizzo:</strong> ${esc(addrParts.join(", "))}</div>` : "";
  const group = `<div><strong>Gruppo:</strong> ${esc(groupValue(p))}</div>`;
  const hubspot = p.hubspot_id ? `<div style="color:#64748b;font-size:12px;margin-top:6px;">HubSpot id: ${esc(p.hubspot_id)}</div>` : "";

  return `<div style="min-width:240px">
    <div style="font-weight:800;margin-bottom:6px;">${name}</div>
    ${cat}${services}${address}${group}${hubspot}
  </div>`;
}

// ----------------------------
// Dropdown con ricerca
// ----------------------------
function createCheckboxDropdown(rootEl, opts) {
  const labelOf = (v) => (opts.renderLabel ? opts.renderLabel(v) : v);

  rootEl.classList.add("dd");
  rootEl.innerHTML = `
    <button type="button" class="dd-btn">
      <span class="dd-label">${opts.placeholder}</span>
      <span class="dd-meta">0 selezionati</span>
    </button>
    <div class="dd-panel">
      <div class="dd-head">
        <input class="dd-search" placeholder="Cerca..." />
        <div class="dd-actions">
          <button type="button" class="btn" data-act="all">Tutti</button>
          <button type="button" class="btn" data-act="none">Reset</button>
        </div>
      </div>
      <div class="dd-list"></div>
    </div>
  `;

  const btn = rootEl.querySelector(".dd-btn");
  const label = rootEl.querySelector(".dd-label");
  const meta = rootEl.querySelector(".dd-meta");
  const panel = rootEl.querySelector(".dd-panel");
  const list = rootEl.querySelector(".dd-list");
  const search = rootEl.querySelector(".dd-search");

  let values = [];
  const selected = new Set();

  const updateHead = () => {
    const n = selected.size;
    meta.textContent = `${n} selezionati`;
    if (n === 0) label.textContent = opts.placeholder;
    else if (n === 1) label.textContent = labelOf([...selected][0]);
    else label.textContent = `${n} selezionati`;
  };

  const render = () => {
    const q = norm(search.value);
    const arr = q
      ? values.filter(v => norm(labelOf(v)).includes(q) || norm(v).includes(q))
      : values;

    list.innerHTML = arr.map(v => {
      const checked = selected.has(v) ? "checked" : "";
      return `<label class="dd-item">
        <input type="checkbox" value="${v}" ${checked}/>
        <span>${labelOf(v)}</span>
      </label>`;
    }).join("");

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener("change", (e) => {
        const v = e.target.value;
        e.target.checked ? selected.add(v) : selected.delete(v);
        updateHead();
        opts.onChange([...selected]);
      });
    });
  };

  const setOpen = (open) => {
    rootEl.classList.toggle("open", open);
    if (open) {
      if (typeof opts.onOpen === "function") opts.onOpen();
      search.value = "";
      render();
      setTimeout(() => search.focus(), 0);
    }
  };

  btn.addEventListener("click", () => setOpen(!rootEl.classList.contains("open")));
  document.addEventListener("click", (e) => { if (!rootEl.contains(e.target)) setOpen(false); });
  panel.addEventListener("click", (e) => e.stopPropagation());

  search.addEventListener("input", render);

  rootEl.querySelectorAll(".dd-actions button").forEach(b => {
    b.addEventListener("click", () => {
      const act = b.getAttribute("data-act");
      if (act === "all") values.forEach(v => selected.add(v));
      if (act === "none") selected.clear();
      updateHead();
      render();
      opts.onChange([...selected]);
    });
  });

  return {
    setValues(vs) {
      values = [...new Set(vs)].filter(Boolean).sort((a, b) => a.localeCompare(b, "it"));
      for (const v of [...selected]) if (!values.includes(v)) selected.delete(v);
      updateHead();
      render();
    },
    setSelected(arr, { silent = false } = {}) {
      selected.clear();
      (arr || []).forEach(v => v && selected.add(v));
      for (const v of [...selected]) if (!values.includes(v)) selected.delete(v);
      updateHead();
      render();
      if (!silent) opts.onChange([...selected]);
    },
    clear({ silent = false } = {}) {
      selected.clear();
      updateHead();
      render();
      if (!silent) opts.onChange([]);
    },
    getSelected() {
      return [...selected];
    },
    refresh() {
      updateHead();
      render();
    }
  };
}

// ----------------------------
// Dropdown instances
// ----------------------------
const ddGroup = createCheckboxDropdown(els.ddGroup, {
  placeholder: "Tutti i gruppi",
  onChange: (arr) => {
    state.groupsTouched = true;
    state.selectedGroups = new Set(arr);
    applyFilters();
  },
});

const ddService = createCheckboxDropdown(els.ddService, {
  placeholder: "Tutti i servizi",
  onChange: (arr) => {
    state.selectedServices = new Set(arr);
    syncGroups();
    applyFilters();
  },
});

const ddRegion = createCheckboxDropdown(els.ddRegion, {
  placeholder: "Tutte le regioni",
  onChange: (arr) => {
    state.manualRegions = new Set(arr);

    if (hasManualScope()) {
      for (const code of [...state.selectedProvinces]) {
        const reg = provRegion(code);
        if (reg && !state.manualRegions.has(reg)) state.selectedProvinces.delete(code);
      }
      for (const c of [...state.selectedCities]) {
        let ok = false;
        for (const it of state.items) {
          const p = it.feature.properties || {};
          if ((p.address_city || "").trim() !== c) continue;
          const reg = provRegion(provCode(p));
          if (reg && state.manualRegions.has(reg)) { ok = true; break; }
        }
        if (!ok) state.selectedCities.delete(c);
      }
    }

    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });

    cascadeGeoOptions();
    syncGroups();
    applyFilters();
  },
});

const ddProvince = createCheckboxDropdown(els.ddProvince, {
  placeholder: "Tutte le province",
  renderLabel: (code) => provLabelSafe(code),
  onOpen: () => ddProvince.refresh(),
  onChange: (arr) => {
    state.selectedProvinces = new Set(arr);
    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });

    cascadeGeoOptions();
    syncGroups();
    applyFilters();
  },
});

const ddCity = createCheckboxDropdown(els.ddCity, {
  placeholder: "Tutte le città",
  onChange: (arr) => {
    state.selectedCities = new Set(arr);
    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });

    cascadeGeoOptions();
    syncGroups();
    applyFilters();
  },
});

// ----------------------------
// Options builders
// ----------------------------
function buildSingleSelect(select, values, allLabel = "Tutte") {
  const current = select.value;
  const sorted = [...values].filter(Boolean).sort((a, b) => a.localeCompare(b, "it"));
  select.innerHTML =
    `<option value="">${allLabel}</option>` +
    sorted.map(v => `<option value="${v}">${v}</option>`).join("");
  if (sorted.includes(current)) select.value = current;
}

function computeGeoOptions() {
  const provinces = new Set();
  const cities = new Set();

  for (const it of state.items) {
    const p = it.feature.properties || {};
    const code = provCode(p);
    const reg = provRegion(code);
    const city = (p.address_city || "").trim();

    if (!inManualScope(reg)) continue;
    if (code) provinces.add(code);
    if (city) cities.add(city);
  }

  return { provinces, cities };
}

function cascadeGeoOptions() {
  const { provinces, cities } = computeGeoOptions();

  ddProvince.setValues(provinces);
  ddCity.setValues(cities);

  if (hasManualScope()) {
    state.selectedProvinces = new Set([...state.selectedProvinces].filter(p => provinces.has(p)));
    ddProvince.setSelected([...state.selectedProvinces], { silent: true });

    state.selectedCities = new Set([...state.selectedCities].filter(c => cities.has(c)));
    ddCity.setSelected([...state.selectedCities], { silent: true });

    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });
  } else {
    ddProvince.setSelected([...state.selectedProvinces], { silent: true });
    ddCity.setSelected([...state.selectedCities], { silent: true });
  }

  ddProvince.refresh();
}

function rebuildFilters(features) {
  const cats = new Set();
  const services = new Set();
  const groups = new Set();
  const regionsAll = new Set();
  const provincesAll = new Set();
  const citiesAll = new Set();

  for (const f of features) {
    const p = f.properties || {};
    if (p.establishment_category) cats.add(p.establishment_category);

    groups.add(groupValue(p));

    const code = provCode(p);
    const reg = provRegion(code);
    if (reg) regionsAll.add(reg);
    if (code) provincesAll.add(code);

    const city = (p.address_city || "").trim();
    if (city) citiesAll.add(city);

    if (p.services) {
      p.services.split(",").map(s => s.trim()).filter(Boolean).forEach(s => services.add(s));
    }
  }

  buildSingleSelect(els.category, cats, "Tutte");

  ddService.setValues(services);
  ddRegion.setValues(regionsAll);
  ddProvince.setValues(provincesAll);
  ddCity.setValues(citiesAll);

  ddGroup.setValues(groups);
  ddGroup.setSelected([], { silent: true });

  ddRegion.setSelected([], { silent: true });
  ddProvince.setSelected([], { silent: true });
  ddCity.setSelected([], { silent: true });

  state.selectedServices.clear();
  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();

  state.selectedGroups.clear();
  state.groupsTouched = false;

  cascadeGeoOptions();
}

// ----------------------------
// Filtri mappa
// ----------------------------
function passesNonGroupFilters(p) {
  const cat = els.category.value;

  const regionsSel = [...effectiveRegions()];
  const provincesSel = [...state.selectedProvinces];
  const citiesSel = [...state.selectedCities];
  const servicesSel = [...state.selectedServices];

  if (cat && p.establishment_category !== cat) return false;

  const code = provCode(p);
  const reg = provRegion(code);
  const city = (p.address_city || "").trim();

  if (regionsSel.length > 0 && !regionsSel.includes(reg)) return false;
  if (provincesSel.length > 0 && !provincesSel.includes(code)) return false;
  if (citiesSel.length > 0 && !citiesSel.includes(city)) return false;

  if (servicesSel.length > 0) {
    const itemServices = (p.services || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!servicesSel.some(s => itemServices.includes(s))) return false;
  }

  return true;
}

function syncGroups() {
  if (!state.items.length) return;

  const cat = els.category.value;
  const hasNonGroup =
    !!cat ||
    state.selectedServices.size > 0 ||
    effectiveRegions().size > 0 ||
    state.selectedProvinces.size > 0 ||
    state.selectedCities.size > 0;

  const available = new Set();
  for (const it of state.items) {
    const p = it.feature.properties || {};
    if (!passesNonGroupFilters(p)) continue;
    available.add(groupValue(p));
  }

  const availArr = [...available].sort((a, b) => a.localeCompare(b, "it"));
  ddGroup.setValues(availArr);

  if (!state.groupsTouched) {
    if (!hasNonGroup) {
      state.selectedGroups.clear();
      ddGroup.setSelected([], { silent: true });
    } else {
      state.selectedGroups = new Set(availArr);
      ddGroup.setSelected(availArr, { silent: true });
    }
  } else {
    const kept = availArr.filter(g => state.selectedGroups.has(g));
    state.selectedGroups = new Set(kept);
    ddGroup.setSelected(kept, { silent: true });
  }
}

function applyFilters() {
  cluster.clearLayers();

  let visible = 0;
  for (const it of state.items) {
    const p = it.feature.properties || {};
    if (!passesNonGroupFilters(p)) continue;

    const g = groupValue(p);
    if (state.selectedGroups.size > 0 && !state.selectedGroups.has(g)) continue;

    cluster.addLayer(it.marker);
    visible += 1;
  }

  els.kpiVisible.textContent = visible.toLocaleString("it-IT");
}

function resetAll() {
  els.category.value = "";

  ddGroup.clear({ silent: true });
  ddService.clear({ silent: true });
  ddRegion.clear({ silent: true });
  ddProvince.clear({ silent: true });
  ddCity.clear({ silent: true });

  state.selectedGroups.clear();
  state.selectedServices.clear();
  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();
  state.groupsTouched = false;

  clearAddressSearch();

  if (state.geojson?.features) rebuildFilters(state.geojson.features);
  if (state.initialBounds) map.fitBounds(state.initialBounds);

  syncGroups();
  applyFilters();
}

// ----------------------------
// Ricerca indirizzo (Nominatim)
// ----------------------------
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openAddressResults() {
  els.addressResults.classList.add("open");
}

function closeAddressResults() {
  els.addressResults.classList.remove("open");
}

function clearAddressResults() {
  state.searchResults = [];
  state.activeSearchIndex = -1;
  els.addressResults.innerHTML = "";
  closeAddressResults();
}

function setActiveAddressResult(index) {
  state.activeSearchIndex = index;
  const items = els.addressResults.querySelectorAll(".search-item");
  items.forEach((el, i) => el.classList.toggle("active", i === index));

  const activeEl = items[index];
  if (activeEl) {
    const parent = els.addressResults;
    const top = activeEl.offsetTop;
    const bottom = top + activeEl.offsetHeight;
    if (top < parent.scrollTop) parent.scrollTop = top;
    if (bottom > parent.scrollTop + parent.clientHeight) {
      parent.scrollTop = bottom - parent.clientHeight;
    }
  }
}

function setSearchMarker(lat, lon, label) {
  const point = [Number(lat), Number(lon)];

  if (searchMarker) {
    map.removeLayer(searchMarker);
  }

  searchMarker = L.marker(point).addTo(map);

  if (label) {
    searchMarker.bindPopup(label).openPopup();
  }

  map.setView(point, 16);
}

function chooseAddressResult(index) {
  const item = state.searchResults[index];
  if (!item) return;

  const lat = Number(item.lat);
  const lon = Number(item.lon);
  const label = item.display_name || "Risultato ricerca";

  els.addressSearch.value = label;
  clearAddressResults();
  setSearchMarker(lat, lon, escapeHtml(label));
}

function clearAddressSearch() {
  els.addressSearch.value = "";
  clearAddressResults();

  if (searchMarker) {
    map.removeLayer(searchMarker);
    searchMarker = null;
  }
}

function renderAddressResults(results) {
  state.searchResults = results || [];
  state.activeSearchIndex = -1;

  if (!state.searchResults.length) {
    els.addressResults.innerHTML = `<div class="search-item">Nessun risultato trovato</div>`;
    openAddressResults();
    return;
  }

  els.addressResults.innerHTML = state.searchResults.map((item, index) => {
    const title = escapeHtml(item.display_name || "Risultato");
    const type = escapeHtml(item.type || item.addresstype || "");
    return `
      <div class="search-item" data-index="${index}">
        ${title}
        ${type ? `<small>${type}</small>` : ""}
      </div>
    `;
  }).join("");

  els.addressResults.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseAddressResult(Number(el.dataset.index));
    });
  });

  openAddressResults();
  if (state.searchResults.length > 0) setActiveAddressResult(0);
}

async function searchAddress(query) {
  const q = (query || "").trim();
  if (q.length < 3) {
    clearAddressResults();
    return;
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    format: "jsonv2",
    countrycodes: "it",
    addressdetails: "1",
    limit: "8",
    q
  }).toString();

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Errore ricerca indirizzo: ${res.status}`);
  }

  const data = await res.json();
  renderAddressResults(data);
}

// ----------------------------
// Init + events
// ----------------------------
async function init() {
  const res = await fetch("./locations.geojson", { cache: "no-store" });
  if (!res.ok) throw new Error("Impossibile caricare locations.geojson");

  const geojson = await res.json();
  state.geojson = geojson;

  els.kpiTotal.textContent = geojson.features.length.toLocaleString("it-IT");

  state.items = geojson.features.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const marker = L.marker([lat, lng]).bindPopup(popupHtml(f.properties || {}));
    return { feature: f, marker };
  });

  const bounds = L.latLngBounds(state.items.map(x => x.marker.getLatLng())).pad(0.08);
  state.initialBounds = bounds;
  map.fitBounds(bounds);

  rebuildFilters(geojson.features);
  syncGroups();
  applyFilters();
}

els.category.addEventListener("change", () => {
  syncGroups();
  applyFilters();
});

els.reset.addEventListener("click", (e) => {
  e.preventDefault();
  resetAll();
});

els.addressSearchBtn.addEventListener("click", async () => {
  try {
    await searchAddress(els.addressSearch.value);
  } catch (err) {
    console.error(err);
    els.addressResults.innerHTML = `<div class="search-item">Errore durante la ricerca</div>`;
    openAddressResults();
  }
});

els.addressClearBtn.addEventListener("click", () => {
  clearAddressSearch();
});

els.addressSearch.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();

    if (state.searchResults.length && state.activeSearchIndex >= 0) {
      chooseAddressResult(state.activeSearchIndex);
      return;
    }

    try {
      await searchAddress(els.addressSearch.value);
    } catch (err) {
      console.error(err);
      els.addressResults.innerHTML = `<div class="search-item">Errore durante la ricerca</div>`;
      openAddressResults();
    }
  }

  if (e.key === "ArrowDown") {
    if (!state.searchResults.length) return;
    e.preventDefault();
    const next = Math.min(state.activeSearchIndex + 1, state.searchResults.length - 1);
    setActiveAddressResult(next);
  }

  if (e.key === "ArrowUp") {
    if (!state.searchResults.length) return;
    e.preventDefault();
    const prev = Math.max(state.activeSearchIndex - 1, 0);
    setActiveAddressResult(prev);
  }

  if (e.key === "Escape") {
    clearAddressResults();
  }
});

let addressDebounce = null;
els.addressSearch.addEventListener("input", () => {
  clearTimeout(addressDebounce);

  const q = els.addressSearch.value.trim();
  if (q.length < 3) {
    clearAddressResults();
    return;
  }

  addressDebounce = setTimeout(async () => {
    try {
      await searchAddress(q);
    } catch (err) {
      console.error(err);
      els.addressResults.innerHTML = `<div class="search-item">Errore durante la ricerca</div>`;
      openAddressResults();
    }
  }, 300);
});

document.addEventListener("mousedown", (e) => {
  const wrap = els.addressResults.parentElement;
  if (!wrap.contains(e.target)) {
    clearAddressResults();
  }
});

init().catch((err) => {
  console.error(err);
  alert("Errore inizializzazione mappa. Controlla console e locations.geojson.");
});
