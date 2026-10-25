# Tap Circle – web

גרסת הווב של המשחק "גע בעיגול": משחק רפלקסים לבד או ראש בראש מול חבר, שנפתח ישר מקישור ההזמנה בדפדפן של הטלפון.

הכתובת: https://blackdolphin84.github.io/TapCircle-PUBLIC/

- `index.html`, `game.js`, `engine.js` – המשחק (Canvas + ממשק HTML בסגנון קומיקס). `engine.js` הוא העתק מדויק של לוגיקת המשחק
  באפליקציית האנדרואיד, כולל מחולל האקראיות של Kotlin, כך ששחקן באפליקציה ושחקן בדפדפן רואים את אותם עיגולים.
- המולטיפלייר עובר דרך שרתי MQTT ציבוריים (HiveMQ / EMQX / Mosquitto) ב-WebSocket; האפליקציה מתחברת לאותם שרתים.
- `mqtt.min.js` – [MQTT.js](https://github.com/mqttjs/MQTT.js) (רישיון MIT).
- `fonts/` – Secular One ו-Bangers (רישיון SIL OFL).
- `TapCircle.apk` – אפליקציית האנדרואיד להתקנה ישירה.
- `.github/workflows/pages.yml` – פרסום אוטומטי ל-GitHub Pages בכל דחיפה ל-`main`.
