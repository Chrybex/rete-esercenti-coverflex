/* =========================
   1) CONFIG
========================= */

const CONFIG = {
  geojsonUrl: "./converted-leaflet-status-refixed.geojson",
  mapDefaultCenter: [42.5, 12.5],
  mapDefaultZoom: 6,
  searchMinChars: 6,
  searchDebounceMs: 1500,
  searchLimit: 5,
  nearbyDefaultKm: 5
};

/* =========================
   2) MAP
========================= */

const map = L.map("map", {
  scrollWheelZoom: true,
  preferCanvas: true
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const cluster = L.markerClusterGroup({ showCoverageOnHover: false }).addTo(map);

/* =========================
   3) DOM + STATE
========================= */

const els = {
  category: document.getElementById("category"),
  reset: document.getElementById("reset"),
  kpiVisible: document.getElementById("kpi-visible"),
  kpiTotal: document.getElementById("kpi-total"),
  ddGroup: document.getElementById("dd-group"),
  ddStatus: document.getElementById("dd-status"),
  ddService: document.getElementById("dd-service"),
  ddRegion: document.getElementById("dd-region"),
  ddProvince: document.getElementById("dd-province"),
  ddCity: document.getElementById("dd-city"),
  address: document.getElementById("address"),
  searchBtn: document.getElementById("search-btn"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  searchWrap: document.querySelector(".search-wrap"),
  nearbyRadius: document.getElementById("nearby-radius"),
  nearbyCount: document.getElementById("nearby-count"),
  nearbyList: document.getElementById("nearby-list")
};

const state = {
  geojson: null,
  items: [],
  visibleItems: [],
  initialBounds: null,

  selectedGroups: new Set(),
  selectedStatuses: new Set(),
  selectedServices: new Set(),
  manualRegions: new Set(),
  derivedRegions: new Set(),
  selectedProvinces: new Set(),
  selectedCities: new Set(),
  groupsTouched: false,

  lastSearchLat: null,
  lastSearchLon: null,

  searchMarker: null,
  debounceTimer: null,
  activeIndex: -1,
  currentResults: [],
  lastAutocompleteQuery: "",
  searchAbortController: null,
  searchCache: new Map()
};

/* =========================
   4) UTILS
========================= */

const norm = (v) => String(v || "").trim().toLowerCase();
const uniqSorted = (arr) => [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b, "it"));
const provinceCodeOf = (p) => String(p?.address_district || "").toUpperCase().trim();
const provinceRegionOf = (code) => window.PROVINCE_INFO?.[code]?.region || "";
const provinceLabelOf = (code) => window.PROVINCE_INFO?.[code] ? `${code} — ${window.PROVINCE_INFO[code].name}` : code;
const normalizeQuery = (q) => String(q || "").trim().replace(/\s+/g, " ").toLowerCase();
const cacheKey = (q, limit) => `${normalizeQuery(q)}|${limit}`;
const effectiveRegions = () => new Set([...state.manualRegions, ...state.derivedRegions]);
const hasManualScope = () => state.manualRegions.size > 0;
const inManualScope = (region) => !hasManualScope() || state.manualRegions.has(region);

function normalizeCityName(name) {
  const s = norm(name);
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

function groupValue(p) {
  const g = String(p?.group_name || "").trim();
  return g || "Indipendenti";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(text, isError = false) {
  els.status.textContent = text || "";
  els.status.style.color = isError ? "#b00020" : "";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* =========================
   5) POPUP + SEARCH UI
========================= */

function popupHtml(p) {
  const esc = escapeHtml;
  const row = (label, value) => value ? `<div><strong>${label}:</strong> ${esc(value)}</div>` : "";
  const address = [p.address_line_1, p.address_zipcode, p.address_city, p.address_district].filter(Boolean).join(", ");

  return `
    <div style="min-width:240px">
      <div style="font-weight:800;margin-bottom:6px;">${esc(p.name || "Esercente")}</div>
      ${row("Categoria", p.establishment_category)}
      ${row("Status", p.status)}
      ${row("Servizi", p.services)}
      ${row("Indirizzo", address)}
      ${row("Gruppo", groupValue(p))}
      ${p.hubspot_id ? `<div style="color:#64748b;font-size:12px;margin-top:6px;">HubSpot id: ${esc(p.hubspot_id)}</div>` : ""}
    </div>
  `;
}

function showSearchResults() {
  const visible = els.results.children.length > 0;
  els.results.style.display = visible ? "block" : "none";
  els.address.setAttribute("aria-expanded", visible ? "true" : "false");
}

function clearSearchResults() {
  state.currentResults = [];
  state.activeIndex = -1;
  els.results.innerHTML = "";
  els.results.style.display = "none";
  els.address.setAttribute("aria-expanded", "false");
}

function setActiveResult(index) {
  state.activeIndex = index;
  const items = els.results.querySelectorAll("li[data-index]");
  items.forEach((item, i) => item.classList.toggle("active", i === state.activeIndex));

  const active = items[state.activeIndex];
  if (!active) return;

  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < els.results.scrollTop) els.results.scrollTop = top;
  else if (bottom > els.results.scrollTop + els.results.clientHeight) {
    els.results.scrollTop = bottom - els.results.clientHeight;
  }
}

function clearSearchMarker() {
  if (!state.searchMarker) return;
  map.removeLayer(state.searchMarker);
  state.searchMarker = null;
}

function setSearchMarker(lat, lon, label) {
  clearSearchMarker();
  state.searchMarker = L.circleMarker([lat, lon], {
    radius: 10,
    color: "#b91c1c",
    weight: 3,
    fillColor: "#ef4444",
    fillOpacity: 0.95
  }).addTo(map);

  map.setView([lat, lon], 16);
  if (label) state.searchMarker.bindPopup(label).openPopup();
}

/* =========================
   6) DROPDOWN FACTORY
========================= */

function createCheckboxDropdown(rootEl, { placeholder, renderLabel, onChange, onOpen }) {
  const labelOf = (v) => renderLabel ? renderLabel(v) : v;

  rootEl.classList.add("dd");
  rootEl.innerHTML = `
    <button type="button" class="dd-btn">
      <span class="dd-label">${placeholder}</span>
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
    label.textContent = n === 0 ? placeholder : n === 1 ? labelOf([...selected][0]) : `${n} selezionati`;
  };

  const render = () => {
    const q = norm(search.value);
    const filtered = q ? values.filter(v => norm(labelOf(v)).includes(q) || norm(v).includes(q)) : values;

    list.innerHTML = filtered.map(v => `
      <label class="dd-item">
        <input type="checkbox" value="${String(v).replaceAll('"', "&quot;")}" ${selected.has(v) ? "checked" : ""} />
        <span>${labelOf(v)}</span>
      </label>
    `).join("");

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener("change", (e) => {
        const v = e.target.value;
        e.target.checked ? selected.add(v) : selected.delete(v);
        updateHead();
        onChange([...selected]);
      });
    });
  };

  const setOpen = (open) => {
    rootEl.classList.toggle("open", open);
    if (!open) return;
    onOpen?.();
    search.value = "";
    render();
    setTimeout(() => search.focus(), 0);
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!rootEl.classList.contains("open"));
  });

  document.addEventListener("click", (e) => {
    if (!rootEl.contains(e.target)) setOpen(false);
  });

  panel.addEventListener("click", (e) => e.stopPropagation());
  search.addEventListener("input", render);

  rootEl.querySelectorAll(".dd-actions button").forEach(b => {
    b.addEventListener("click", () => {
      const act = b.getAttribute("data-act");
      if (act === "all") values.forEach(v => selected.add(v));
      if (act === "none") selected.clear();
      updateHead();
      render();
      onChange([...selected]);
    });
  });

  return {
    setValues(vs) {
      values = uniqSorted(vs);
      [...selected].forEach(v => { if (!values.includes(v)) selected.delete(v); });
      updateHead();
      render();
    },
    setSelected(arr, { silent = false } = {}) {
      selected.clear();
      (arr || []).forEach(v => v && selected.add(v));
      [...selected].forEach(v => { if (!values.includes(v)) selected.delete(v); });
      updateHead();
      render();
      if (!silent) onChange([...selected]);
    },
    clear(opts = {}) {
      selected.clear();
      updateHead();
      render();
      if (!opts.silent) onChange([]);
    },
    refresh() {
      updateHead();
      render();
    }
  };
}

/* =========================
   7) FILTER ENGINE
========================= */

function recomputeDerivedRegions() {
  const derived = new Set();

  [...state.selectedProvinces].forEach(code => {
    const region = provinceRegionOf(code);
    if (region) derived.add(region);
  });

  if (state.selectedCities.size) {
    state.items.forEach(it => {
      if (it.city && state.selectedCities.has(it.city) && it.region) derived.add(it.region);
    });
  }

  state.derivedRegions = derived;
}

function computeGeoOptions() {
  const provinces = new Set();
  const cities = new Set();

  state.items.forEach(it => {
    if (!inManualScope(it.region)) return;
    if (it.province) provinces.add(it.province);
    if (it.city) cities.add(it.city);
  });

  return { provinces, cities };
}

function cascadeGeoOptions() {
  const { provinces, cities } = computeGeoOptions();

  ddProvince.setValues(provinces);
  ddCity.setValues(cities);

  state.selectedProvinces = new Set([...state.selectedProvinces].filter(v => provinces.has(v)));
  state.selectedCities = new Set([...state.selectedCities].filter(v => cities.has(v)));

  ddProvince.setSelected([...state.selectedProvinces], { silent: true });
  ddCity.setSelected([...state.selectedCities], { silent: true });

  recomputeDerivedRegions();
  ddRegion.setSelected([...effectiveRegions()], { silent: true });
  ddProvince.refresh();
}

function rebuildFilters() {
  const cats = new Set(), statuses = new Set(), services = new Set(), groups = new Set(), regions = new Set(), provinces = new Set(), cities = new Set();

  state.items.forEach(it => {
    if (it.category) cats.add(it.category);
    if (it.status) statuses.add(it.status);
    if (it.group) groups.add(it.group);
    if (it.region) regions.add(it.region);
    if (it.province) provinces.add(it.province);
    if (it.city) cities.add(it.city);
    it.services.forEach(s => services.add(s));
  });

  buildSingleSelect(els.category, cats, "Tutte");
  ddStatus.setValues(statuses);
  ddService.setValues(services);
  ddRegion.setValues(regions);
  ddProvince.setValues(provinces);
  ddCity.setValues(cities);
  ddGroup.setValues(groups);

  state.selectedGroups.clear();
  state.selectedStatuses.clear();
  state.selectedServices.clear();
  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();
  state.groupsTouched = false;

  [ddGroup, ddStatus, ddRegion, ddProvince, ddCity].forEach(dd => dd.setSelected([], { silent: true }));
  cascadeGeoOptions();
}

function passesNonGroupFilters(it) {
  const cat = els.category.value;
  if (cat && it.category !== cat) return false;
  if (state.selectedStatuses.size && !state.selectedStatuses.has(it.status)) return false;
  if (effectiveRegions().size && !effectiveRegions().has(it.region)) return false;
  if (state.selectedProvinces.size && !state.selectedProvinces.has(it.province)) return false;
  if (state.selectedCities.size && !state.selectedCities.has(it.city)) return false;
  if (state.selectedServices.size && ![...state.selectedServices].some(s => it.services.includes(s))) return false;
  return true;
}

function syncGroups() {
  const hasOtherFilters =
    !!els.category.value ||
    state.selectedStatuses.size ||
    state.selectedServices.size ||
    effectiveRegions().size ||
    state.selectedProvinces.size ||
    state.selectedCities.size;

  const available = uniqSorted(state.items.filter(passesNonGroupFilters).map(it => it.group));
  ddGroup.setValues(available);

  if (!state.groupsTouched) {
    const next = hasOtherFilters ? available : [];
    state.selectedGroups = new Set(next);
    ddGroup.setSelected(next, { silent: true });
    return;
  }

  const kept = available.filter(v => state.selectedGroups.has(v));
  state.selectedGroups = new Set(kept);
  ddGroup.setSelected(kept, { silent: true });
}

function applyFilters() {
  cluster.clearLayers();
  state.visibleItems = [];

  state.items.forEach(it => {
    if (!passesNonGroupFilters(it)) return;
    if (state.selectedGroups.size && !state.selectedGroups.has(it.group)) return;
    cluster.addLayer(it.marker);
    state.visibleItems.push(it);
  });

  els.kpiVisible.textContent = state.visibleItems.length.toLocaleString("it-IT");
}

function buildSingleSelect(select, values, allLabel = "Tutte") {
  const current = select.value;
  const sorted = uniqSorted(values);
  select.innerHTML = `<option value="">${allLabel}</option>` + sorted.map(v => `<option value="${v}">${v}</option>`).join("");
  if (sorted.includes(current)) select.value = current;
}

function refreshUIAfterFilterChange({ sync = true } = {}) {
  if (sync) syncGroups();
  applyFilters();
  refreshNearbyListIfPossible();
}

function resetNearbyUI() {
  els.nearbyCount.textContent = "0";
  els.nearbyList.innerHTML = `<div class="nearby-empty">Cerca un indirizzo per vedere gli esercenti più vicini.</div>`;
}

function resetAll() {
  els.category.value = "";
  [ddGroup, ddStatus, ddService, ddRegion, ddProvince, ddCity].forEach(dd => dd.clear({ silent: true }));

  state.selectedGroups.clear();
  state.selectedStatuses.clear();
  state.selectedServices.clear();
  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();
  state.groupsTouched = false;
  state.lastSearchLat = null;
  state.lastSearchLon = null;

  resetNearbyUI();
  clearSearchResults();
  clearSearchMarker();
  els.address.value = "";
  setStatus("");
  state.lastAutocompleteQuery = "";
  state.searchCache.clear();

  rebuildFilters();
  if (state.initialBounds) map.fitBounds(state.initialBounds);
  refreshUIAfterFilterChange();
}

/* =========================
   8) PHOTON SEARCH
========================= */

function buildPhotonPrimary(props) {
  return [props.name || props.street || "Risultato", props.housenumber || ""].filter(Boolean).join(" ");
}

function buildPhotonSecondary(props) {
  const city = props.city || props.town || props.village || props.county || "";
  return [props.street || "", props.postcode || "", city].filter(Boolean).join(", ");
}

function mapPhotonFeatureToItem(feature) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry?.coordinates || [];

  return {
    lat: Number(lat),
    lon: Number(lon),
    display_name: [
      [p.name || p.street || "", p.housenumber || ""].filter(Boolean).join(" "),
      p.postcode,
      p.city,
      p.state,
      p.country
    ].filter(Boolean).join(", "),
    address: {
      road: p.street || "",
      house_number: p.housenumber || "",
      postcode: p.postcode || "",
      city: p.city || p.locality || p.county || "",
      county: p.county || "",
      state: p.state || "",
      country: p.country || "Italia"
    }
  };
}

async function fetchAddresses(query, limit = CONFIG.searchLimit) {
  const q = normalizeQuery(query);
  const key = cacheKey(q, limit);

  if (state.searchCache.has(key)) return state.searchCache.get(key);

  state.searchAbortController?.abort();
  state.searchAbortController = new AbortController();

  const url = new URL("https://photon.komoot.io/api");
  url.searchParams.set("q", `${q} Italia`);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: state.searchAbortController.signal
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Errore Photon: ${res.status} ${txt}`);
  }

  const data = await res.json();
  const results = (Array.isArray(data.features) ? data.features : []).filter(f =>
    String(f?.properties?.countrycode || "").toUpperCase() === "IT"
  );

  state.searchCache.set(key, results);
  return results;
}

function renderAddressResults(results) {
  els.results.innerHTML = "";
  const seen = new Set();

  state.currentResults = (results || []).filter(feature => {
    const p = feature.properties || {};
    const key = [p.name, p.street, p.housenumber, p.postcode, p.city, p.state].map(v => norm(v)).join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!state.currentResults.length) {
    els.results.innerHTML = `<li class="result-empty">Nessun risultato trovato in Italia</li>`;
    showSearchResults();
    return;
  }

  state.currentResults.forEach((feature, index) => {
    const p = feature.properties || {};
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("data-index", String(index));
    li.innerHTML = `
      <span class="result-title">${escapeHtml(buildPhotonPrimary(p))}</span>
      <span class="result-subtitle">${escapeHtml(buildPhotonSecondary(p) || "Italia")}</span>
    `;
    li.addEventListener("mouseenter", () => setActiveResult(index));
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseAddressResult(index);
    });
    els.results.appendChild(li);
  });

  showSearchResults();
  setActiveResult(0);
}

