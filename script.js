/* NONMARIS - Phone GPS Monitor + Miniature Compass (Option A: magnetometer)
   Flow: Phone magnetometer heading + GPS -> bearing/turn computed HERE
         -> MQTT NAV topic -> ESP8266 -> Serial NAV,... -> Arduino Uno
   Arduino still keeps its own GPS/DEST calculation as a backup check.
*/
const $ = (id) => document.getElementById(id);
const DEVICE_ID = "7f3c91a8d2b64e0f";
const BASE = `phonegps/esp8266/${DEVICE_ID}`;
const LOCATION_TOPIC = `${BASE}/location`;
const DESTINATION_TOPIC = `${BASE}/destination`;
const STATUS_TOPIC = `${BASE}/status`;
const NAV_TOPIC = `${BASE}/nav`; // compass turn instruction (phone -> laptop + ESP8266)
const START_TOPIC = `${BASE}/start`; // starting point (phone -> laptop), retained

let mqttClient = null, watchId = null, map = null, phoneMarker = null, destMarker = null, accuracyCircle = null;
let currentLat = null, currentLon = null, currentAccuracy = null;
let destLat = null, destLon = null;
let compassHeading = null; // magnetometer, 0-360, 0=N
let compassSource = "—"; // "Magnetometer" | "GPS heading (fallback)"
let gpsHeading = null;
let lastNavSentAt = 0, sentCount = 0;
let compassListening = false;
let startLat = null, startLon = null, routeLine = null, startMarker = null;
let lastNavFromMQTT = null; // laptop mirrors this, never recomputes

// ---------- helpers ----------
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;
const norm180 = (a) => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };
const norm360 = (a) => ((a % 360) + 360) % 360;
function bearingTo(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return norm360(toDeg(Math.atan2(y, x)));
}
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function cardinal(angle) {
  const dirs = ["North","Northeast","East","Southeast","South","Southwest","West","Northwest"];
  return dirs[Math.round(norm360(angle)/45) % 8];
}
// Smooth heading so needle doesn't jitter: shortest-arc lerp
function smoothHeading(prev, next, alpha=0.25) {
  if (prev === null) return next;
  const diff = norm180(next - prev);
  return norm360(prev + diff * alpha);
}

// ---------- MQTT ----------
function connectMQTT() {
  // Public test broker over secure websocket (same as before)
  mqttClient = mqtt.connect("wss://broker.hivemq.com:8884/mqtt", { clientId: "web-" + Math.random().toString(16).slice(2,10), clean: true });
  mqttClient.on("connect", () => {
    if ($("mqttStatus")) $("mqttStatus").textContent = "Connected";
    if ($("brokerState")) $("brokerState").textContent = "Connected";
    mqttClient.subscribe([LOCATION_TOPIC, DESTINATION_TOPIC, STATUS_TOPIC, NAV_TOPIC, START_TOPIC]);
    const saved = loadDestination(); if (saved) publishDestinationMessage(saved.lat, saved.lon, false);
  });
  mqttClient.on("message", (topic, payload) => {
    if (topic === STATUS_TOPIC) {
      try { const s = JSON.parse(payload.toString());
        if ($("deviceState")) $("deviceState").textContent = s.online ? "Online" : "Offline";
        if ($("deviceUpdate")) $("deviceUpdate").textContent = new Date().toLocaleTimeString();
      } catch(e) {}
    }
    if (topic === LOCATION_TOPIC && watchId === null) {
      try { const gps = JSON.parse(payload.toString());
        if (Number.isFinite(Number(gps.latitude))) updatePosition(Number(gps.latitude), Number(gps.longitude), Number(gps.accuracy));
      } catch(e) {}
    }
    if (topic === DESTINATION_TOPIC) {
      if (payload.toString().length === 0) { clearDestinationLocal(); return; }
      try { const dd = JSON.parse(payload.toString());
        if (Number.isFinite(Number(dd.latitude))) { destLat = Number(dd.latitude); destLon = Number(dd.longitude); drawDestinationMarker(destLat, destLon); updateDestinationReadout();
          // If THIS device is the phone/robot and it just learned a destination set from the laptop,
          // lock its current position as the Start and broadcast it.
          if (watchId !== null && currentLat !== null && startLat === null) setStart(currentLat, currentLon, true);
          updateRoute(); updateCompass(); }
      } catch(e) {}
    }
    if (topic === START_TOPIC) {
      if (payload.toString().length === 0) { clearStartLocal(); return; }
      try { const s = JSON.parse(payload.toString());
        if (Number.isFinite(Number(s.latitude))) { startLat = Number(s.latitude); startLon = Number(s.longitude); saveStart(startLat, startLon); drawStartMarker(); updateRoute(); }
      } catch(e) {}
    }
    if (topic === NAV_TOPIC) {
      // LAPTOP / VIEWER ONLY: mirror the phone's compass exactly. Phone ignores its own echo.
      if (watchId !== null) return;
      try { const n = JSON.parse(payload.toString());
        if (Number.isFinite(Number(n.heading)) && Number.isFinite(Number(n.bearing))) { lastNavFromMQTT = n; renderCompass(n.heading, n.bearing, n.turn, n.distance, n.headingSource || "Phone magnetometer (via MQTT)"); }
      } catch(e) {}
    }
  });
}

