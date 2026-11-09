PHONE GPS MONITOR - ESP8266 NODEMCU

FILES
- index.html
- style.css
- script.js
- esp8266_gps.ino

1) TOPIC CONFIGURATION
The dashboard and ESP8266 sketch already use the same prototype MQTT topics:
Location: phonegps/esp8266/7f3c91a8d2b64e0f/location
Status:   phonegps/esp8266/7f3c91a8d2b64e0f/status
Do not change one side without changing the other.

2) WEBPAGE HOSTING
The phone browser Geolocation API requires a secure context (HTTPS).
Publish index.html, style.css and script.js to an HTTPS static host, for example
GitHub Pages, Cloudflare Pages, or Netlify. Open the resulting HTTPS URL on Android.
Do not open the HTML as a file:// page and do not use ordinary HTTP hosting.

3) NETWORK
Connect the Android phone and ESP8266 to the same internet-connected Wi-Fi network.
If using a phone hotspot, use a SECOND phone as the hotspot provider.
The phone running GPS cannot normally join its own hotspot.

4) ARDUINO IDE LIBRARIES
Install:
- ESP8266 board package (Boards Manager)
- ArduinoJson by Benoit Blanchon
- PubSubClient by Nick O'Leary

Select: NodeMCU 1.0 (ESP-12E Module)
Enter Wi-Fi SSID and password in esp8266_gps.ino.
Upload and open Serial Monitor at 115200 baud.

5) TEST
- Open the HTTPS dashboard on Android.
- Wait until MQTT says Connected.
- Press Start GPS and grant location permission.
- Wait for latitude and longitude to appear.
- Check ESP8266 Serial Monitor for PHONE GPS RECEIVED.

6) SECURITY AND LIMITATIONS
This is a learning prototype using the public HiveMQ broker.
The topic name is an identifier, not authentication. Anyone who discovers it
could subscribe to or publish messages. Do not use this for sensitive tracking.
The ESP8266 sketch uses setInsecure() for a quick TLS prototype; it encrypts
traffic but does not verify the broker certificate. Use certificate validation
for a production deployment.
GPS readings can be inaccurate indoors. Accuracy is reported by the phone.
The browser may pause GPS when the page is backgrounded or the screen is locked.
The device status is a heartbeat indicator, not a guaranteed real-time presence check.