function findProvinceCodeByName(provinceName, regionName = "") {
  const provinceNorm = norm(provinceName);
  const regionNorm = norm(regionName);
  if (!provinceNorm || !window.PROVINCE_INFO) return "";

  for (const [code, info] of Object.entries(window.PROVINCE_INFO)) {
    if (norm(info.name) === provinceNorm && (!regionNorm || norm(info.region) === regionNorm)) {
      return code;
    }
  }
  return "";
}

function applyAddressToFiltersSafely(item) {
  const a = item.address || {};
  const rawCounty = String(a.county || a.province || "").trim();
  const provinceName = rawCounty
    .replace(/^Provincia di\s+/i, "")
    .replace(/^Città Metropolitana di\s+/i, "")
    .trim();

  const provinceCode = findProvinceCodeByName(provinceName, a.state || "");
  if (!provinceCode) return false;

  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();

  const region = provinceRegionOf(provinceCode);
  if (region) state.manualRegions.add(region);
  state.selectedProvinces.add(provinceCode);

  recomputeDerivedRegions();
  ddRegion.setSelected([...effectiveRegions()], { silent: true });
  cascadeGeoOptions();
  ddProvince.setSelected([...state.selectedProvinces], { silent: true });
  ddCity.setSelected([], { silent: true });

  refreshUIAfterFilterChange();
  return true;
}

