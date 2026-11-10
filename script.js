// ==========================================
// PHONE GPS MONITOR - ESP8266
// ==========================================

// MQTT broker
const MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";

// MQTT topics
const LOCATION_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/location";

// NEW: destination topic (must match esp8266_gps.ino)
const DESTINATION_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/destination";

const STATUS_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/status";

// GPS variables
let watchId = null;
let mqttClient = null;
let marker = null;
let accuracyCircle = null;
let map = null;
let messageCount = 0;

// NEW: destination state
let destMarker = null;
let destLat = null;
let destLon = null;

// Helper function
function $(id) {
  return document.getElementById(id);
}

// ==========================================
// INITIALIZE MAP
// ==========================================

function initializeMap() {
  if (!$("map")) return;

  map = L.map("map").setView([6.5244, 3.3792], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // NEW: click on the map to set a destination
  map.on("click", (e) => {
    publishDestination(e.latlng.lat, e.latlng.lng);
  });
}

// ==========================================
// CONNECT TO MQTT
// ==========================================

function connectMQTT() {
  if (typeof mqtt === "undefined") {
    console.error("MQTT library not loaded.");
    return;
  }

  mqttClient = mqtt.connect(MQTT_BROKER);

  mqttClient.on("connect", () => {
    console.log("Connected to MQTT broker.");

    if ($("sendState")) {
      $("sendState").textContent = "MQTT Connected";
    }
    if ($("mqttStatus")) {
      $("mqttStatus").textContent = "Connected";
    }
    if ($("mqttDot")) {
      $("mqttDot").classList.add("online");
      $("mqttDot").classList.remove("offline");
    }

    // Subscribe to ESP8266 status and phone GPS
    mqttClient.subscribe(STATUS_TOPIC);
    mqttClient.subscribe(LOCATION_TOPIC);

    // NEW: if a destination was already saved, re-publish it
    const saved = loadSavedDestination();
    if (saved) {
      destLat = saved.latitude;
      destLon = saved.longitude;
      drawDestinationMarker(destLat, destLon);
      updateDestinationReadout();
      if ($("destLat")) $("destLat").value = destLat;
      if ($("destLon")) $("destLon").value = destLon;
      // Re-publish retained so the ESP8266 gets it after reconnect
      publishDestinationMessage(destLat, destLon);
    }
  });

  mqttClient.on("error", (error) => {
    console.error("MQTT error:", error);
    if ($("sendState")) {
      $("sendState").textContent = "MQTT connection error";
    }
  });

  mqttClient.on("offline", () => {
    if ($("sendState")) {
      $("sendState").textContent = "MQTT Offline";
    }
    if ($("mqttStatus")) $("mqttStatus").textContent = "Offline";
    if ($("mqttDot")) {
      $("mqttDot").classList.remove("online");
      $("mqttDot").classList.add("offline");
    }
  });

  // ========================================
  // RECEIVE MQTT MESSAGES
  // ========================================

  mqttClient.on("message", (topic, payload) => {

    if (topic === LOCATION_TOPIC) {
      if (watchId !== null) return;   // ignore our own echo

      try {
        const gps = JSON.parse(payload.toString());
        const lat = Number(gps.latitude);
        const lon = Number(gps.longitude);
        const accuracy = Number(gps.accuracy);

        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          !Number.isFinite(accuracy) ||
          lat < -90 || lat > 90 ||
          lon < -180 || lon > 180
        ) {
          console.warn("Invalid GPS coordinates:", gps);
          return;
        }

        const timestamp = gps.timestamp ? new Date(gps.timestamp) : new Date();
        const timeText = timestamp.toLocaleTimeString();

        $("latitude").textContent = lat.toFixed(7);
        $("longitude").textContent = lon.toFixed(7);
        $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;
        $("lastUpdate").textContent = timeText;

        if ($("gpsStatus")) $("gpsStatus").textContent = "Receiving GPS from phone";

        updateMap(lat, lon, accuracy);

        if ($("openMap")) {
          $("openMap").href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
        }

        addHistory(lat, lon, accuracy, timeText);

        if ($("sendState")) $("sendState").textContent = "GPS received from phone";

      } catch (error) {
        console.error("Error processing GPS message:", error);
      }
      return;
    }

    if (topic === STATUS_TOPIC) {
      try {
        const status = JSON.parse(payload.toString());
        if ($("deviceState")) {
          $("deviceState").textContent = status.online ? "Online" : "Offline";
        }
        if ($("deviceUpdate")) {
          $("deviceUpdate").textContent = new Date().toLocaleTimeString();
        }
      } catch (error) {
        console.error("Status message error:", error);
      }
    }
  });
}

