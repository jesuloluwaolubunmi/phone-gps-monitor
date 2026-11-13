
// ==========================================
// PHONE GPS MONITOR - ESP8266
// ==========================================

// MQTT broker
const MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";

// MQTT topics
const LOCATION_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/location";

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

// Destination state
let destMarker = null;
let destLat = null;
let destLon = null;

// Camera + route line
let lastPhonePos = null;
let routeLine = null;

// Phone compass state
let compassHeading = null;
let compassIsAbsolute = false;
let compassListening = false;
let lastGpsData = null;
let lastLocationPublishAt = 0;

// Helper function
function $(id) {
  return document.getElementById(id);
}

// ==========================================
// COMPASS DISPLAY + PHONE SENSOR
// ==========================================

function createCompassPanel() {
  if ($("compassPanel")) return;

  const panel = document.createElement("section");
  panel.id = "compassPanel";
  panel.style.cssText = [
    "margin:16px 0",
    "padding:16px",
    "border:1px solid #d7dee8",
    "border-radius:12px",
    "background:#ffffff",
    "color:#172033",
    "font-family:Arial,sans-serif",
    "box-shadow:0 2px 8px rgba(0,0,0,.06)"
  ].join(";");

  const title = document.createElement("h3");
  title.textContent = "NonMaris Phone Compass";
  title.style.cssText = "margin:0 0 10px;font-size:18px";

  const value = document.createElement("div");
  value.id = "compassHeading";
  value.textContent = "Waiting for compass…";
  value.style.cssText = "font-size:28px;font-weight:700;margin:8px 0";

  const direction = document.createElement("div");
  direction.id = "compassDirection";
  direction.textContent = "Direction: —";
  direction.style.cssText = "font-size:15px;margin:5px 0";

  const status = document.createElement("div");
  status.id = "compassStatus";
  status.textContent = "Tap Start Compass on the phone.";
  status.style.cssText = "font-size:13px;color:#526174;margin:8px 0";

  const button = document.createElement("button");
  button.id = "startCompassBtn";
  button.type = "button";
  button.textContent = "Start Compass";
  button.style.cssText =
    "padding:10px 16px;border:0;border-radius:8px;background:#1769aa;color:white;font-weight:600;cursor:pointer";

  panel.append(title, value, direction, status, button);

  const mapElement = $("map");

  if (mapElement && mapElement.parentNode) {
    mapElement.insertAdjacentElement("beforebegin", panel);
  } else {
    document.body.insertBefore(panel, document.body.firstChild);
  }

  button.addEventListener("click", startCompass);
}

function directionFromHeading(heading) {
  const directions = [
    "North",
    "Northeast",
    "East",
    "Southeast",
    "South",
    "Southwest",
    "West",
    "Northwest"
  ];

  return directions[Math.round(heading / 45) % 8];
}

function updateCompassDisplay(heading, isAbsolute) {
  if (!Number.isFinite(heading)) return;

  const normalized = ((heading % 360) + 360) % 360;

  if ($("compassHeading")) {
    $("compassHeading").textContent =
      `${normalized.toFixed(1)}°`;
  }

  if ($("compassDirection")) {
    $("compassDirection").textContent =
      `Direction: ${directionFromHeading(normalized)}`;
  }

  if ($("compassStatus")) {
    $("compassStatus").textContent = isAbsolute
      ? "Absolute heading received. Keep the phone level and check calibration."
      : "Relative orientation only — not safe to use as a compass heading.";
  }
}

function handleCompassOrientation(event, isAbsoluteEvent = false) {
  let heading = null;
  let absolute = false;

  // Some browsers expose a direct compass heading.
  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
    absolute = true;
  } else if (
    Number.isFinite(event.alpha) &&
    (event.absolute === true || isAbsoluteEvent)
  ) {
    // For a phone lying flat with its screen facing upward,
    // the top edge of the phone is the heading reference.
    heading = (360 - event.alpha) % 360;
    absolute = true;
  }

  if (!absolute || !Number.isFinite(heading)) {
    if ($("compassStatus")) {
      $("compassStatus").textContent =
        "No absolute compass reading available from this browser/device.";
    }
    return;
  }

  compassHeading = ((heading % 360) + 360) % 360;
  compassIsAbsolute = true;

  updateCompassDisplay(compassHeading, true);

  // Send the latest heading with the most recent GPS position.
  if (lastGpsData) {
    lastGpsData.heading = compassHeading;
    lastGpsData.headingAbsolute = true;
    publishLocationData(false);
  }
}