function chooseDirectAddress(item) {
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return setStatus("Coordinate non valide.", true);

  els.address.value = item.display_name;
  clearSearchResults();
  setSearchMarker(lat, lon, item.display_name);

  state.lastSearchLat = lat;
  state.lastSearchLon = lon;

  const applied = applyAddressToFiltersSafely(item);
  renderNearbyLocations(lat, lon);
  setStatus(applied ? "Indirizzo trovato e filtri aggiornati." : "Indirizzo trovato.");
}

function chooseAddressResult(index) {
  const feature = state.currentResults[index];
  if (!feature) return;
  chooseDirectAddress(mapPhotonFeatureToItem(feature));
}

async function searchAddress() {
  const query = els.address.value.trim();
  if (!query) {
    clearSearchResults();
    return setStatus("Inserisci un indirizzo.", true);
  }

  setStatus("Ricerca in corso...");
  try {
    const results = await fetchAddresses(query, CONFIG.searchLimit);
    if (!results.length) {
      clearSearchResults();
      return setStatus("Nessun indirizzo trovato in Italia.", true);
    }
    chooseDirectAddress(mapPhotonFeatureToItem(results[0]));
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(error);
    setStatus(error.message || "Errore durante la ricerca.", true);
  }
}

/* =========================
   9) NEARBY
========================= */

