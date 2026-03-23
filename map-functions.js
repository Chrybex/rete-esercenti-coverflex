const map = L.map("map", {
  scrollWheelZoom: true,
  preferCanvas: true
});

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false
    });
    cluster.addTo(map);

let searchMarker = null;
let debounceTimer = null;
let activeIndex = -1;
let currentResults = [];
let lastRequestId = 0;

const MIN_CHARS_FOR_AUTOCOMPLETE = 6;
const AUTOCOMPLETE_DEBOUNCE_MS = 900;
const AUTOCOMPLETE_LIMIT = 5;
const DIRECT_SEARCH_LIMIT = 5;

let autocompleteAbortController = null;
let lastAutocompleteQuery = "";
const autocompleteCache = new Map();

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
};

    const norm = (s) => (s ?? "").toString().trim().toLowerCase();

function normalizeSearchQuery(query) {
  return String(query || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildAutocompleteCacheKey(query, limit) {
  return `${normalizeSearchQuery(query)}|${limit}`;
}

function normalizeCityName(name) {
  const s = (name ?? "").toString().trim().toLowerCase();
  if (!s) return "";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
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
      if (!it.city || !state.selectedCities.has(it.city)) continue;
      if (it.region) d.add(it.region);
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
     const cat = p.establishment_category
  ? `<div><strong>Categoria:</strong> ${esc(p.establishment_category)}</div>`
  : "";
const status = p.status
  ? `<div><strong>Status:</strong> ${esc(p.status)}</div>`
  : "";
const services = p.services
  ? `<div><strong>Servizi:</strong> ${esc(p.services)}</div>`
  : "";
      const addrParts = [
        p.address_line_1,
        p.address_zipcode,
        p.address_city,
        p.address_district
      ].filter(Boolean);
      const address = addrParts.length
        ? `<div><strong>Indirizzo:</strong> ${esc(addrParts.join(", "))}</div>`
        : "";
      const group = `<div><strong>Gruppo:</strong> ${esc(groupValue(p))}</div>`;
      const hubspot = p.hubspot_id
        ? `<div style="color:#64748b;font-size:12px;margin-top:6px;">HubSpot id: ${esc(p.hubspot_id)}</div>`
        : "";

      return `
        <div style="min-width:240px">
          <div style="font-weight:800;margin-bottom:6px;">${name}</div>
          ${cat}
          ${status}
          ${services}
          ${address}
          ${group}
          ${hubspot}
        </div>
      `;
    }

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
          return `
            <label class="dd-item">
              <input type="checkbox" value="${String(v).replaceAll('"', '&quot;')}" ${checked} />
              <span>${labelOf(v)}</span>
            </label>
          `;
        }).join("");

        list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.addEventListener("change", (e) => {
            const v = e.target.value;
            if (e.target.checked) selected.add(v);
            else selected.delete(v);
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
          opts.onChange([...selected]);
        });
      });

      return {
        setValues(vs) {
          values = [...new Set(vs)].filter(Boolean).sort((a, b) => a.localeCompare(b, "it"));
          for (const v of [...selected]) {
            if (!values.includes(v)) selected.delete(v);
          }
          updateHead();
          render();
        },
        setSelected(arr, { silent = false } = {}) {
          selected.clear();
          (arr || []).forEach(v => v && selected.add(v));
          for (const v of [...selected]) {
            if (!values.includes(v)) selected.delete(v);
          }
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

    const ddGroup = createCheckboxDropdown(els.ddGroup, {
      placeholder: "Tutti i gruppi",
      onChange: (arr) => {
        state.groupsTouched = true;
        state.selectedGroups = new Set(arr);
        applyFilters();
       refreshNearbyListIfPossible();
      },
    });

const ddStatus = createCheckboxDropdown(els.ddStatus, {
  placeholder: "Tutti gli status",
  onChange: (arr) => {
    state.selectedStatuses = new Set(arr);
    syncGroups();
    applyFilters();
    refreshNearbyListIfPossible();
  },
});

    const ddService = createCheckboxDropdown(els.ddService, {
      placeholder: "Tutti i servizi",
      onChange: (arr) => {
        state.selectedServices = new Set(arr);
        syncGroups();
        applyFilters();
       refreshNearbyListIfPossible();
      },
    });

    const ddRegion = createCheckboxDropdown(els.ddRegion, {
      placeholder: "Tutte le regioni",
      onChange: (arr) => {
        state.manualRegions = new Set(arr);

        if (hasManualScope()) {
          for (const code of [...state.selectedProvinces]) {
            const reg = provRegion(code);
            if (reg && !state.manualRegions.has(reg)) {
              state.selectedProvinces.delete(code);
            }
          }

  for (const c of [...state.selectedCities]) {
  let ok = false;
  for (const it of state.items) {
    if (it.city !== c) continue;
    if (it.region && state.manualRegions.has(it.region)) {
      ok = true;
      break;
    }
  }
  if (!ok) state.selectedCities.delete(c);
}
        }

        recomputeDerivedRegions();
        ddRegion.setSelected([...effectiveRegions()], { silent: true });
        cascadeGeoOptions();
        syncGroups();
        applyFilters();
       refreshNearbyListIfPossible();
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
       refreshNearbyListIfPossible();
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
       refreshNearbyListIfPossible();
      },
    });

    function buildSingleSelect(select, values, allLabel = "Tutte") {
      const current = select.value;
      const sorted = [...values]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "it"));

      select.innerHTML =
        `<option value="">${allLabel}</option>` +
        sorted.map(v => `<option value="${v}">${v}</option>`).join("");

      if (sorted.includes(current)) select.value = current;
    }

