# Tap Circle – web

The mobile web version of Tap Circle: a reflex game you play solo or head to head against a friend,
opened straight from an invite link in the phone's browser.

Live at: https://blackdolphin84.github.io/TapCircle-PUBLIC/

- `index.html`, `game.js`, `engine.js`, `sfx.js` – the game (Canvas + comic-style HTML overlays, synthesized sounds).
  `engine.js` is an exact port of the Android app's game logic, including Kotlin's random generator, so an app
  player and a browser player see the same circles.
- Multiplayer runs over public MQTT brokers (HiveMQ / EMQX / Mosquitto) via WebSocket; the app connects to the same brokers.
- `mqtt.min.js` – [MQTT.js](https://github.com/mqttjs/MQTT.js) (MIT).
- `fonts/` – Secular One and Bangers (SIL OFL).
- `TapCircle.apk` – the Android app for direct install.
- `.github/workflows/pages.yml` – deploys to GitHub Pages on every push to `main`.