function getNearbyLocations(lat, lon, radiusKm) {
  return state.visibleItems
    .map(item => ({ item, distanceKm: haversineKm(lat, lon, item.lat, item.lng) }))
    .filter(x => x.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function renderNearbyLocations(lat, lon) {
  const radiusKm = Number(els.nearbyRadius.value || CONFIG.nearbyDefaultKm);
  const results = getNearbyLocations(lat, lon, radiusKm);

  els.nearbyCount.textContent = String(results.length);

  if (!results.length) {
    els.nearbyList.innerHTML = `<div class="nearby-empty">Nessun esercente trovato entro ${radiusKm} km.</div>`;
    return;
  }

  els.nearbyList.innerHTML = results.map(({ item, distanceKm }, index) => {
    const p = item.feature.properties || {};
    return `
      <div class="nearby-item" data-nearby-index="${index}">
        <div class="nearby-name">${escapeHtml(p.name || "Esercente")}</div>
        <div class="nearby-meta">
          ${p.establishment_category ? `<div><strong>Categoria:</strong> ${escapeHtml(p.establishment_category)}</div>` : ""}
          ${p.status ? `<div><strong>Status:</strong> ${escapeHtml(p.status)}</div>` : ""}
          <div><strong>Gruppo:</strong> ${escapeHtml(groupValue(p))}</div>
          ${p.address_city ? `<div><strong>Città:</strong> ${escapeHtml(p.address_city)}</div>` : ""}
        </div>
        <span class="nearby-distance">${distanceKm.toFixed(2)} km</span>
      </div>
    `;
  }).join("");

  els.nearbyList.querySelectorAll(".nearby-item").forEach((node, index) => {
    node.addEventListener("click", () => {
      const result = results[index];
      if (!result) return;
      const ll = result.item.marker.getLatLng();
      map.setView(ll, 17);
      result.item.marker.openPopup();
    });
  });
}

function refreshNearbyListIfPossible() {
  if (Number.isFinite(state.lastSearchLat) && Number.isFinite(state.lastSearchLon)) {
    renderNearbyLocations(state.lastSearchLat, state.lastSearchLon);
  }
}

/* =========================
   10) DROPDOWNS
========================= */

const ddGroup = createCheckboxDropdown(els.ddGroup, {
  placeholder: "Tutti i gruppi",
  onChange: (arr) => {
    state.groupsTouched = true;
    state.selectedGroups = new Set(arr);
    refreshUIAfterFilterChange({ sync: false });
  }
});

const ddStatus = createCheckboxDropdown(els.ddStatus, {
  placeholder: "Tutti gli status",
  onChange: (arr) => {
    state.selectedStatuses = new Set(arr);
    refreshUIAfterFilterChange();
  }
});

const ddService = createCheckboxDropdown(els.ddService, {
  placeholder: "Tutti i servizi",
  onChange: (arr) => {
    state.selectedServices = new Set(arr);
    refreshUIAfterFilterChange();
  }
});

const ddRegion = createCheckboxDropdown(els.ddRegion, {
  placeholder: "Tutte le regioni",
  onChange: (arr) => {
    state.manualRegions = new Set(arr);

    if (hasManualScope()) {
      state.selectedProvinces = new Set([...state.selectedProvinces].filter(code => state.manualRegions.has(provinceRegionOf(code))));
      state.selectedCities = new Set([...state.selectedCities].filter(city =>
        state.items.some(it => it.city === city && it.region && state.manualRegions.has(it.region))
      ));
    }

    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });
    cascadeGeoOptions();
    refreshUIAfterFilterChange();
  }
});

