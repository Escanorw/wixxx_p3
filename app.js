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

// Form's photo question is a Drive file-upload: the sheet cell holds a
// share URL like https://drive.google.com/file/d/<id>/view or
// .../open?id=<id>, never a raw image URL. Convert to Drive's thumbnail
// endpoint, which serves the actual bytes for a file shared "anyone with
// link" (Forms grants that automatically for uploads). If parsing fails
// or the link isn't a Drive one, fall back to the raw value — isSafePhotoUrl
// + the <img onerror> initials fallback still apply downstream, so a bad
// link degrades to initials rather than a broken pipeline.
function driveThumbnail(raw) {
  if (!raw) return "";
  const first = raw.split(/[,\n]/)[0].trim();
  const m = first.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || first.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w400`;
  return first;
}

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

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

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

function avatarHtml(name, photo) {
  const label = initials(name) || "?";
  if (photo && isSafePhotoUrl(photo)) {
    // onerror swaps in the initials fallback if the image fails to load
    // (broken link, hotlink block, etc.) — never leave a broken-image icon.
    return `<img class="avatar" src="${escapeAttr(photo)}" alt="" loading="lazy" ` +
      `onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar avatar-fallback',textContent:'${escapeAttr(label)}'}))">`;
  }
  return `<div class="avatar avatar-fallback">${escapeHtml(label)}</div>`;
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

  rows.forEach(row => {
    const name = pick(row, "nom");
    const bucque = pick(row, "bucque");
    const numss = pick(row, "num");
    const phone = pick(row, "blairal");
    const photoRaw = pick(row, "photo");
    const gpsRaw = pick(row, "gps", "coordon", "localisation");
    const activity = pick(row, "fais-je", "fais je");
    const message = pick(row, "autres infos", "partager");

    if (!name) return;
    const coords = parseGps(gpsRaw);
    if (!coords) { skipped++; return; }
    const photo = driveThumbnail(photoRaw);

    // Group markers at the same rounded spot (~100m) so co-located
    // profiles fan out instead of stacking exactly on top of each other.
    const key = coords[0].toFixed(3) + "," + coords[1].toFixed(3);
    const idx = posIndex[key] || 0;
    posIndex[key] = idx + 1;
    const [lat, lon] = jitter(coords[0], coords[1], idx);

    const marker = L.marker([lat, lon], { icon: pinIcon });
    marker.bindPopup(`
      <div class="card">
        <div class="card-head">
          ${avatarHtml(name, photo)}
          <h3>${escapeHtml(name)}</h3>
        </div>
        ${bucque || numss ? `<div class="meta"><div>${escapeHtml([bucque, numss].filter(Boolean).join(" · "))}</div></div>` : ""}
        ${activity || phone ? `<div class="meta">
          ${activity ? `<div class="loc">${escapeHtml(activity)}</div>` : ""}
          ${phone ? `<div><a href="tel:${escapeAttr(phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(phone)}</a></div>` : ""}
        </div>` : ""}
        ${message ? `<hr><div class="story">${escapeHtml(message)}</div>` : ""}
      </div>
    `);
    clusterGroup.addLayer(marker);
    placed++;
  });

  const skippedLabel = skipped > 0 ? ` · ${skipped} ignoré${skipped === 1 ? "" : "s"} (coordonnées invalides)` : "";
  statsEl.innerHTML = `<strong>${placed}</strong> étudiant${placed === 1 ? "" : "s"} localisé${placed === 1 ? "" : "s"}${skippedLabel}`;
  setStatus(`Dernière mise à jour : ${new Date().toLocaleTimeString("fr-FR")}`);
}

loadData();
setInterval(loadData, REFRESH_MS);