async function startCompass() {
  if (compassListening) return;

  if (!window.isSecureContext) {
    if ($("compassStatus")) {
      $("compassStatus").textContent =
        "Compass access requires an HTTPS website.";
    }
    return;
  }

  try {
    // iOS requires an explicit permission request.
    // Android Chrome generally does not expose this method.
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission =
        await DeviceOrientationEvent.requestPermission();

      if (permission !== "granted") {
        if ($("compassStatus")) {
          $("compassStatus").textContent =
            "Permission to access orientation was not granted.";
        }
        return;
      }
    }

    if (typeof DeviceOrientationEvent === "undefined") {
      if ($("compassStatus")) {
        $("compassStatus").textContent =
          "This browser does not support device orientation.";
      }
      return;
    }

    window.addEventListener(
      "deviceorientationabsolute",
      (event) => handleCompassOrientation(event, true),
      true
    );

    // Fallback is accepted only when the browser explicitly
    // marks the reading as absolute.
    window.addEventListener(
      "deviceorientation",
      (event) => {
        if (
          event.absolute === true ||
          Number.isFinite(event.webkitCompassHeading)
        ) {
          handleCompassOrientation(event, false);
        }
      },
      true
    );

    compassListening = true;

    if ($("compassStatus")) {
      $("compassStatus").textContent =
        "Listening for an absolute compass heading…";
    }

    if ($("startCompassBtn")) {
      $("startCompassBtn").textContent = "Compass Started";
      $("startCompassBtn").disabled = true;
    }

  } catch (error) {
    console.error("Compass permission/start error:", error);

    if ($("compassStatus")) {
      $("compassStatus").textContent =
        "Could not start compass: " + error.message;
    }
  }
}

function publishLocationData(force = false) {
  if (!lastGpsData || !mqttClient || !mqttClient.connected) return;

  const now = Date.now();

  if (!force && now - lastLocationPublishAt < 500) return;

  lastLocationPublishAt = now;
  lastGpsData.timestamp = now;

  mqttClient.publish(
    LOCATION_TOPIC,
    JSON.stringify(lastGpsData)
  );

  if ($("sendState")) {
    $("sendState").textContent = "GPS and compass data sent";
  }

  messageCount++;

  if ($("messageCount")) {
    $("messageCount").textContent = messageCount;
  }
}

// ==========================================
// INITIALIZE MAP
// ==========================================

