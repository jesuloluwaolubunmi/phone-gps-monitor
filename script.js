// ==========================================
// PHONE GPS MONITOR - ESP8266
// ==========================================

// MQTT broker
const MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";

// MQTT topics
const LOCATION_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/location";

const STATUS_TOPIC =
  "phonegps/esp8266/7f3c91a8d2b64e0f/status";

// GPS variables
let watchId = null;
let mqttClient = null;
let marker = null;
let accuracyCircle = null;
let map = null;
let messageCount = 0;

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

    // Subscribe to ESP8266 status
    mqttClient.subscribe(STATUS_TOPIC);

    // Subscribe to phone GPS coordinates
    mqttClient.subscribe(LOCATION_TOPIC);
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
  });

  // ========================================
  // RECEIVE MQTT MESSAGES
  // ========================================

  mqttClient.on("message", (topic, payload) => {

    // Receive GPS coordinates from the phone
    if (topic === LOCATION_TOPIC) {

      // Ignore the phone's own MQTT message echo.
      // The laptop will process it because watchId is null.
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

        // Update dashboard
        $("latitude").textContent = lat.toFixed(7);
        $("longitude").textContent = lon.toFixed(7);
        $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;
        $("lastUpdate").textContent = timeText;

        if ($("gpsStatus")) {
          $("gpsStatus").textContent = "Receiving GPS from phone";
        }

        // Update map
        updateMap(lat, lon, accuracy);

        // Update map link
        if ($("openMap")) {
          $("openMap").href =
            `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
        }

        // Add reading to history
        addHistory(lat, lon, accuracy, timeText);

        if ($("sendState")) {
          $("sendState").textContent = "GPS received from phone";
        }

      } catch (error) {
        console.error("Error processing GPS message:", error);
      }

      return;
    }

    // Receive ESP8266 status
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
  const history = $("historyList");

  if (!history) return;

  const item = document.createElement("div");

  item.className = "history-item";

  item.textContent =
    `${time} | ${lat.toFixed(6)}, ${lon.toFixed(6)} | ±${accuracy.toFixed(1)} m`;

  history.prepend(item);

  // Keep only the latest 10 readings
  while (history.children.length > 10) {
    history.removeChild(history.lastChild);
  }

  messageCount++;

  if ($("messageCount")) {
    $("messageCount").textContent = messageCount;
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

  const gpsData = {
    latitude: lat,
    longitude: lon,
    accuracy: accuracy,
    timestamp: timestamp
  };

  // Update phone dashboard
  $("latitude").textContent = lat.toFixed(7);
  $("longitude").textContent = lon.toFixed(7);
  $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;

  const timeText = new Date(timestamp).toLocaleTimeString();

  $("lastUpdate").textContent = timeText;

  if ($("gpsStatus")) {
    $("gpsStatus").textContent = "GPS location acquired";
  }

  // Update map
  updateMap(lat, lon, accuracy);

  // Update OpenStreetMap link
  if ($("openMap")) {
    $("openMap").href =
      `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
  }

  // Publish coordinates to MQTT
  if (mqttClient && mqttClient.connected) {

    mqttClient.publish(
      LOCATION_TOPIC,
      JSON.stringify(gpsData)
    );

    if ($("sendState")) {
      $("sendState").textContent = "GPS coordinates sent";
    }

    messageCount++;

    if ($("messageCount")) {
      $("messageCount").textContent = messageCount;
    }

  } else {
    if ($("sendState")) {
      $("sendState").textContent = "Waiting for MQTT connection";
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
      message = "Location permission denied. Allow location access.";
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

  if (watchId !== null) {
    return;
  }

  if ($("gpsStatus")) {
    $("gpsStatus").textContent = "Searching for GPS location...";
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
    $("sendState").textContent = "GPS transmission stopped";
  }
}

// ==========================================
// BUTTON EVENTS
// ==========================================

document.addEventListener("DOMContentLoaded", () => {

  initializeMap();

  connectMQTT();

  if ($("startGPS")) {
    $("startGPS").addEventListener("click", startGPS);
  }

  if ($("stopGPS")) {
    $("stopGPS").addEventListener("click", stopGPS);
  }

});