const ddProvince = createCheckboxDropdown(els.ddProvince, {
  placeholder: "Tutte le province",
  renderLabel: provinceLabelOf,
  onOpen: () => ddProvince.refresh(),
  onChange: (arr) => {
    state.selectedProvinces = new Set(arr);
    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });
    cascadeGeoOptions();
    refreshUIAfterFilterChange();
  }
});

const ddCity = createCheckboxDropdown(els.ddCity, {
  placeholder: "Tutte le città",
  onChange: (arr) => {
    state.selectedCities = new Set(arr);
    recomputeDerivedRegions();
    ddRegion.setSelected([...effectiveRegions()], { silent: true });
    cascadeGeoOptions();
    refreshUIAfterFilterChange();
  }
});

/* =========================
   11) INIT
========================= */

async function init() {
  const res = await fetch(CONFIG.geojsonUrl, { cache: "no-store" });
  if (!res.ok) throw new Error("Impossibile caricare locations.geojson");

  const geojson = await res.json();
  state.geojson = geojson;
  els.kpiTotal.textContent = geojson.features.length.toLocaleString("it-IT");

  state.items = geojson.features.map((feature) => {
    const p = feature.properties || {};
    p.address_city = normalizeCityName(p.address_city || "");

    const province = provinceCodeOf(p);
    const region = provinceRegionOf(province);
    const city = p.address_city || "";
    const group = groupValue(p);
    const category = p.establishment_category || "";
    const status = String(p.status || "").trim();
    const services = String(p.services || "").split(",").map(s => s.trim()).filter(Boolean);
    const [lng, lat] = feature.geometry.coordinates;
    const marker = L.marker([lat, lng]).bindPopup(popupHtml(p));

    return { feature, marker, lat, lng, city, province, region, group, category, status, services };
  });

  const bounds = L.latLngBounds(state.items.map(x => x.marker.getLatLng())).pad(0.08);
  state.initialBounds = bounds;
  map.fitBounds(bounds);

  rebuildFilters();
  refreshUIAfterFilterChange();
  resetNearbyUI();
}