// ---------- Compass: Option A magnetometer ----------
async function enableCompass() {
  try {
    // iOS 13+ needs explicit permission
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") { if ($("compassStatus")) $("compassStatus").textContent = "Compass: permission denied. Using GPS heading fallback."; return; }
    }
    if (compassListening) return;
    compassListening = true;
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    if ($("compassStatus")) $("compassStatus").textContent = "Compass: listening (magnetometer). Hold phone flat, top edge = facing direction.";
    if ($("compassBtn")) $("compassBtn").textContent = "Compass On ✓";
  } catch(e) { console.error(e); }
}
function onOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading; // iOS Safari: already 0=N, clockwise
  } else if (typeof e.alpha === "number" && e.absolute) {
    heading = norm360(360 - e.alpha); // Android absolute: alpha is CCW from north
  } else if (typeof e.alpha === "number") {
    heading = norm360(360 - e.alpha); // non-absolute fallback, still usable if calibrated
  }
  if (heading === null || !Number.isFinite(heading)) return;
  compassHeading = smoothHeading(compassHeading, heading);
  compassSource = "Magnetometer";
  updateCompass();
}
function effectiveHeading() {
  if (compassHeading !== null) return { heading: compassHeading, source: "Magnetometer" };
  if (gpsHeading !== null) return { heading: gpsHeading, source: "GPS heading (fallback)" };
  return { heading: null, source: "—" };
}

