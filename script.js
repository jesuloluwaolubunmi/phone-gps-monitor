// Keep these topic names identical to the topics in esp8266_gps.ino.
const MQTT_URL = "wss://broker.hivemq.com:8884/mqtt";
const LOCATION_TOPIC = "phonegps/esp8266/7f3c91a8d2b64e0f/location";
const STATUS_TOPIC = "phonegps/esp8266/7f3c91a8d2b64e0f/status";

const $ = (id) => document.getElementById(id);
let mqttClient = null;
let watchId = null;
let sentCount = 0;
let marker = null;
let accuracyCircle = null;
let map = null;
let historyRows = [];

function setMqttStatus(text, state) {
  $("mqttStatus").textContent = text;
  $("brokerState").textContent = text;
  $("mqttDot").className = "dot " + state;
}

function connectMQTT() {
  if (!window.mqtt) {
    setMqttStatus("MQTT library failed to load", "offline");
    return;
  }

  const clientId = "phone-gps-web-" + Math.random().toString(16).slice(2);
  mqttClient = mqtt.connect(MQTT_URL, {
    clientId,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
    keepalive: 30
  });

  mqttClient.on("connect", () => {
    setMqttStatus("Connected to MQTT", "online");
    mqttClient.subscribe(STATUS_TOPIC, { qos: 0 }, (err) => {
      if (err) console.error("Status subscription error:", err);
    });
  });

  mqttClient.on("reconnect", () => setMqttStatus("Reconnecting…", ""));
  mqttClient.on("offline", () => setMqttStatus("Offline", "offline"));
  mqttClient.on("error", (err) => {
    console.error("MQTT error:", err);
    setMqttStatus("Connection error", "offline");
  });

  mqttClient.on("message", (topic, payload) => {
    if (topic !== STATUS_TOPIC) return;
    try {
      const status = JSON.parse(payload.toString());
      $("deviceState").textContent = status.online ? "Online" : "Offline";
      $("deviceUpdate").textContent = new Date().toLocaleTimeString();
    } catch (e) {
      $("deviceState").textContent = "Message received";
    }
  });
}

function initMap() {
  map = L.map("map").setView([0, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
}

function addHistory(lat, lon, accuracy, time) {
  historyRows.unshift({ lat, lon, accuracy, time });
  historyRows = historyRows.slice(0, 10);
  $("history").innerHTML = "";
  historyRows.forEach((r) => {
    const tr = document.createElement("tr");
    [r.time, r.lat.toFixed(7), r.lon.toFixed(7), `±${r.accuracy.toFixed(1)} m`]
      .forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
    $("history").appendChild(tr);
  });
}

function handlePosition(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = position.coords.accuracy;
  const timestamp = new Date(position.timestamp);

  $("latitude").textContent = lat.toFixed(7);
  $("longitude").textContent = lon.toFixed(7);
  $("accuracy").textContent = `±${accuracy.toFixed(1)} m`;
  $("lastUpdate").textContent = timestamp.toLocaleTimeString();
  $("gpsStatus").textContent = "GPS position acquired.";

  const latlng = [lat, lon];
  if (!marker) {
    marker = L.marker(latlng).addTo(map).bindPopup("Your phone's location");
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: "#168fe5",
      fillOpacity: 0.10
    }).addTo(map);
    map.setView(latlng, 16);
  } else {
    marker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
  }

  $("openMap").href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  addHistory(lat, lon, accuracy, timestamp.toLocaleTimeString());

  if (mqttClient && mqttClient.connected) {
    const payload = JSON.stringify({
      latitude: lat,
      longitude: lon,
      accuracy: accuracy,
      timestamp: timestamp.toISOString()
    });

    mqttClient.publish(LOCATION_TOPIC, payload, { qos: 0, retain: false }, (err) => {
      if (err) {
        $("sendState").textContent = "Publish failed";
      } else {
        sentCount += 1;
        $("sentCount").textContent = sentCount;
        $("sendState").textContent = new Date().toLocaleTimeString();
      }
    });
  } else {
    $("sendState").textContent = "Waiting for MQTT connection";
  }
}

function handlePositionError(error) {
  const messages = {
    1: "Location permission denied. Allow location access in browser settings.",
    2: "Phone location is unavailable. Check GPS/location settings.",
    3: "GPS request timed out. Try again in an open area."
  };
  $("gpsStatus").textContent = messages[error.code] || error.message;
}

$("startBtn").addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    $("gpsStatus").textContent = "This browser does not support geolocation.";
    return;
  }
  if (!window.isSecureContext) {
    $("gpsStatus").textContent = "GPS requires HTTPS. Open this page using its HTTPS hosting URL.";
    return;
  }
  if (watchId !== null) return;

  $("gpsStatus").textContent = "Requesting phone location permission…";
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
  );
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
});

$("stopBtn").addEventListener("click", () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("gpsStatus").textContent = "GPS tracking stopped.";
});

$("clearBtn").addEventListener("click", () => {
  historyRows = [];
  $("history").innerHTML = '<tr><td colspan="4" class="empty">No readings yet.</td></tr>';
});

window.addEventListener("load", () => {
  initMap();
  connectMQTT();
});