// ==========================================
// NEW: DESTINATION HANDLING
// ==========================================

function publishDestination(lat, lon) {
  // Validate
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    alert("Invalid coordinates. Latitude must be –90…90 and longitude –180…180.");
    return;
  }

  destLat = lat;
  destLon = lon;

  // Update UI inputs
  if ($("destLat")) $("destLat").value = lat.toFixed(7);
  if ($("destLon")) $("destLon").value = lon.toFixed(7);

  // Draw the marker and update the readout
  drawDestinationMarker(lat, lon);
  updateDestinationReadout();

  // Persist across reloads
  saveDestination(lat, lon);

  // Publish to MQTT
  publishDestinationMessage(lat, lon);
}

function publishDestinationMessage(lat, lon) {
  if (!mqttClient || !mqttClient.connected) {
    if ($("sendState")) $("sendState").textContent = "MQTT not connected — destination saved locally";
    return;
  }

  const payload = JSON.stringify({
    latitude: lat,
    longitude: lon,
    timestamp: Date.now()
  });

  // retained: true, so the ESP8266 receives it after it (re)connects
  mqttClient.publish(DESTINATION_TOPIC, payload, { retain: true });

  if ($("sendState")) $("sendState").textContent = "Destination published";
}

function clearDestination() {
  destLat = null;
  destLon = null;

  if (destMarker) {
    map.removeLayer(destMarker);
    destMarker = null;
  }

  if ($("destLat")) $("destLat").value = "";
  if ($("destLon")) $("destLon").value = "";
  updateDestinationReadout();

  localStorage.removeItem("robotDest");

  // Publish an empty retained message to clear the ESP8266's stored value
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(DESTINATION_TOPIC, "", { retain: true });
  }
}

function drawDestinationMarker(lat, lon) {
  if (!map) return;

  const pos = [lat, lon];

  if (!destMarker) {
    destMarker = L.marker(pos, {
      // A red-tinted icon so it is distinct from the phone marker
      icon: L.divIcon({
        className: "dest-icon",
        html: "🎯",
        iconSize: [24, 24]
      })
    }).addTo(map).bindPopup("Destination waypoint");
  } else {
    destMarker.setLatLng(pos);
  }
}

function updateDestinationReadout() {
  if (!$("destReadout")) return;

  if (destLat === null || destLon === null) {
    $("destReadout").textContent = "—";
    return;
  }

  $("destReadout").textContent =
    `${destLat.toFixed(7)}, ${destLon.toFixed(7)}`;
}

function saveDestination(lat, lon) {
  try {
    localStorage.setItem("robotDest", JSON.stringify({
      latitude: lat,
      longitude: lon
    }));
  } catch (e) {
    console.warn("Could not save destination:", e);
  }
}

function loadSavedDestination() {
  try {
    const raw = localStorage.getItem("robotDest");
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) return d;
  } catch (e) {
    // ignore
  }
  return null;
}

// ==========================================
// UPDATE MAP
// ==========================================

function updateMap(lat, lon, accuracy) {
  if (!map) return;

  const position = [lat, lon];

  if (!marker) {
    marker = L.marker(position)
      .addTo(map)
      .bindPopup("Phone GPS Location");

    accuracyCircle = L.circle(position, {
      radius: accuracy,
      color: "#168fe5",
      fillOpacity: 0.10
    }).addTo(map);

    map.setView(position, 16);
  } else {
    marker.setLatLng(position);
    accuracyCircle.setLatLng(position);
    accuracyCircle.setRadius(accuracy);
  }
}