// ---------- Compass UI + NAV calculation + publish ----------
// One renderer used by BOTH devices. Phone calls it with locally computed values,
// laptop calls it with values received on NAV_TOPIC. Same numbers = same compass.
function fmtDist(m){ return m < 1000 ? `${m.toFixed(1)} m` : `${(m/1000).toFixed(2)} km`; }
function renderCompass(heading, bearing, turn, distance, source){
  if ($("headingReadout")) $("headingReadout").textContent = `${heading.toFixed(1)}°`;
  if ($("headingDir")) $("headingDir").textContent = cardinal(heading);
  if ($("turnSource")) $("turnSource").textContent = `Source: ${source}`;
  if ($("compassStatus")) $("compassStatus").textContent = `Compass: ${source} — ${heading.toFixed(1)}°`;
  const needle = $("headingNeedle"); if (needle) needle.style.transform = `rotate(${heading}deg)`;
  const aligned = Math.abs(turn) <= 5;
  if ($("bearingReadout")) $("bearingReadout").textContent = `${bearing.toFixed(1)}°`;
  if ($("bearingDir")) $("bearingDir").textContent = cardinal(bearing);
  if ($("turnReadout")) $("turnReadout").textContent = aligned ? "0° — ALIGNED" : `${turn > 0 ? "+" : ""}${turn.toFixed(1)}°`;
  if ($("turnDirection")) $("turnDirection").textContent = aligned ? "ALIGNED ✓" : (turn > 0 ? "TURN RIGHT →" : "← TURN LEFT");
  const destNeedle = $("destNeedle"); if (destNeedle) destNeedle.style.transform = `rotate(${norm360(bearing)}deg)`; // North-up: red = absolute bearing
  if ($("distanceToDest")) $("distanceToDest").textContent = fmtDist(distance);
  if ($("distanceToDest2")) $("distanceToDest2").textContent = fmtDist(distance);
  updateRouteDistances();
}
function updateCompass() {
  // VIEWER (laptop): never compute locally - it has no magnetometer. Wait for NAV from phone.
  if (watchId === null) {
    if ($("turnSource")) $("turnSource").textContent = "Source: Phone magnetometer (via MQTT) — waiting for NAV…";
    if (lastNavFromMQTT) renderCompass(lastNavFromMQTT.heading, lastNavFromMQTT.bearing, lastNavFromMQTT.turn, lastNavFromMQTT.distance, lastNavFromMQTT.headingSource || "Phone magnetometer (via MQTT)");
    return;
  }
  // SENDER (phone on robot): compute locally, render, publish for laptop + Arduino.
  const h = effectiveHeading();
  if (h.heading === null || currentLat === null || destLat === null) {
    if ($("headingReadout")) $("headingReadout").textContent = h.heading === null ? "—" : `${h.heading.toFixed(1)}°`;
    if ($("turnDirection")) $("turnDirection").textContent = "WAITING";
    return;
  }
  const bearing = bearingTo(currentLat, currentLon, destLat, destLon);
  const dist = haversineM(currentLat, currentLon, destLat, destLon);
  const turn = norm180(bearing - h.heading);
  renderCompass(h.heading, bearing, turn, dist, h.source);
  publishNav(bearing, h.heading, turn, dist, Math.abs(turn) <= 5, h.source);
}
function publishNav(bearing, heading, turn, distance, aligned, source) {
  if (!mqttClient || !mqttClient.connected) return;
  const now = Date.now();
  // Throttle: at most every 500ms, OR immediately if turn changed by >=2° / alignment flipped
  if (now - lastNavSentAt < 500 && Math.abs(turn - (publishNav._lastTurn ?? 999)) < 2) return;
  publishNav._lastTurn = turn; lastNavSentAt = now;
  const payload = JSON.stringify({ bearing: +bearing.toFixed(2), heading: +heading.toFixed(2), turn: +turn.toFixed(2), distance: +distance.toFixed(1), aligned, headingSource: source, timestamp: new Date().toISOString() });
  mqttClient.publish(NAV_TOPIC, payload, { retain: false });
  sentCount++; if ($("sentCount")) $("sentCount").textContent = String(sentCount);
  if ($("sendState")) $("sendState").textContent = `NAV sent: TURN ${turn > 0 ? "+" : ""}${turn.toFixed(1)}°`;
  if ($("navLastSent")) $("navLastSent").textContent = `${new Date().toLocaleTimeString()} — TURN ${turn > 0 ? "+" : ""}${turn.toFixed(1)}° (bearing ${bearing.toFixed(1)}°, heading ${heading.toFixed(1)}°)`;
}

// ---------- GPS ----------
function handlePosition(pos) {
  const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy;
  if (Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0) gpsHeading = pos.coords.heading;
  updatePosition(lat, lon, acc);
  if (mqttClient && mqttClient.connected) publishLocationData();
}
function updatePosition(lat, lon, acc) {
  currentLat = lat; currentLon = lon; currentAccuracy = acc;
  if ($("latitude")) $("latitude").textContent = lat.toFixed(7);
  if ($("longitude")) $("longitude").textContent = lon.toFixed(7);
  if ($("accuracy")) $("accuracy").textContent = `±${Number(acc).toFixed(1)} m`;
  if ($("lastUpdate")) $("lastUpdate").textContent = new Date().toLocaleTimeString();
  if ($("gpsStatus")) $("gpsStatus").textContent = "Receiving GPS from phone";
  updateMap(lat, lon, acc); addHistory(lat, lon, acc, new Date().toLocaleTimeString()); updateRouteDistances(); updateCompass();
}
function publishLocationData() {
  const h = effectiveHeading();
  const payload = JSON.stringify({ latitude: currentLat, longitude: currentLon, accuracy: currentAccuracy, heading: h.heading ?? 0, headingAbsolute: h.heading !== null, headingSource: h.source, timestamp: new Date().toISOString() });
  mqttClient.publish(LOCATION_TOPIC, payload); sentCount++; if ($("sentCount")) $("sentCount").textContent = String(sentCount);
}
function handleGPSError(e) {
  const msgs = { 1: "Location permission denied. Allow location access.", 2: "GPS location unavailable.", 3: "GPS request timed out. Try again." };
  if ($("gpsStatus")) $("gpsStatus").textContent = msgs[e.code] || "Unable to obtain GPS location.";
}
function startGPS() {
  if (!navigator.geolocation) return alert("Your browser does not support GPS location.");
  if (watchId !== null) return;
  if ($("gpsStatus")) $("gpsStatus").textContent = "Searching for GPS location...";
  watchId = navigator.geolocation.watchPosition(handlePosition, handleGPSError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 });
  if ($("startBtn")) $("startBtn").disabled = true; if ($("stopBtn")) $("stopBtn").disabled = false; if ($("roleLabel")) $("roleLabel").textContent = "Sender (phone on robot)";
  enableCompass(); // start compass together with GPS
}
function stopGPS() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if ($("gpsStatus")) $("gpsStatus").textContent = "GPS tracking is stopped.";
  if ($("startBtn")) $("startBtn").disabled = false; if ($("stopBtn")) $("stopBtn").disabled = true;
}