function computeGeoOptions() {
  const provinces = new Set();
  const cities = new Set();

  for (const it of state.items) {
    if (!inManualScope(it.region)) continue;

    if (it.province) provinces.add(it.province);
    if (it.city) cities.add(it.city);
  }

  return { provinces, cities };
}

    function cascadeGeoOptions() {
      const { provinces, cities } = computeGeoOptions();

      ddProvince.setValues(provinces);
      ddCity.setValues(cities);

      if (hasManualScope()) {
        state.selectedProvinces = new Set(
          [...state.selectedProvinces].filter(p => provinces.has(p))
        );
        ddProvince.setSelected([...state.selectedProvinces], { silent: true });

        state.selectedCities = new Set(
          [...state.selectedCities].filter(c => cities.has(c))
        );
        ddCity.setSelected([...state.selectedCities], { silent: true });

        recomputeDerivedRegions();
        ddRegion.setSelected([...effectiveRegions()], { silent: true });
      } else {
        ddProvince.setSelected([...state.selectedProvinces], { silent: true });
        ddCity.setSelected([...state.selectedCities], { silent: true });
      }

      ddProvince.refresh();
    }

function rebuildFilters() {
  const cats = new Set();
  const statuses = new Set();
  const services = new Set();
  const groups = new Set();
  const regionsAll = new Set();
  const provincesAll = new Set();
  const citiesAll = new Set();

  for (const it of state.items) {
    if (it.category) cats.add(it.category);
    if (it.status) statuses.add(it.status);
    if (it.group) groups.add(it.group);
    if (it.region) regionsAll.add(it.region);
    if (it.province) provincesAll.add(it.province);
    if (it.city) citiesAll.add(it.city);

    it.services.forEach(s => services.add(s));
  }

  buildSingleSelect(els.category, cats, "Tutte");
  ddStatus.setValues(statuses);
  ddService.setValues(services);
  ddRegion.setValues(regionsAll);
  ddProvince.setValues(provincesAll);
  ddCity.setValues(citiesAll);
  ddGroup.setValues(groups);

  ddGroup.setSelected([], { silent: true });
  ddStatus.setSelected([], { silent: true });
  ddRegion.setSelected([], { silent: true });
  ddProvince.setSelected([], { silent: true });
  ddCity.setSelected([], { silent: true });

  state.selectedStatuses.clear();
  state.selectedServices.clear();
  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();
  state.selectedGroups.clear();
  state.groupsTouched = false;

  cascadeGeoOptions();
}