/* =========================
   12) EVENTS
========================= */

els.category.addEventListener("change", () => refreshUIAfterFilterChange());
els.reset.addEventListener("click", (e) => { e.preventDefault(); resetAll(); });

els.searchBtn.addEventListener("click", () => {
  clearTimeout(state.debounceTimer);
  state.lastAutocompleteQuery = "";
  searchAddress();
});

els.nearbyRadius.addEventListener("change", refreshNearbyListIfPossible);

els.address.addEventListener("input", () => {
  const query = els.address.value.trim();
  const normalized = normalizeQuery(query);

  clearTimeout(state.debounceTimer);

  if (normalized.length < CONFIG.searchMinChars) {
    clearSearchResults();
    state.lastAutocompleteQuery = "";
    return setStatus(`Scrivi almeno ${CONFIG.searchMinChars} caratteri.`);
  }

  if (normalized === state.lastAutocompleteQuery) return;
  setStatus("Attendo una pausa di scrittura...");

  state.debounceTimer = setTimeout(async () => {
    if (normalized === state.lastAutocompleteQuery) return;
    state.lastAutocompleteQuery = normalized;

    try {
      const results = await fetchAddresses(normalized, CONFIG.searchLimit);
      renderAddressResults(results);
      setStatus(results.length ? `${results.length} suggerimento/i trovati.` : "Nessun risultato trovato in Italia.");
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error(error);
      clearSearchResults();
      setStatus(error.message || "Errore durante l'autocomplete.", true);
    }
  }, CONFIG.searchDebounceMs);
});

els.address.addEventListener("keydown", (e) => {
  const hasResults = state.currentResults.length > 0;

  if (e.key === "ArrowDown" && hasResults) {
    e.preventDefault();
    return setActiveResult(Math.min(state.activeIndex + 1, state.currentResults.length - 1));
  }

  if (e.key === "ArrowUp" && hasResults) {
    e.preventDefault();
    return setActiveResult(Math.max(state.activeIndex - 1, 0));
  }

  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(state.debounceTimer);
    state.lastAutocompleteQuery = "";
    return hasResults && state.activeIndex >= 0 ? chooseAddressResult(state.activeIndex) : searchAddress();
  }

  if (e.key === "Escape") {
    e.preventDefault();
    clearSearchResults();
  }
});

document.addEventListener("mousedown", (e) => {
  if (!els.searchWrap.contains(e.target)) clearSearchResults();
});

map.on("click", clearSearchResults);

/* =========================
   13) BOOT
========================= */

init().catch((err) => {
  console.error(err);
  alert("Errore inizializzazione mappa. Controlla console e locations.geojson.");
});
