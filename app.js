// ==== CONFIG ====
// Published CSV of the "Carte" tab (QUERY over the raw responses, dropping
// Horodateur/Bucque/Num'sss) — NOT the raw Form Responses tab, which would
// leak more than intended. See spreadsheet for the QUERY formula.
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJHH_0qxY9O2iFszBBv74sxoLHmXbi09dxkWoN4JfLC0eG_00Mzch3QCQkbUKN-Req3GBFwDrQb7KJ/pub?gid=2011989133&single=true&output=csv";

const REFRESH_MS = 5 * 60 * 1000; // re-fetch every 5 min while page stays open

function pick(row, ...keywords) {
  const keys = Object.keys(row);
  for (const kw of keywords) {
    const hit = keys.find(k => k.toLowerCase().includes(kw));
    if (hit && row[hit] && row[hit].trim()) return row[hit].trim();
  }
  return "";
}

function jitter(lat, lon, index) {
  if (index === 0) return [lat, lon];
  const angle = index * 2.399963; // golden angle spread
  // 0.35° (~35km) was sized for country-centroid jitter in the old
  // country-name pipeline. GPS input is building-precision, so co-located
  // pins now need a street-scale spread instead — ~15m per sqrt(index)
  // step, enough to separate individual pins once zoomed to street level
  // while staying visually "the same spot" at any zoom the cluster group
  // would show a bubble anyway.
  const radius = 0.00015 * Math.sqrt(index);
  return [lat + radius * Math.cos(angle), lon + radius * Math.sin(angle)];
}