// ==========================================
// ADD GPS READING TO HISTORY
// ==========================================

function addHistory(lat, lon, accuracy, time) {
  const history = $("history");
  if (!history) return;

  // Remove the "no readings" placeholder on first insert
  const empty = history.querySelector(".empty");
  if (empty) history.removeChild(empty.parentElement);

  const row = document.createElement("tr");
  row.innerHTML =
    `<td>${time}</td>
     <td>${lat.toFixed(7)}</td>
     <td>${lon.toFixed(7)}</td>
     <td>±${accuracy.toFixed(1)} m</td>`;
  history.prepend(row);

  while (history.children.length > 10) {
    history.removeChild(history.lastChild);
  }
}

// ==========================================
// HANDLE PHONE GPS POSITION
// ==========================================

function handlePosition(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = position.coords.accuracy;
  const timestamp = Date.now();

  const gpsData = { latitude: lat, longitude: lon, accuracy, timestamp };

  $("latitude").textContent = lat.toFixed(7);
  $("longitude").textContent = lon.toFixed(7);
  $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;

  const timeText = new Date(timestamp).toLocaleTimeString();
  $("lastUpdate").textContent = timeText;

  if ($("gpsStatus")) $("gpsStatus").textContent = "GPS location acquired";

  updateMap(lat, lon, accuracy);

  if ($("openMap")) {
    $("openMap").href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
  }

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(LOCATION_TOPIC, JSON.stringify(gpsData));
    if ($("sendState")) $("sendState").textContent = "GPS coordinates sent";
    messageCount++;
    if ($("messageCount")) $("messageCount").textContent = messageCount;
  } else {
    if ($("sendState")) $("sendState").textContent = "Waiting for MQTT connection";
  }

  addHistory(lat, lon, accuracy, timeText);
}

// ==========================================
// GPS ERROR HANDLING
// ==========================================

function handleGPSError(error) {
  let message = "Unable to obtain GPS location.";
  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = "Location permission denied. Allow location access.";
      break;
    case error.POSITION_UNAVAILABLE:
      message = "GPS location unavailable.";
      break;
    case error.TIMEOUT:
      message = "GPS request timed out. Try again.";
      break;
  }
  if ($("gpsStatus")) $("gpsStatus").textContent = message;
  console.error(message);
}

// ==========================================
// START GPS
// ==========================================

function startGPS() {
  if (!navigator.geolocation) {
    alert("Your browser does not support GPS location.");
    return;
  }
  if (watchId !== null) return;

  if ($("gpsStatus")) $("gpsStatus").textContent = "Searching for GPS location...";

  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleGPSError,
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 }
  );
  if ($("startBtn")) $("startBtn").disabled = true;
  if ($("stopBtn"))  $("stopBtn").disabled  = false;
}

// ==========================================
// STOP GPS
// ==========================================

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if ($("gpsStatus")) $("gpsStatus").textContent = "GPS tracking stopped";
  if ($("sendState")) $("sendState").textContent = "GPS transmission stopped";
  if ($("startBtn")) $("startBtn").disabled = false;
  if ($("stopBtn"))  $("stopBtn").disabled  = true;
}

// ==========================================
// NEW: MANUAL DESTINATION ENTRY
// ==========================================

function submitTypedDestination() {
  const lat = Number($("destLat").value);
  const lon = Number($("destLon").value);
  publishDestination(lat, lon);
}

// ==========================================
// BUTTON EVENTS
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
  initializeMap();
  connectMQTT();

  // FIXED: use the actual button IDs from index.html
  if ($("startBtn")) $("startBtn").addEventListener("click", startGPS);
  if ($("stopBtn"))  $("stopBtn").addEventListener("click", stopGPS);

  // destination controls
  if ($("setDestBtn"))   $("setDestBtn").addEventListener("click", submitTypedDestination);
  if ($("clearDestBtn")) $("clearDestBtn").addEventListener("click", clearDestination);

  // Enter key in the inputs triggers Set Destination
  ["destLat", "destLon"].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitTypedDestination();
      });
    }
  });
});