function initializeMap() {
  if (!$("map")) return;

  map = L.map("map").setView([6.5244, 3.3792], 13);

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution: "&copy; OpenStreetMap contributors"
    }
  ).addTo(map);

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

    mqttClient.subscribe(STATUS_TOPIC);
    mqttClient.subscribe(LOCATION_TOPIC);

    const saved = loadSavedDestination();

    if (saved) {
      destLat = saved.latitude;
      destLon = saved.longitude;

      drawDestinationMarker(destLat, destLon);
      updateDestinationReadout();

      if ($("destLat")) $("destLat").value = destLat;
      if ($("destLon")) $("destLon").value = destLon;

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

    if ($("mqttStatus")) {
      $("mqttStatus").textContent = "Offline";
    }

    if ($("mqttDot")) {
      $("mqttDot").classList.remove("online");
      $("mqttDot").classList.add("offline");
    }
  });

  mqttClient.on("message", (topic, payload) => {

    if (topic === LOCATION_TOPIC) {
      if (watchId !== null) return;

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

        const timestamp = gps.timestamp
          ? new Date(gps.timestamp)
          : new Date();

        const timeText = timestamp.toLocaleTimeString();

        if (
          Number.isFinite(Number(gps.heading)) &&
          gps.headingAbsolute === true
        ) {
          updateCompassDisplay(Number(gps.heading), true);
        }

        $("latitude").textContent = lat.toFixed(7);
        $("longitude").textContent = lon.toFixed(7);
        $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;
        $("lastUpdate").textContent = timeText;

        if ($("gpsStatus")) {
          $("gpsStatus").textContent = "Receiving GPS from phone";
        }

        updateMap(lat, lon, accuracy);

        if ($("openMap")) {
          $("openMap").href =
            `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
        }

        addHistory(lat, lon, accuracy, timeText);

        if ($("sendState")) {
          $("sendState").textContent = "GPS received from phone";
        }

      } catch (error) {
        console.error("Error processing GPS message:", error);
      }

      return;
    }

    if (topic === STATUS_TOPIC) {
      try {
        const status = JSON.parse(payload.toString());

        if ($("deviceState")) {
          $("deviceState").textContent =
            status.online ? "Online" : "Offline";
        }

        if ($("deviceUpdate")) {
          $("deviceUpdate").textContent =
            new Date().toLocaleTimeString();
        }

      } catch (error) {
        console.error("Status message error:", error);
      }
    }
  });
}

// ==========================================
// DESTINATION HANDLING
// ==========================================

function publishDestination(lat, lon) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) {
    alert(
      "Invalid coordinates. Latitude must be –90…90 and longitude –180…180."
    );
    return;
  }

  destLat = lat;
  destLon = lon;

  if ($("destLat")) $("destLat").value = lat.toFixed(7);
  if ($("destLon")) $("destLon").value = lon.toFixed(7);

  drawDestinationMarker(lat, lon);
  updateDestinationReadout();

  saveDestination(lat, lon);

  publishDestinationMessage(lat, lon);
}

function publishDestinationMessage(lat, lon) {
  if (!mqttClient || !mqttClient.connected) {
    if ($("sendState")) {
      $("sendState").textContent =
        "MQTT not connected — destination saved locally";
    }
    return;
  }

  const payload = JSON.stringify({
    latitude: lat,
    longitude: lon,
    timestamp: Date.now()
  });

  mqttClient.publish(
    DESTINATION_TOPIC,
    payload,
    { retain: true }
  );

  if ($("sendState")) {
    $("sendState").textContent = "Destination published";
  }
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

  // Clear line and distance.
  updateRouteLine();

  localStorage.removeItem("robotDest");

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(DESTINATION_TOPIC, "", { retain: true });
  }
}

function drawDestinationMarker(lat, lon) {
  if (!map) return;

  const pos = [lat, lon];

  if (!destMarker) {
    destMarker = L.marker(pos, {
      icon: L.divIcon({
        className: "dest-icon",
        html: "🎯",
        iconSize: [24, 24]
      })
    }).addTo(map).bindPopup("Destination waypoint");

  } else {
    destMarker.setLatLng(pos);
  }

  updateRouteLine();
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
    localStorage.setItem(
      "robotDest",
      JSON.stringify({
        latitude: lat,
        longitude: lon
      })
    );

  } catch (e) {
    console.warn("Could not save destination:", e);
  }
}

function loadSavedDestination() {
  try {
    const raw = localStorage.getItem("robotDest");

    if (!raw) return null;

    const d = JSON.parse(raw);

    if (
      Number.isFinite(d.latitude) &&
      Number.isFinite(d.longitude)
    ) {
      return d;
    }

  } catch (e) {
    // Ignore storage errors.
  }

  return null;
}

// ==========================================
// UPDATE MAP
// ==========================================

function updateMap(lat, lon, accuracy) {
  if (!map) return;

  lastPhonePos = [lat, lon];

  const position = lastPhonePos;

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

  updateRouteLine();
}

// ==========================================
// ROUTE LINE + DISTANCE
// ==========================================

function haversineMeters(a, b) {
  const R = 6371000;

  const toRad = (d) => (d * Math.PI) / 180;

  const [lat1, lon1] = a;
  const [lat2, lon2] = b;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(s));
}

function formatDistance(m) {
  if (!Number.isFinite(m)) return "—";

  if (m >= 1000) {
    return `${(m / 1000).toFixed(2)} km`;
  }

  return `${m.toFixed(0)} m`;
}

function updateRouteLine() {
  if (!map) return;

  const havePhone = Array.isArray(lastPhonePos);

  const haveDest =
    destLat !== null && destLon !== null;

  if ($("distanceToDest")) {
    if (havePhone && haveDest) {
      const d = haversineMeters(
        lastPhonePos,
        [destLat, destLon]
      );

      $("distanceToDest").textContent = formatDistance(d);

    } else {
      $("distanceToDest").textContent = "—";
    }
  }

  if (havePhone && haveDest) {
    const points = [
      lastPhonePos,
      [destLat, destLon]
    ];

    if (!routeLine) {
      routeLine = L.polyline(points, {
        color: "#ff7070",
        weight: 3,
        opacity: 0.9,
        dashArray: "8 6"
      }).addTo(map);

    } else {
      routeLine.setLatLngs(points);
    }

  } else if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
}

// ==========================================
// CAMERA CONTROLS
// ==========================================

function centerOnPhone() {
  if (!map) return;

  if (!Array.isArray(lastPhonePos)) {
    alert("No phone position yet. Press Start GPS first.");
    return;
  }

  map.flyTo(
    lastPhonePos,
    Math.max(map.getZoom(), 16),
    { duration: 0.8 }
  );
}

function centerOnDestination() {
  if (!map) return;

  if (destLat === null || destLon === null) {
    alert(
      "No destination set. Type coordinates or click the map first."
    );
    return;
  }

  map.flyTo(
    [destLat, destLon],
    Math.max(map.getZoom(), 16),
    { duration: 0.8 }
  );
}

// ==========================================
// ADD GPS READING TO HISTORY
// ==========================================

function addHistory(lat, lon, accuracy, time) {
  const history = $("history");

  if (!history) return;

  const empty = history.querySelector(".empty");

  if (empty) {
    history.removeChild(empty.parentElement);
  }

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

  lastGpsData = {
    latitude: lat,
    longitude: lon,
    accuracy,
    heading: compassHeading,
    headingAbsolute: compassIsAbsolute,
    timestamp
  };

  $("latitude").textContent = lat.toFixed(7);
  $("longitude").textContent = lon.toFixed(7);
  $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;

  const timeText =
    new Date(timestamp).toLocaleTimeString();

  $("lastUpdate").textContent = timeText;

  if ($("gpsStatus")) {
    $("gpsStatus").textContent = "GPS location acquired";
  }

  updateMap(lat, lon, accuracy);

  if ($("openMap")) {
    $("openMap").href =
      `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
  }

  if (mqttClient && mqttClient.connected) {
    publishLocationData(true);

  } else {
    if ($("sendState")) {
      $("sendState").textContent =
        "Waiting for MQTT connection";
    }
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
      message =
        "Location permission denied. Allow location access.";
      break;

    case error.POSITION_UNAVAILABLE:
      message = "GPS location unavailable.";
      break;

    case error.TIMEOUT:
      message = "GPS request timed out. Try again.";
      break;
  }

  if ($("gpsStatus")) {
    $("gpsStatus").textContent = message;
  }

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

  if ($("gpsStatus")) {
    $("gpsStatus").textContent =
      "Searching for GPS location...";
  }

  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleGPSError,
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 2000
    }
  );

  if ($("startBtn")) {
    $("startBtn").disabled = true;
  }

  if ($("stopBtn")) {
    $("stopBtn").disabled = false;
  }
}