// ---------- Starting point + route line ----------
// Start = phone/robot position at the moment a destination is set (or Set Start pressed).
// It is published retained on START_TOPIC so laptop + phone show the SAME line.
function saveStart(lat, lon){ try{ localStorage.setItem("nonmaris_start", JSON.stringify({lat, lon})); }catch(e){} }
function loadStart(){ try{ const v = JSON.parse(localStorage.getItem("nonmaris_start")); if(v && Number.isFinite(v.lat)){ startLat=v.lat; startLon=v.lon; return v; } }catch(e){} return null; }
function setStart(lat, lon, publish=true){
  startLat = lat; startLon = lon; saveStart(lat, lon); drawStartMarker(); updateRoute();
  if (publish && mqttClient && mqttClient.connected) mqttClient.publish(START_TOPIC, JSON.stringify({latitude: lat, longitude: lon, timestamp: new Date().toISOString()}), {retain: true});
}
function clearStartLocal(){ startLat=null; startLon=null; try{ localStorage.removeItem("nonmaris_start"); }catch(e){} if(startMarker && map){ map.removeLayer(startMarker); startMarker=null; } if(routeLine && map){ map.removeLayer(routeLine); routeLine=null; } updateRouteDistances(); }
function clearDestinationLocal(){ destLat=null; destLon=null; try{ localStorage.removeItem("nonmaris_dest"); }catch(e){} if(destMarker && map){ map.removeLayer(destMarker); destMarker=null; } if($("destLat")) $("destLat").value=""; if($("destLon")) $("destLon").value=""; updateDestinationReadout(); clearStartLocal(); updateCompass(); }
function drawStartMarker(){
  if(!map || startLat===null) return;
  if(!startMarker) startMarker = L.marker([startLat, startLon], {icon: L.divIcon({className:"dest-icon", html:"🟢", iconSize:[24,24]})}).addTo(map).bindPopup("Start");
  else startMarker.setLatLng([startLat, startLon]);
}
function updateRoute(){
  if(!map) return;
  if(routeLine){ map.removeLayer(routeLine); routeLine=null; }
  if(startLat!==null && destLat!==null){
    routeLine = L.polyline([[startLat, startLon],[destLat, destLon]], {color:"#2563eb", weight:4, dashArray:"10,6", opacity:0.9}).addTo(map);
    routeLine.bindPopup("Planned route: Start → Destination");
  }
  updateRouteDistances();
}
function updateRouteDistances(){
  const totalEl=$("routeTotal"), remEl=$("routeRemaining"), covEl=$("routeCovered"), progEl=$("routeProgress");
  if(startLat===null || destLat===null){ if(totalEl) totalEl.textContent="—"; if(remEl) remEl.textContent="—"; if(covEl) covEl.textContent="—"; if(progEl) progEl.textContent="—"; return; }
  const total = haversineM(startLat, startLon, destLat, destLon);
  const remaining = (currentLat!==null) ? haversineM(currentLat, currentLon, destLat, destLon) : total;
  const covered = (currentLat!==null) ? haversineM(startLat, startLon, currentLat, currentLon) : 0;
  const progress = total > 0 ? Math.min(100, Math.max(0, (covered/total)*100)) : 0;
  if(totalEl) totalEl.textContent = fmtDist(total);
  if(remEl) remEl.textContent = fmtDist(remaining);
  if(covEl) covEl.textContent = fmtDist(covered);
  if(progEl) progEl.textContent = `${progress.toFixed(0)}%`;
}