function passesNonGroupFilters(it) {
  const cat = els.category.value;
  const statusesSel = [...state.selectedStatuses];
  const regionsSel = [...effectiveRegions()];
  const provincesSel = [...state.selectedProvinces];
  const citiesSel = [...state.selectedCities];
  const servicesSel = [...state.selectedServices];

  if (cat && it.category !== cat) return false;
  if (statusesSel.length > 0 && !statusesSel.includes(it.status)) return false;
  if (regionsSel.length > 0 && !regionsSel.includes(it.region)) return false;
  if (provincesSel.length > 0 && !provincesSel.includes(it.province)) return false;
  if (citiesSel.length > 0 && !citiesSel.includes(it.city)) return false;

  if (servicesSel.length > 0) {
    if (!servicesSel.some(s => it.services.includes(s))) return false;
  }

  return true;
}
function syncGroups() {
  if (!state.items.length) return;

  const cat = els.category.value;
  const hasNonGroup =
  !!cat ||
  state.selectedStatuses.size > 0 ||
  state.selectedServices.size > 0 ||
  effectiveRegions().size > 0 ||
  state.selectedProvinces.size > 0 ||
  state.selectedCities.size > 0;

  const available = new Set();

  for (const it of state.items) {
    if (!passesNonGroupFilters(it)) continue;
    available.add(it.group);
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
  state.visibleItems = [];

  for (const it of state.items) {
    if (!passesNonGroupFilters(it)) continue;
    if (state.selectedGroups.size > 0 && !state.selectedGroups.has(it.group)) continue;

    cluster.addLayer(it.marker);
    state.visibleItems.push(it);
    visible += 1;
  }

  els.kpiVisible.textContent = visible.toLocaleString("it-IT");
}

    function resetAll() {
      els.category.value = "";

      ddGroup.clear({ silent: true });
      ddStatus.clear({ silent: true });
      ddService.clear({ silent: true });
      ddRegion.clear({ silent: true });
      ddProvince.clear({ silent: true });
      ddCity.clear({ silent: true });

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
els.nearbyCount.textContent = "0";
els.nearbyList.innerHTML = `
  <div class="nearby-empty">
    Cerca un indirizzo per vedere gli esercenti più vicini.
  </div>
`;

     clearSearchResults();
clearSearchMarker();
els.address.value = "";
setStatus("");

lastAutocompleteQuery = "";
autocompleteCache.clear();

      if (state.geojson?.features) rebuildFilters();
      if (state.initialBounds) map.fitBounds(state.initialBounds);

      syncGroups();
      applyFilters();
     refreshNearbyListIfPossible();
    }

    function setStatus(text) {
      els.status.textContent = text || "";
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function showSearchResults() {
      const visible = els.results.children.length > 0;
      els.results.style.display = visible ? "block" : "none";
      els.address.setAttribute("aria-expanded", visible ? "true" : "false");
    }

    function clearSearchResults() {
      currentResults = [];
      activeIndex = -1;
      els.results.innerHTML = "";
      els.results.style.display = "none";
      els.address.setAttribute("aria-expanded", "false");
    }

    function setActiveResult(index) {
      activeIndex = index;

      const items = els.results.querySelectorAll("li[data-index]");
      items.forEach((item, i) => {
        item.classList.toggle("active", i === activeIndex);
      });

      const activeItem = items[activeIndex];
      if (activeItem) {
        const top = activeItem.offsetTop;
        const bottom = top + activeItem.offsetHeight;

        if (top < els.results.scrollTop) {
          els.results.scrollTop = top;
        } else if (bottom > els.results.scrollTop + els.results.clientHeight) {
          els.results.scrollTop = bottom - els.results.clientHeight;
        }
      }
    }

    function clearSearchMarker() {
      if (searchMarker) {
        map.removeLayer(searchMarker);
        searchMarker = null;
      }
    }

function setSearchMarker(lat, lon, label) {

  clearSearchMarker();

  searchMarker = L.circleMarker([lat, lon], {
    radius: 10,
    color: "#b91c1c",       // bordo
    weight: 3,
    fillColor: "#ef4444",   // interno
    fillOpacity: 0.95
  }).addTo(map);

  map.setView([lat, lon], 16);

  if (label) {
    searchMarker.bindPopup(label).openPopup();
  }
}

function buildPrimary(item) {
  const address = item.address || {};
  const road = address.road || "";
  const number = address.house_number || "";
  const city = address.city || "";

  if (road && number) return `${road} ${number}`;
  if (road) return road;
  if (city) return city;
  return item.display_name || "Risultato";
}

    function buildSecondary(item) {
      const address = item.address || {};
      const parts = [
        address.postcode,
        address.city || address.town || address.village || address.hamlet,
        address.county,
        address.state,
        address.country
      ].filter(Boolean);

      return parts.join(", ");
    }

    function renderAddressResults(results) {
  els.results.innerHTML = "";

  const seen = new Set();
  currentResults = (results || []).filter((item) => {
    const key = String(item.display_name || "").trim().toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

      if (!results.length) {
        els.results.innerHTML = `<li class="result-empty">Nessun risultato trovato in Italia</li>`;
        showSearchResults();
        return;
      }

      results.forEach((item, index) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("data-index", String(index));

        const primary = buildPrimary(item);
        const secondary = buildSecondary(item);

        li.innerHTML = `
          <span class="result-title">${escapeHtml(primary)}</span>
          <span class="result-subtitle">${escapeHtml(secondary || item.display_name || "")}</span>
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

function chooseAddressResult(index) {
  const item = currentResults[index];
  if (!item) return;
  chooseDirectAddress(item);
}

function findProvinceCodeByName(provinceName, regionName = "") {
  const provinceNorm = norm(provinceName);
  const regionNorm = norm(regionName);

  if (!provinceNorm || !window.PROVINCE_INFO) return "";

  for (const [code, info] of Object.entries(window.PROVINCE_INFO)) {
    const infoName = norm(info.name || "");
    const infoRegion = norm(info.region || "");

    if (infoName === provinceNorm) {
      if (!regionNorm || infoRegion === regionNorm) {
        return code;
      }
    }
  }

  return "";
}

function applyAddressToFilters(item) {
  const a = item.address || {};

  const region = (a.state || "").trim();

  const rawCounty = (a.county || a.province || "").trim();
  const provinceName = rawCounty
    .replace(/^Provincia di\s+/i, "")
    .replace(/^Città Metropolitana di\s+/i, "")
    .trim();

  const provinceCode = findProvinceCodeByName(provinceName, region);

  state.manualRegions.clear();
  state.derivedRegions.clear();
  state.selectedProvinces.clear();
  state.selectedCities.clear();

  if (region) state.manualRegions.add(region);
  if (provinceCode) state.selectedProvinces.add(provinceCode);

  recomputeDerivedRegions();

  ddRegion.setSelected([...effectiveRegions()], { silent: true });
  cascadeGeoOptions();

  ddProvince.setSelected([...state.selectedProvinces], { silent: true });
  ddCity.setSelected([], { silent: true });

  syncGroups();
  applyFilters();
 refreshNearbyListIfPossible();
}

   function chooseDirectAddress(item) {
  const lat = parseFloat(item.lat);
  const lon = parseFloat(item.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setStatus("Coordinate non valide.");
    return;
  }

  els.address.value = item.display_name;
  clearSearchResults();
  setSearchMarker(lat, lon, item.display_name);

  state.lastSearchLat = lat;
  state.lastSearchLon = lon;

  applyAddressToFilters(item);
  renderNearbyLocations(lat, lon);

  setStatus("Indirizzo trovato.");
}

async function fetchAddresses(query, limit = AUTOCOMPLETE_LIMIT) {
  const normalizedQuery = normalizeSearchQuery(query);
  const cacheKey = buildAutocompleteCacheKey(normalizedQuery, limit);

  if (autocompleteCache.has(cacheKey)) {
    return autocompleteCache.get(cacheKey);
  }

  if (autocompleteAbortController) {
    autocompleteAbortController.abort();
  }

  autocompleteAbortController = new AbortController();

  const url = new URL("https://photon.komoot.io/api");
  url.searchParams.set("q", normalizedQuery + " Italia");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("lang", "en");

  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json"
    },
    signal: autocompleteAbortController.signal
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error("Errore Photon: " + response.status + " " + txt);
  }

  const data = await response.json();
  const features = Array.isArray(data.features) ? data.features : [];

  const italianResults = features
    .filter((feature) => {
      const p = feature.properties || {};
      return String(p.countrycode || "").toUpperCase() === "IT";
    })
    .map((feature) => {
      const p = feature.properties || {};
      const coords = (feature.geometry && feature.geometry.coordinates) || [];
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      return {
        lat,
        lon,
        display_name: [
          p.name,
          p.street,
          p.housenumber,
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
    })
    .filter(Boolean);

  autocompleteCache.set(cacheKey, italianResults);
  return italianResults;
}

    async function searchAddress() {
      const query = els.address.value.trim();

      if (!query) {
        setStatus("Inserisci un indirizzo.");
        clearSearchResults();
        return;
      }

      setStatus("Ricerca in corso...");

      try {
const results = await fetchAddresses(query, DIRECT_SEARCH_LIMIT);
        
        if (!results.length) {
          setStatus("Nessun indirizzo trovato in Italia.");
          clearSearchResults();
          return;
        }

        chooseDirectAddress(results[0]);
      } catch (error) {
        console.error(error);
        setStatus("Errore durante la ricerca.");
      }
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

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getNearbyLocations(lat, lon, radiusKm) {
  return (state.visibleItems || [])
    .map((it) => {
      const distanceKm = haversineKm(lat, lon, it.lat, it.lng);

      return {
        item: it,
        distanceKm
      };
    })
    .filter((x) => x.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function refreshNearbyListIfPossible() {
  if (
    Number.isFinite(state.lastSearchLat) &&
    Number.isFinite(state.lastSearchLon)
  ) {
    renderNearbyLocations(state.lastSearchLat, state.lastSearchLon);
  }
}

function renderNearbyLocations(lat, lon) {
  const radiusKm = Number(els.nearbyRadius.value || 5);
  const results = getNearbyLocations(lat, lon, radiusKm);

  els.nearbyCount.textContent = results.length;

  if (!results.length) {
    els.nearbyList.innerHTML = `
      <div class="nearby-empty">
        Nessun esercente trovato entro ${radiusKm} km.
      </div>
    `;
    return;
  }
 
 
  els.nearbyList.innerHTML = results.map(({ item, distanceKm }, index) => {
    const p = item.feature.properties || {};
    const name = escapeHtml(p.name || "Esercente");
    const group = escapeHtml(groupValue(p));
    const city = escapeHtml(p.address_city || "");
    const category = escapeHtml(p.establishment_category || "");
    const status = escapeHtml(p.status || "");

    return `
      <div class="nearby-item" data-nearby-index="${index}">
        <div class="nearby-name">${name}</div>
       <div class="nearby-meta">
  ${category ? `<div><strong>Categoria:</strong> ${category}</div>` : ""}
  ${status ? `<div><strong>Status:</strong> ${status}</div>` : ""}
  <div><strong>Gruppo:</strong> ${group}</div>
  ${city ? `<div><strong>Città:</strong> ${city}</div>` : ""}
</div>
        <span class="nearby-distance">${distanceKm.toFixed(2)} km</span>
      </div>
    `;
  }).join("");

  const nodes = els.nearbyList.querySelectorAll(".nearby-item");
  nodes.forEach((node, index) => {
    node.addEventListener("click", () => {
      const result = results[index];
      if (!result) return;

      const marker = result.item.marker;
      const ll = marker.getLatLng();

      map.setView(ll, 17);
      marker.openPopup();
    });
  });
}

    async function init() {
      const res = await fetch("./converted-leaflet-status-refixed.geojson", { cache: "no-store" });
      if (!res.ok) throw new Error("Impossibile caricare locations.geojson");

      const geojson = await res.json();
      state.geojson = geojson;

      els.kpiTotal.textContent = geojson.features.length.toLocaleString("it-IT");

state.items = geojson.features.map((f) => {
  const p = f.properties || {};

  p.address_city = normalizeCityName(p.address_city || "");

  const province = (p.address_district || "").toUpperCase().trim();
  const region = window.PROVINCE_INFO?.[province]?.region || "";
  const city = p.address_city || "";
  const group = (p.group_name || "").toString().trim() || "Indipendenti";
  const category = p.establishment_category || "";
  const status = (p.status || "").toString().trim();
  const services = (p.services || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

  const [lng, lat] = f.geometry.coordinates;

  const marker = L.marker([lat, lng]).bindPopup(popupHtml(p));

  return {
  feature: f,
  marker,
  lat,
  lng,
  city,
  province,
  region,
  group,
  category,
  status,
  services
};
});

      const bounds = L.latLngBounds(state.items.map(x => x.marker.getLatLng())).pad(0.08);
      state.initialBounds = bounds;
      map.fitBounds(bounds);

      rebuildFilters();
      syncGroups();
      applyFilters();
     refreshNearbyListIfPossible();
    }

    els.category.addEventListener("change", () => {
      syncGroups();
      applyFilters();
     refreshNearbyListIfPossible();
    });

    els.reset.addEventListener("click", (e) => {
      e.preventDefault();
      resetAll();
    });

   els.searchBtn.addEventListener("click", () => {
  clearTimeout(debounceTimer);
  lastAutocompleteQuery = "";
  searchAddress();
});
els.nearbyRadius.addEventListener("change", () => {
  if (
    Number.isFinite(state.lastSearchLat) &&
    Number.isFinite(state.lastSearchLon)
  ) {
    renderNearbyLocations(state.lastSearchLat, state.lastSearchLon);
  }
});

els.address.addEventListener("input", () => {
  const query = els.address.value.trim();
  const normalizedQuery = normalizeSearchQuery(query);

  clearTimeout(debounceTimer);

  if (normalizedQuery.length < MIN_CHARS_FOR_AUTOCOMPLETE) {
    clearSearchResults();
    setStatus("Scrivi almeno " + MIN_CHARS_FOR_AUTOCOMPLETE + " caratteri.");
    lastAutocompleteQuery = "";
    return;
  }

  if (normalizedQuery === lastAutocompleteQuery) {
    return;
  }

  setStatus("Attendo una pausa di scrittura...");

  debounceTimer = setTimeout(async () => {
    if (normalizedQuery === lastAutocompleteQuery) {
      return;
    }

    lastAutocompleteQuery = normalizedQuery;
    const requestId = ++lastRequestId;

    try {
      const results = await fetchAddresses(normalizedQuery, AUTOCOMPLETE_LIMIT);

      if (requestId !== lastRequestId) return;

      renderAddressResults(results);
      setStatus(
        results.length
          ? results.length + " suggerimento/i trovati."
          : "Nessun risultato trovato in Italia."
      );
    } catch (error) {
      if (error.name === "AbortError") return;

      console.error(error);

      if (requestId !== lastRequestId) return;

      clearSearchResults();
      setStatus(error.message || "Errore durante l'autocomplete.");
    }
  }, AUTOCOMPLETE_DEBOUNCE_MS);
});

    els.address.addEventListener("keydown", (e) => {
      const hasResults = currentResults.length > 0;

      if (e.key === "ArrowDown" && hasResults) {
        e.preventDefault();
        setActiveResult(Math.min(activeIndex + 1, currentResults.length - 1));
      } else if (e.key === "ArrowUp" && hasResults) {
        e.preventDefault();
        setActiveResult(Math.max(activeIndex - 1, 0));
      } else if (e.key === "Enter") {
  e.preventDefault();
  clearTimeout(debounceTimer);
  lastAutocompleteQuery = "";

  if (hasResults && activeIndex >= 0) {
    chooseAddressResult(activeIndex);
  } else {
    searchAddress();
  }
} else if (e.key === "Escape") {
        e.preventDefault();
        clearSearchResults();
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (!els.searchWrap.contains(e.target)) {
        clearSearchResults();
      }
    });

    map.on("click", () => {
      clearSearchResults();
    });

    init().catch((err) => {
      console.error(err);
      alert("Errore inizializzazione mappa. Controlla console e locations.geojson.");
    });