// ==========================================
// STOP GPS
// ==========================================

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  if ($("gpsStatus")) {
    $("gpsStatus").textContent = "GPS tracking stopped";
  }

  if ($("sendState")) {
    $("sendState").textContent =
      "GPS transmission stopped";
  }

  if ($("startBtn")) {
    $("startBtn").disabled = false;
  }

  if ($("stopBtn")) {
    $("stopBtn").disabled = true;
  }
}

// ==========================================
// MANUAL DESTINATION ENTRY
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
  createCompassPanel();
  connectMQTT();

  if ($("startBtn")) {
    $("startBtn").addEventListener("click", startGPS);
  }

  if ($("stopBtn")) {
    $("stopBtn").addEventListener("click", stopGPS);
  }

  if ($("setDestBtn")) {
    $("setDestBtn").addEventListener(
      "click",
      submitTypedDestination
    );
  }

  if ($("clearDestBtn")) {
    $("clearDestBtn").addEventListener(
      "click",
      clearDestination
    );
  }

  // Camera controls
  if ($("centerPhoneBtn")) {
    $("centerPhoneBtn").addEventListener(
      "click",
      centerOnPhone
    );
  }

  if ($("centerDestBtn")) {
    $("centerDestBtn").addEventListener(
      "click",
      centerOnDestination
    );
  }

  ["destLat", "destLon"].forEach(id => {
    const el = $(id);

    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          submitTypedDestination();
        }
      });
    }
  });
});