// The form asks for GPS coords pasted from a Google Maps long-press
// ("48.858370, 2.294481"), enforced by a regex validator on the form itself.
// Free-text country names were dropped entirely — matching them against
// countries.js was the fragile link in the old pipeline (typos, aliases,
// missing entries silently drop a profile). Strict decimal lat,lon has no
// such ambiguity: it either parses or it doesn't, and we surface the count
// of ones that didn't instead of hiding them in the total.
function parseGps(str) {
  if (!str) return null;
  const m = str.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

// Phone numbers come in as local French format ("07 57 67 48 66"); wa.me
// needs digits-only international format. Assumes a French number (Blairal
// is a French phone field) — a leading 0 becomes 33, anything already
// starting with a country code (33, +33 already stripped) passes through.
function waLink(phone) {
  let digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = "33" + digits.slice(1);
  return `https://wa.me/${digits}`;
}

// Form's photo question is a Drive file-upload: the sheet cell holds a
// share URL like https://drive.google.com/file/d/<id>/view or
// .../open?id=<id>, never a raw image URL. Convert to Drive's thumbnail
// endpoint, which serves the actual bytes for a file shared "anyone with
// link" (Forms grants that automatically for uploads). If parsing fails
// or the link isn't a Drive one, fall back to the raw value — isSafePhotoUrl
// + the <img onerror> initials fallback still apply downstream, so a bad
// link degrades to initials rather than a broken pipeline.
function driveThumbnail(raw, sz) {
  if (!raw) return "";
  const first = raw.split(/[,\n]/)[0].trim();
  const m = first.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || first.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w${sz || 400}`;
  return first;
}

// Lightbox: click a popup avatar to see the full-size photo. Global (not
// module-scoped) because the img's onclick is inlined into popup HTML
// strings built as plain text — there's no other handle to attach a
// listener to once Leaflet injects that markup into the DOM.
window.openLightbox = function (url) {
  const box = document.getElementById("lightbox");
  const img = document.getElementById("lightbox-img");
  img.src = url;
  box.classList.add("open");
};
window.closeLightbox = function () {
  document.getElementById("lightbox").classList.remove("open");
  document.getElementById("lightbox-img").src = "";
};
document.addEventListener("keydown", e => {
  if (e.key === "Escape") window.closeLightbox();
});

const map = L.map("map", { worldCopyJump: true, minZoom: 2 }).setView([20, 10], 2);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const clusterGroup = L.markerClusterGroup({
  iconCreateFunction: cluster => L.divIcon({
    html: `<div class="marker-cluster-custom" style="width:${34 + Math.min(cluster.getChildCount(),20)}px;height:${34 + Math.min(cluster.getChildCount(),20)}px">${cluster.getChildCount()}</div>`,
    className: "",
    iconSize: null,
  }),
});
map.addLayer(clusterGroup);

const pinIcon = L.divIcon({ className: "", html: '<div class="pin-icon"></div>', iconSize: [14, 14] });

const ICON_BRIEFCASE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`;
const ICON_PHONE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`;
const ICON_WHATSAPP = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.47 14.38c-.29-.15-1.73-.85-2-.95-.27-.1-.46-.15-.66.15-.2.29-.76.94-.93 1.14-.17.19-.34.22-.63.07-.29-.15-1.23-.45-2.34-1.44-.86-.77-1.45-1.72-1.62-2.01-.17-.29-.02-.45.13-.6.13-.13.29-.34.44-.51.15-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.15-.66-1.6-.91-2.18-.24-.58-.48-.5-.66-.5h-.56c-.19 0-.5.07-.76.36-.26.29-1 .98-1 2.38s1.02 2.76 1.16 2.95c.15.19 2.02 3.08 4.89 4.32.68.29 1.22.47 1.63.6.68.22 1.31.19 1.8.11.55-.08 1.73-.7 1.97-1.39.24-.68.24-1.26.17-1.39-.07-.13-.26-.2-.55-.35z"></path><path d="M12.04 2C6.58 2 2.13 6.42 2.13 11.9c0 1.87.51 3.63 1.4 5.13L2 22l5.13-1.5a9.87 9.87 0 0 0 4.91 1.31h.01c5.46 0 9.9-4.42 9.9-9.9 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.02h-.01a8.15 8.15 0 0 1-4.15-1.14l-.3-.18-3.05.89.9-2.98-.19-.3a8.16 8.16 0 0 1-1.25-4.4c0-4.51 3.65-8.18 8.15-8.18a8.1 8.1 0 0 1 5.77 2.4 8.11 8.11 0 0 1 2.39 5.77c0 4.51-3.66 8.12-8.26 8.12z"></path></svg>`;
const ICON_PIN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const listEl = document.getElementById("list");
const toggleViewBtn = document.getElementById("toggleViewBtn");

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function escapeAttr(s) {
  // stricter than escapeHtml: also blocks backticks/parens so it's safe
  // inside an inline onerror="" handler string, not just an attribute value.
  return escapeHtml(s).replace(/`/g, "&#96;");
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}

function isSafePhotoUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function avatarHtml(name, photo, photoFull) {
  const label = initials(name) || "?";
  if (photo && isSafePhotoUrl(photo)) {
    // onerror swaps in the initials fallback if the image fails to load
    // (broken link, hotlink block, etc.) — never leave a broken-image icon.
    // stopPropagation: the click must not fall through to Leaflet's popup
    // container, which would otherwise treat it as a "click the map" close.
    return `<img class="avatar avatar-clickable" src="${escapeAttr(photo)}" alt="" loading="lazy" ` +
      `onclick="event.stopPropagation(); openLightbox('${escapeAttr(photoFull || photo)}')" ` +
      `onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar avatar-fallback',textContent:'${escapeAttr(label)}'}))">`;
  }
  return `<div class="avatar avatar-fallback">${escapeHtml(label)}</div>`;
}

// Shared by the map popup and the list card — same information, two
// different wrappers. Keeping one template means a field added to the form
// only needs a `pick()` line, not two markup copies to keep in sync.
function cardBodyHtml(p) {
  return `
    <div class="card-top">
      ${avatarHtml(p.name, p.photo, p.photoFull)}
      <div class="card-id">
        <h3>${escapeHtml(p.name)}</h3>
        ${p.bucque || p.numss ? `<div class="handle">${escapeHtml([p.bucque, p.numss].filter(Boolean).join(" · "))}</div>` : ""}
      </div>
    </div>
    ${p.activity ? `<div class="row">${ICON_BRIEFCASE}<span>${escapeHtml(p.activity)}</span></div>` : ""}
    ${p.phone ? `<div class="row">${ICON_PHONE}<a href="tel:${escapeAttr(p.phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(p.phone)}</a></div>` : ""}
    ${p.phone ? `<a class="wa-button" href="${escapeAttr(waLink(p.phone))}" target="_blank" rel="noopener">${ICON_WHATSAPP}Contacter sur WhatsApp</a>` : ""}
    ${p.message ? `<div class="story">${escapeHtml(p.message)}</div>` : ""}
    ${p.wordFor26 ? `<div class="word26"><span class="word26-label">Pour les .26</span>${escapeHtml(p.wordFor26)}</div>` : ""}
  `;
}

async function loadData() {
  if (!CSV_URL || CSV_URL.startsWith("REPLACE")) {
    setStatus("Aucune source de données configurée — modifiez CSV_URL dans app.js.", true);
    return;
  }
  setStatus("Chargement des données…");
  try {
    const res = await fetch(CSV_URL + (CSV_URL.includes("?") ? "&" : "?") + "cb=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    render(parsed.data);
  } catch (err) {
    setStatus("Échec du chargement : " + err.message + " (nouvelle tentative à venir)", true);
  }
}

function render(rows) {
  clusterGroup.clearLayers();
  const posIndex = {};
  let placed = 0;
  let skipped = 0;
  const people = [];

  rows.forEach(row => {
    const name = pick(row, "nom");
    const bucque = pick(row, "bucque");
    const numss = pick(row, "num");
    const phone = pick(row, "blairal");
    const photoRaw = pick(row, "photo");
    const gpsRaw = pick(row, "gps", "coordon", "localisation");
    const activity = pick(row, "fais-je", "fais je");
    const message = pick(row, "autres infos", "partager");
    const wordFor26 = pick(row, "petit mot", "mot pour");

    if (!name) return;
    const photo = driveThumbnail(photoRaw);
    const photoFull = driveThumbnail(photoRaw, 1600);
    const p = { name, bucque, numss, phone, photo, photoFull, activity, message, wordFor26, marker: null };

    const coords = parseGps(gpsRaw);
    if (!coords) {
      // No pin to place, but the profile still has info worth reading —
      // it goes in the list with no "voir sur la carte" action instead of
      // being dropped entirely.
      skipped++;
      people.push(p);
      return;
    }

    // Group markers at the same rounded spot (~100m) so co-located
    // profiles fan out instead of stacking exactly on top of each other.
    const key = coords[0].toFixed(3) + "," + coords[1].toFixed(3);
    const idx = posIndex[key] || 0;
    posIndex[key] = idx + 1;
    const [lat, lon] = jitter(coords[0], coords[1], idx);

    const marker = L.marker([lat, lon], { icon: pinIcon });
    marker.bindPopup(`<div class="card">${cardBodyHtml(p)}</div>`);
    clusterGroup.addLayer(marker);
    p.marker = marker;
    people.push(p);
    placed++;
  });

  people.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  renderList(people);

  const skippedLabel = skipped > 0 ? ` · ${skipped} ignoré${skipped === 1 ? "" : "s"} (coordonnées invalides)` : "";
  statsEl.innerHTML = `<strong>${placed}</strong> P3 localisé${placed === 1 ? "" : "s"}${skippedLabel}`;
  setStatus(`Dernière mise à jour : ${new Date().toLocaleTimeString("fr-FR")}`);
}

function renderList(people) {
  if (!people.length) {
    listEl.innerHTML = `<p class="list-empty">Aucun P3 à afficher pour l'instant.</p>`;
    return;
  }
  listEl.innerHTML = `<div class="list-grid">${people.map((p, i) => `
    <div class="list-card">
      ${cardBodyHtml(p)}
      ${p.marker
        ? `<button class="list-locate" type="button" data-index="${i}">${ICON_PIN}Voir sur la carte</button>`
        : `<div class="list-no-pin">${ICON_PIN}Localisation non fournie</div>`}
    </div>
  `).join("")}</div>`;

  listEl.querySelectorAll(".list-locate").forEach(btn => {
    btn.addEventListener("click", () => locateOnMap(people[Number(btn.dataset.index)]));
  });
}

// Jumping straight to marker.getLatLng() would leave the popup unopened
// inside its cluster bubble on a dense zoom level. zoomToShowLayer is
// Leaflet.markercluster's own "expand whatever cluster currently hides
// this marker, then hand it back" — the only reliable way to reach a
// specific pin's popup from outside the map.
function locateOnMap(p) {
  if (!p.marker) return;
  switchView("map");
  clusterGroup.zoomToShowLayer(p.marker, () => p.marker.openPopup());
}

function switchView(view) {
  const isList = view === "list";
  document.body.classList.toggle("view-list", isList);
  toggleViewBtn.textContent = isList ? "Voir la carte" : "Voir la liste";
  toggleViewBtn.setAttribute("aria-pressed", String(isList));
  if (!isList) {
    // #map was `display:none` while the list was open; Leaflet measured
    // its container at 0×0 back then and needs a nudge to pick up the
    // real size, or panning/zooming looks broken until the next resize.
    setTimeout(() => map.invalidateSize(), 50);
  }
}

toggleViewBtn.addEventListener("click", () => {
  switchView(document.body.classList.contains("view-list") ? "map" : "list");
});

loadData();
setInterval(loadData, REFRESH_MS);