// ---------- Destination ----------
function saveDestination(lat, lon) { try { localStorage.setItem("nonmaris_dest", JSON.stringify({ lat, lon })); } catch(e) {} }
function loadDestination() { try { const v = JSON.parse(localStorage.getItem("nonmaris_dest")); if (v && Number.isFinite(v.lat)) { destLat = v.lat; destLon = v.lon; return v; } } catch(e) {} return null; }
function updateDestinationReadout() { if ($("destReadout")) $("destReadout").textContent = destLat === null ? "—" : `${destLat.toFixed(7)}, ${destLon.toFixed(7)}`; }
function publishDestinationMessage(lat, lon, updateUI = true) {
  if (!mqttClient || !mqttClient.connected) return;
  mqttClient.publish(DESTINATION_TOPIC, JSON.stringify({ latitude: lat, longitude: lon, timestamp: new Date().toISOString() }), { retain: true });
}
function publishDestination(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return alert("Invalid coordinates.");
  destLat = lat; destLon = lon;
  if ($("destLat")) $("destLat").value = lat.toFixed(7); if ($("destLon")) $("destLon").value = lon.toFixed(7);
  drawDestinationMarker(lat, lon); updateDestinationReadout(); saveDestination(lat, lon); publishDestinationMessage(lat, lon);
  // Lock Start = robot's current position (only the phone knows it). Laptop setting a dest triggers this on the phone via MQTT handler.
  if (watchId !== null && currentLat !== null) setStart(currentLat, currentLon, true);
  updateRoute(); updateCompass();
}
function clearDestination() {
  clearStartLocal();
  destLat = null; destLon = null; try { localStorage.removeItem("nonmaris_dest"); } catch(e) {}
  if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
  if ($("destLat")) $("destLat").value = ""; if ($("destLon")) $("destLon").value = "";
  updateDestinationReadout(); updateCompass();
  if (mqttClient && mqttClient.connected) { mqttClient.publish(DESTINATION_TOPIC, "", { retain: true }); mqttClient.publish(START_TOPIC, "", { retain: true }); } // empty = cleared, ESP8266 forwards DEST,CLEAR
}

// ---------- Map / history ----------
function initMap() {
  map = L.map("map").setView([6.5244, 3.3792], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
  map.on("click", (e) => publishDestination(e.latlng.lat, e.latlng.lng));
}
function updateMap(lat, lon, acc) {
  if (!map) return;
  if (!phoneMarker) { phoneMarker = L.marker([lat, lon]).addTo(map); map.setView([lat, lon], 16); }
  else phoneMarker.setLatLng([lat, lon]);
  if (accuracyCircle) map.removeLayer(accuracyCircle);
  accuracyCircle = L.circle([lat, lon], { radius: acc || 10 }).addTo(map);
  if ($("openMap")) $("openMap").href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
}
function drawDestinationMarker(lat, lon) {
  if (!map) return;
  if (!destMarker) destMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "dest-icon", html: "🎯", iconSize: [24, 24] }) }).addTo(map);
  else destMarker.setLatLng([lat, lon]);
}
function addHistory(lat, lon, acc, time) {
  const tbody = $("history"); if (!tbody) return;
  const empty = tbody.querySelector(".empty"); if (empty) empty.parentElement.remove();
  const tr = document.createElement("tr"); tr.innerHTML = `<td>${time}</td><td>${lat.toFixed(7)}</td><td>${lon.toFixed(7)}</td><td>±${Number(acc).toFixed(1)} m</td>`;
  tbody.prepend(tr); while (tbody.children.length > 10) tbody.removeChild(tbody.lastChild);
}
document.addEventListener("DOMContentLoaded", () => {
  initMap(); connectMQTT(); const s = loadDestination(); if (s) { drawDestinationMarker(s.lat, s.lon); updateDestinationReadout(); } const st = loadStart(); if (st) { drawStartMarker(); updateRoute(); }
  $("startBtn")?.addEventListener("click", startGPS);
  $("stopBtn")?.addEventListener("click", stopGPS);
  $("compassBtn")?.addEventListener("click", enableCompass);
  $("setDestBtn")?.addEventListener("click", () => publishDestination(parseFloat($("destLat").value), parseFloat($("destLon").value)));
  $("clearDestBtn")?.addEventListener("click", clearDestination);
  $("setStartBtn")?.addEventListener("click", () => { if (watchId === null) return alert("Start is set by the phone on the robot — it knows its own position. Set the destination here, and the phone will lock Start automatically."); if (currentLat === null) return alert("No GPS yet on this phone."); setStart(currentLat, currentLon, true); });
  $("clearBtn")?.addEventListener("click", () => { if ($("history")) $("history").innerHTML = '<tr><td colspan="4" class="empty">No readings yet.</td></tr>'; });
  $("centerPhoneBtn")?.addEventListener("click", () => { if (map && currentLat !== null) map.setView([currentLat, currentLon], 16); });
  $("centerDestBtn")?.addEventListener("click", () => { if (map && destLat !== null) map.setView([destLat, destLon], 16); });
});
