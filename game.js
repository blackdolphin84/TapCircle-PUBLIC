/* Tap Circle – web version: comic renderer, two-player duel over MQTT (WebSocket) and the UI. */
(function () {
  'use strict';
  const E = window.TapEngine;

  // ---------------------------------------------------------------- constants
  const SITE_URL = 'https://blackdolphin84.github.io/TapCircle-PUBLIC/';
  const TOPIC_PREFIX = 'tapcircle/v1/room/';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BROKERS = {
    H: 'wss://broker.hivemq.com:8884/mqtt',
    E: 'wss://broker.emqx.io:8084/mqtt',
    M: 'wss://test.mosquitto.org:8081',
  };
  const BROKER_ORDER = ['H', 'E', 'M'];
  const COUNTDOWN_MS = 3000, HELLO_INTERVAL_MS = 2000, READY_INTERVAL_MS = 2000;
  const JOIN_TIMEOUT_MS = 45000, RESULT_TIMEOUT_MS = 12000, GAME_OVER_GRACE_MS = 700;
  const POPUP_MS = 800, APPEAR_MS = 140, WARNING_MS = 10000;
  const HIT_WORDS = ['POW!', 'BAM!', 'WHAM!', 'ZAP!', 'BOOM!'];
  const MISS_WORDS = ['MISS!', 'OOPS!', 'NOPE!'];

  const C = {
    PAPER: '#FFF4DC', DOTS: '#FFC94D', INK: '#161616', WHITE: '#FFFFFF', YELLOW: '#FFE04A', RED: '#FF3B3B',
    BLUE: '#2F8BFF', GREEN: '#3DD267', ORANGE: '#FF9F1C', PURPLE: '#B15CFF', PINK: '#FF4FA3', CYAN: '#31D4E6',
  };
  const BALL_COLORS = [C.RED, C.BLUE, C.GREEN, C.ORANGE, C.PURPLE, C.PINK, C.CYAN];

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };
  function loadSettings() {
    const s = store.get('settings', { difficulty: 1, durationSec: 60 });
    if (!(s.difficulty >= 0 && s.difficulty <= 2)) s.difficulty = 1;
    if (!E.DURATION_OPTIONS.includes(s.durationSec)) s.durationSec = 60;
    return s;
  }
  function bestKey(s) { return 'best_' + E.DIFFICULTIES[s.difficulty].key + '_' + s.durationSec; }
  function loadBest(s) { return store.get(bestKey(s), 0); }
  function saveBest(s, v) { store.set(bestKey(s), v); }
  function playerId() {
    let id = store.get('playerId', null);
    if (!id) {
      const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
      id = Array.from({ length: 8 }, () => a[Math.floor(Math.random() * a.length)]).join('');
      store.set('playerId', id);
    }
    return id;
  }
  function playerName() { const n = (store.get('playerName', '') || '').trim(); return n || 'Player'; }
  function soundEnabled() { return store.get('sound', true) !== false; }

  // ---------------------------------------------------------------- codes & links
  function newRoomCode(letter) {
    let code = letter;
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return code;
  }
  function normalizeCode(input) {
    if (!input) return null;
    const cleaned = String(input).toUpperCase().split('').filter(ch => CODE_ALPHABET.includes(ch)).join('');
    if (cleaned.length !== 6 || !BROKERS[cleaned[0]]) return null;
    return cleaned;
  }
  function roomFromLocation() {
    const m = (location.hash + ' ' + location.search).match(/join=([A-Za-z0-9]{6})/);
    return m ? normalizeCode(m[1]) : null;
  }
  function inviteUrl(code) { return SITE_URL + '#join=' + code; }
  function inviteText(code) {
    return "Let's play Tap Circle head to head!\nRoom code: " + code + '\nTap the link to play (opens right in the browser):\n' + inviteUrl(code);
  }

  // ---------------------------------------------------------------- duel session (mirrors DuelSession.kt)
  class DuelSession {
    constructor(onChanged) {
      this.onChanged = onChanged;
      this.playerId = playerId(); this.playerName = playerName();
      this.phase = 'CONNECTING'; this.roomCode = ''; this.isHost = false;
      this.opponentName = ''; this.opponentScore = 0; this.opponentFinalScore = null; this.myFinalScore = null;
      this.seed = 0; this.duelSettings = { difficulty: 1, durationSec: 60 }; this.error = null;
      this.countdownStartedAt = 0; this.rematchRequested = false; this.opponentWantsRematch = false;
      this.client = null; this.topic = ''; this.closed = false; this.hostId = null; this.guestId = null;
      this.hostSettings = null; this.joinStartedAt = 0; this.timers = {};
      this.opponentLeft = false; this.pendingGo = false;
    }
    foreground() { return !document.hidden; }
    /* Called when the page becomes visible: a Go held back while the host was away goes out now. */
    onForeground() {
      if (this.pendingGo && this.phase === 'STARTING') { this.pendingGo = false; this.send({ t: 'go' }); this.beginCountdown(); }
      if (this.phase === 'COUNTDOWN' && performance.now() - this.countdownStartedAt >= COUNTDOWN_MS) { this.countdownStartedAt = performance.now(); this.notify(); }
    }
    notify() { if (!this.closed) this.onChanged(this); }
    setTimer(name, fn, ms) { this.clearTimer(name); this.timers[name] = setTimeout(fn, ms); }
    clearTimer(name) { if (this.timers[name]) { clearTimeout(this.timers[name]); delete this.timers[name]; } }
    duelSettingsFrom(s) { return s.durationSec > 0 ? s : { difficulty: s.difficulty, durationSec: 60 }; }

    host(settings) {
      this.isHost = true; this.hostId = this.playerId; this.hostSettings = settings;
      this.duelSettings = this.duelSettingsFrom(settings);
      this.phase = 'CONNECTING'; this.notify();
      const tryBroker = (i) => {
        if (this.closed) return;
        if (i >= BROKER_ORDER.length) { this.fail('CONNECT_FAILED'); return; }
        const letter = BROKER_ORDER[i];
        const code = newRoomCode(letter);
        this.connect(letter, code, () => { this.roomCode = code; this.phase = 'WAITING_FOR_GUEST'; this.notify(); }, () => tryBroker(i + 1));
      };
      tryBroker(0);
    }
    join(code) {
      this.isHost = false; this.roomCode = code || ''; this.phase = 'CONNECTING'; this.notify();
      if (!code || !BROKERS[code[0]]) { this.fail('BAD_CODE'); return; }
      this.connect(code[0], code, () => {
        this.phase = 'WAITING_FOR_HOST'; this.joinStartedAt = performance.now(); this.notify(); this.helloLoop();
      }, () => this.fail('CONNECT_FAILED'));
    }
    helloLoop() {
      if (this.closed || this.phase !== 'WAITING_FOR_HOST' || this.hostId) return;
      if (performance.now() - this.joinStartedAt > JOIN_TIMEOUT_MS) { this.fail('HOST_NOT_FOUND'); return; }
      this.send({ t: 'hello', name: this.playerName });
      this.setTimer('hello', () => this.helloLoop(), HELLO_INTERVAL_MS);
    }
    readyLoop() {
      if (this.closed || this.phase !== 'WAITING_FOR_HOST' || !this.hostId) return;
      if (this.foreground()) this.send({ t: 'ready', name: this.playerName });
      this.setTimer('ready', () => this.readyLoop(), READY_INTERVAL_MS);
    }
    connect(letter, code, onOk, onFail) {
      let settled = false;
      let client;
      try {
        client = mqtt.connect(BROKERS[letter], {
          clientId: 'tc' + this.playerId + Math.floor(1000 + Math.random() * 8999),
          clean: true, connectTimeout: 10000, keepalive: 20, reconnectPeriod: 2000, protocolVersion: 4,
        });
      } catch (e) { onFail(); return; }
      const topic = TOPIC_PREFIX + code;
      const giveUp = () => { if (settled) return; settled = true; try { client.end(true); } catch (e) { /* ignore */ } onFail(); };
      const timeout = setTimeout(giveUp, 12000);
      client.on('connect', () => {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (settled) return;
          if (err) { clearTimeout(timeout); giveUp(); return; }
          settled = true; clearTimeout(timeout);
          this.client = client; this.topic = topic;
          onOk();
        });
      });
      client.on('message', (t, payload) => {
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
        if (msg && typeof msg.id === 'string' && msg.id) this.onMessage(msg);
      });
      client.on('error', () => { if (!settled) { clearTimeout(timeout); giveUp(); } });
      client.on('close', () => { if (!settled) { clearTimeout(timeout); giveUp(); } });
    }
    send(fields) {
      if (this.closed || !this.client) return;
      const payload = JSON.stringify(Object.assign({ id: this.playerId }, fields));
      try { this.client.publish(this.topic, payload, { qos: 1 }); } catch (e) { /* dropped */ }
    }
    isOpponent(id) { return this.isHost ? id === this.guestId : id === this.hostId; }
    onMessage(m) {
      if (this.closed || m.id === this.playerId) return;
      switch (m.t) {
        case 'hello':
          if (!this.isHost) return;
          if (!this.guestId && this.phase === 'WAITING_FOR_GUEST') { this.guestId = m.id; this.opponentName = m.name || ''; this.startRound(); }
          else if (m.id === this.guestId && this.phase === 'STARTING') this.startRound();
          break;
        case 'start':
          if (this.isHost || m.guestId !== this.playerId) return;
          if (!['WAITING_FOR_HOST', 'REMATCH_WAIT', 'FINISHED'].includes(this.phase)) return;
          this.hostId = m.id; this.opponentName = m.hostName || ''; this.seed = Number(m.seed) | 0;
          this.duelSettings = { difficulty: Math.min(2, Math.max(0, m.difficulty | 0)), durationSec: m.duration | 0 };
          this.clearTimer('hello'); this.clearTimer('ready');
          this.phase = 'WAITING_FOR_HOST'; this.notify(); this.readyLoop();
          break;
        case 'ready':
          if (!this.isHost || m.id !== this.guestId) return;
          if (m.name) this.opponentName = m.name;
          if (this.phase === 'STARTING') {
            if (this.foreground()) { this.send({ t: 'go' }); this.beginCountdown(); } else this.pendingGo = true;
          } else if (['COUNTDOWN', 'PLAYING', 'WAITING_RESULT'].includes(this.phase)) this.send({ t: 'go' });
          break;
        case 'go':
          if (!this.isHost && m.id === this.hostId && this.phase === 'WAITING_FOR_HOST') this.beginCountdown();
          break;
        case 'score':
          if (this.isOpponent(m.id)) { this.opponentScore = m.score | 0; this.notify(); }
          break;
        case 'done':
          if (this.isOpponent(m.id)) {
            this.opponentScore = m.score | 0; this.opponentFinalScore = m.score | 0;
            if (this.myFinalScore !== null && this.phase === 'WAITING_RESULT') this.finish(); else this.notify();
          }
          break;
        case 'again':
          if (this.isOpponent(m.id) && !this.opponentLeft) {
            this.opponentWantsRematch = true;
            if (this.isHost && this.rematchRequested) this.startRound(); else this.notify();
          }
          break;
        case 'leave':
          if (this.isOpponent(m.id)) {
            this.opponentLeft = true; this.opponentWantsRematch = false; this.clearTimer('ready');
            if (this.phase === 'WAITING_RESULT') this.finish();
            else if (['REMATCH_WAIT', 'STARTING', 'WAITING_FOR_HOST'].includes(this.phase)) {
              if (this.myFinalScore !== null) { this.phase = 'FINISHED'; this.notify(); } else this.fail('OPPONENT_LEFT');
            } else this.notify();
          }
          break;
      }
    }
    startRound() {
      if (!this.guestId) return;
      if (this.phase !== 'STARTING') {
        this.seed = 1 + Math.floor(Math.random() * 2147483646);
        this.duelSettings = this.duelSettingsFrom(this.hostSettings);
      }
      this.phase = 'STARTING';
      this.send({ t: 'start', seed: this.seed, difficulty: this.duelSettings.difficulty, duration: this.duelSettings.durationSec,
        hostName: this.playerName, guestId: this.guestId });
      this.notify();
    }
    beginCountdown() {
      this.clearTimer('result'); this.clearTimer('ready');
      this.opponentScore = 0; this.opponentFinalScore = null; this.myFinalScore = null;
      this.rematchRequested = false; this.opponentWantsRematch = false; this.pendingGo = false;
      this.countdownStartedAt = performance.now();
      this.phase = 'COUNTDOWN'; this.notify();
    }
    markPlaying() { if (this.phase === 'COUNTDOWN') { this.phase = 'PLAYING'; this.notify(); } }
    publishScore(score) { if (this.phase === 'PLAYING') this.send({ t: 'score', score }); }
    publishDone(score) {
      if (this.phase !== 'PLAYING' && this.phase !== 'COUNTDOWN') return;
      this.myFinalScore = score;
      this.send({ t: 'done', score });
      if (this.opponentFinalScore !== null) this.finish();
      else { this.phase = 'WAITING_RESULT'; this.setTimer('result', () => { if (this.phase === 'WAITING_RESULT') this.finish(); }, RESULT_TIMEOUT_MS); this.notify(); }
    }
    requestRematch() {
      if (this.phase !== 'FINISHED' || this.opponentLeft) return;
      this.rematchRequested = true; this.phase = 'REMATCH_WAIT';
      this.send({ t: 'again' });
      if (this.isHost && this.opponentWantsRematch) this.startRound();
      this.notify();
    }
    finish() { this.clearTimer('result'); this.phase = 'FINISHED'; this.notify(); }
    fail(reason) { if (this.closed) return; this.error = reason; this.phase = 'ERROR'; this.clearTimer('hello'); this.clearTimer('ready'); this.notify(); }
    outcome() {
      const mine = this.myFinalScore === null ? 0 : this.myFinalScore;
      const theirs = this.opponentFinalScore === null ? this.opponentScore : this.opponentFinalScore;
      return mine > theirs ? 1 : mine < theirs ? -1 : 0;
    }
    close() {
      if (this.closed) return;
      if (this.roomCode && (this.hostId || this.guestId || this.isHost)) this.send({ t: 'leave' });
      this.closed = true;
      Object.keys(this.timers).forEach(k => this.clearTimer(k));
      const c = this.client; this.client = null;
      if (c) { try { c.end(true); } catch (e) { /* ignore */ } }
    }
  }

  // ---------------------------------------------------------------- rendering helpers
  function halftonePattern(ctx, color, cell, dotFraction) {
    const size = Math.max(2, Math.round(cell));
    const tile = document.createElement('canvas');
    tile.width = size; tile.height = size;
    const t = tile.getContext('2d');
    t.fillStyle = color;
    t.beginPath(); t.arc(size / 2, size / 2, size * dotFraction, 0, Math.PI * 2); t.fill();
    return ctx.createPattern(tile, 'repeat');
  }
  function burstPath(ctx, cx, cy, outer, inner, points, rotationDeg) {
    const step = Math.PI / points, rot = rotationDeg * Math.PI / 180;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner, a = rot + i * step - Math.PI / 2;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function darker(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.floor(((n >> 16) & 255) * factor), g = Math.floor(((n >> 8) & 255) * factor), b = Math.floor((n & 255) * factor);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function ballColor(hue) {
    const i = Math.floor((hue / 360) * BALL_COLORS.length);
    return BALL_COLORS[((i % BALL_COLORS.length) + BALL_COLORS.length) % BALL_COLORS.length];
  }

  class Painter {
    constructor(ctx) { this.ctx = ctx; this.patterns = {}; }
    outlinedText(text, x, y, font, fill, outline, align, dir) {
      const ctx = this.ctx;
      ctx.font = font; ctx.textAlign = align || 'center'; ctx.textBaseline = 'alphabetic';
      ctx.direction = dir || 'inherit';
      ctx.lineJoin = 'round'; ctx.lineWidth = outline; ctx.strokeStyle = C.INK;
      ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
    }
    box(x, y, w, h, fill, corner, border, shadow) {
      const ctx = this.ctx;
      ctx.fillStyle = C.INK; roundRect(ctx, x + shadow, y + shadow, w, h, corner); ctx.fill();
      ctx.fillStyle = fill; roundRect(ctx, x, y, w, h, corner); ctx.fill();
      ctx.lineWidth = border; ctx.strokeStyle = C.INK; ctx.stroke();
    }
    caption(x, y, w, h, rotationDeg, fill, draw) {
      const ctx = this.ctx;
      ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rotationDeg * Math.PI / 180); ctx.translate(-(x + w / 2), -(y + h / 2));
      this.box(x, y, w, h, fill, 4, 3, 4);
      draw(ctx); ctx.restore();
    }
    ball(cx, cy, r, color) {
      const ctx = this.ctx;
      ctx.fillStyle = C.INK; ctx.beginPath(); ctx.arc(cx + r * 0.12, cy + r * 0.14, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      const dark = darker(color, 0.62), cell = Math.max(5, r * 0.22);
      const key = dark + '|' + Math.round(cell);
      if (!this.patterns[key]) this.patterns[key] = halftonePattern(ctx, dark, cell, 0.32);
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2); ctx.clip();
      ctx.translate(cx, cy); ctx.rotate(-Math.PI / 4); ctx.translate(-cx, -cy);
      ctx.fillStyle = this.patterns[key]; ctx.fillRect(cx - 2 * r, cy + r * 0.25, 4 * r, 2 * r); ctx.restore();
      ctx.lineWidth = Math.max(3, r * 0.11); ctx.strokeStyle = C.INK; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.save(); ctx.translate(cx - r * 0.38, cy - r * 0.42); ctx.rotate(-35 * Math.PI / 180);
      ctx.fillStyle = C.WHITE; ctx.beginPath(); ctx.ellipse(0, 0, r * 0.26, r * 0.13, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    lifeRing(cx, cy, radius, fraction, color) {
      const ctx = this.ctx, w = Math.max(5, radius * 0.16), start = -Math.PI / 2, end = start + Math.PI * 2 * fraction;
      if (fraction <= 0) return;
      ctx.lineCap = 'round';
      ctx.lineWidth = w + 4; ctx.strokeStyle = C.INK; ctx.beginPath(); ctx.arc(cx, cy, radius, start, end); ctx.stroke();
      ctx.lineWidth = w; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(cx, cy, radius, start, end); ctx.stroke();
      ctx.lineCap = 'butt';
    }
    burst(cx, cy, radius, fill, rotationDeg, points) {
      const ctx = this.ctx;
      ctx.fillStyle = C.INK; burstPath(ctx, cx + 4, cy + 4, radius, radius * 0.68, points, rotationDeg); ctx.fill();
      ctx.fillStyle = fill; burstPath(ctx, cx, cy, radius, radius * 0.68, points, rotationDeg); ctx.fill();
      ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = C.INK; ctx.stroke();
    }
  }

  function renderBackground(width, height, hudHeight) {
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = C.PAPER; ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 0.6; ctx.fillStyle = halftonePattern(ctx, C.DOTS, 9, 0.22); ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
    const cx = width / 2, cy = hudHeight + (height - hudHeight) / 2, inner = Math.min(width, height) * 0.24, outer = Math.max(width, height);
    ctx.strokeStyle = 'rgba(22,22,22,0.1)'; ctx.lineCap = 'round';
    for (let i = 0; i < 56; i++) {
      const a = (i * 360 / 56 + 3) * Math.PI / 180, len = i % 3 === 0 ? outer : outer * 0.8;
      ctx.lineWidth = i % 2 === 0 ? 2.5 : 1.5;
      ctx.beginPath(); ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a)); ctx.lineTo(cx + len * Math.cos(a), cy + len * Math.sin(a)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.strokeStyle = C.WHITE; ctx.lineWidth = 14; ctx.strokeRect(0, 0, width, height);
    ctx.strokeStyle = C.INK; ctx.lineWidth = 5; ctx.strokeRect(7, 7, width - 14, height - 14);
    return canvas;
  }

  // ---------------------------------------------------------------- the game
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const painter = new Painter(ctx);
  const engine = new E.GameEngine();
  const sfx = window.TapSfx;
  sfx.setEnabled(soundEnabled());
  let lastCountdownNumber = 0;
  const state = {
    settings: loadSettings(), best: 0, bestAtRoundStart: 0, newBest: false, roundEndedAt: 0,
    popups: [], popupCounter: 0, duel: null, width: 0, height: 0, hudHeight: 146, background: null,
    overlay: null, rtl: true,
  };
  engine.applySettings(state.settings);
  state.best = loadBest(state.settings);

  function fontSecular(px) { return px + 'px "Secular One", "Arial Black", Arial, sans-serif'; }
  function fontBangers(px) { return px + 'px Bangers, Impact, "Arial Black", sans-serif'; }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    state.width = w; state.height = h;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.background = renderBackground(w, h, state.hudHeight);
    engine.setBounds(w, h - 14, state.hudHeight, 14, 8);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- overlays (HTML)
  const overlays = Array.from(document.querySelectorAll('.overlay'));
  let graceTimer = null;
  function showOverlay(id, grace) {
    overlays.forEach(o => o.classList.toggle('show', o.id === id));
    state.overlay = id || null;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (id) {
      const el = $(id);
      if (grace) { el.classList.add('grace'); graceTimer = setTimeout(() => el.classList.remove('grace'), GAME_OVER_GRACE_MS); }
      else el.classList.remove('grace');
    }
    $('hud-buttons').classList.toggle('show', !id && engine.state === 'PLAYING');
    $('btn-restart').style.display = state.duel ? 'none' : '';
  }

  // ---- popups
  function addPopup(x, y, points, now) {
    state.popupCounter++;
    const hit = points > 0, words = hit ? HIT_WORDS : MISS_WORDS;
    state.popups.push({ x, y, text: hit ? '+' + points : '-' + (-points), word: words[state.popupCounter % words.length],
      color: hit ? C.YELLOW : C.RED, startedAt: now, rotation: state.popupCounter % 2 === 0 ? -8 : 7 });
  }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

  function handleEvent(e, now) {
    const d = state.duel;
    switch (e.type) {
      case 'hit': addPopup(e.x, e.y, e.points, now); vibrate(15); sfx.hit(); if (d) d.publishScore(engine.score); break;
      case 'miss': addPopup(e.x, e.y, e.points, now); vibrate([10, 30, 10]); sfx.miss(); if (d) d.publishScore(engine.score); break;
      case 'vanished': addPopup(e.x, e.y, e.points, now); sfx.miss(); if (d) d.publishScore(engine.score); break;
      case 'roundEnded':
        state.popups.length = 0; state.roundEndedAt = now; vibrate(60); sfx.end();
        if (d) d.publishDone(engine.score);
        else { state.newBest = engine.score > state.bestAtRoundStart; }
        break;
    }
    if (!d) {
      const record = !E.isTimed(engine.activeSettings) || e.type === 'roundEnded';
      if (record && engine.score > state.best) { state.best = engine.score; saveBest(engine.activeSettings, state.best); }
    }
  }

  // ---- solo flow
  function startRound(now) {
    state.popups.length = 0;
    engine.applySettings(state.settings);
    engine.reseed(1 + Math.floor(Math.random() * 2147483646));
    engine.start(now);
    state.best = loadBest(engine.activeSettings); state.bestAtRoundStart = state.best; state.newBest = false;
    showOverlay(null);
  }
  function endToMenu() {
    state.popups.length = 0;
    engine.stop();
    engine.applySettings(state.settings);
    state.best = loadBest(engine.activeSettings);
    showOverlay('ov-start');
  }

  // ---- duel flow
  function newSession() {
    if (state.duel) state.duel.close();
    engine.stop(); state.popups.length = 0;
    const d = new DuelSession(() => syncDuelUi());
    state.duel = d;
    return d;
  }
  function hostDuel() { newSession().host(state.settings); }
  function joinDuel(raw) {
    const code = normalizeCode(raw) || '';
    const d = state.duel;
    if (d && code && d.roomCode === code && d.phase !== 'ERROR') { syncDuelUi(); return; }
    newSession().join(code);
  }
  function closeDuel() {
    if (state.duel) state.duel.close();
    state.duel = null;
    endToMenu();
  }
  function beginDuelRound(d, now) {
    state.popups.length = 0;
    engine.applySettings(d.duelSettings);
    engine.reseed(d.seed);
    engine.start(now);
    d.markPlaying();
    sfx.go();
    showOverlay(null);
  }
  function syncDuelUi() {
    const d = state.duel; if (!d) return;
    const name = shortName(d.opponentName);
    switch (d.phase) {
      case 'CONNECTING': $('connecting-text').textContent = 'Connecting to the game server…'; showOverlay('ov-connecting'); break;
      case 'WAITING_FOR_GUEST': $('room-code').textContent = d.roomCode; showOverlay('ov-waiting'); break;
      case 'WAITING_FOR_HOST': case 'STARTING':
        $('connecting-text').textContent = d.opponentName ? 'Starting against ' + name + '…' : 'Waiting for the host… (room ' + d.roomCode + ')';
        showOverlay('ov-connecting'); break;
      case 'COUNTDOWN': showOverlay(null); break;
      case 'PLAYING': showOverlay(null); break;
      case 'WAITING_RESULT':
        $('wait-score').textContent = formatScore(engine.score);
        $('wait-text').textContent = 'Waiting for ' + name + ' to finish…';
        showOverlay('ov-waitresult', true); break;
      case 'FINISHED': {
        const o = d.outcome();
        const title = $('result-title');
        title.textContent = o > 0 ? 'YOU WIN!' : o < 0 ? 'You lost…' : 'Draw!';
        title.className = o > 0 ? 'green' : o < 0 ? 'red' : '';
        $('result-me').textContent = 'You: ' + formatScore(d.myFinalScore === null ? engine.score : d.myFinalScore);
        $('result-them').textContent = name + ': ' + formatScore(d.opponentFinalScore === null ? d.opponentScore : d.opponentFinalScore);
        $('result-rematch-note').textContent = d.opponentLeft ? name + ' left the game.' : d.opponentWantsRematch ? name + ' wants a rematch!' : '';
        $('btn-rematch').style.display = d.opponentLeft ? 'none' : '';
        showOverlay('ov-result', true); break;
      }
      case 'REMATCH_WAIT': $('connecting-text').textContent = 'Waiting for your rival…'; showOverlay('ov-connecting'); break;
      case 'ERROR': {
        const msgs = {
          CONNECT_FAILED: 'Could not reach the game server. Check your internet connection and try again.',
          HOST_NOT_FOUND: 'No open game with this code. Ask your friend to start a game and share the link again.',
          BAD_CODE: 'That is not a valid room code.',
          OPPONENT_LEFT: name + ' left the game.',
        };
        $('error-text').textContent = msgs[d.error] || msgs.CONNECT_FAILED;
        showOverlay('ov-error'); break;
      }
    }
  }

  // ---- formatting
  function formatScore(s) { return s < 0 ? '-' + Math.abs(s) : String(s); }
  function shortName(n) { n = (n || '').trim() || 'Rival'; return n.length > 12 ? n.slice(0, 11) + '…' : n; }
  function formatTime(ms) { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  // ---- drawing
  function drawCaption(x, y, w, h, rot, fill, label, value, valueColor) {
    painter.caption(x, y, w, h, rot, fill, (c) => {
      c.font = fontSecular(13); c.textAlign = 'center'; c.fillStyle = C.INK; c.fillText(label, x + w / 2, y + 18);
      painter.outlinedText(value, x + w / 2, y + 44, fontSecular(22), valueColor, 3, 'center', 'ltr');
    });
  }
  function drawHud(now) {
    const w = state.width, d = state.duel;
    const boxW = Math.min(102, w * 0.3 - 8), boxH = 54, top = 34;
    const scoreX = w * 0.2, sideX = w * 0.8;
    const countingDown = d && d.phase === 'COUNTDOWN';
    drawCaption(scoreX - boxW / 2, top, boxW, boxH, -2, C.YELLOW, 'SCORE', formatScore(countingDown ? 0 : engine.score), C.WHITE);
    if (d) drawCaption(sideX - boxW / 2, top, boxW, boxH, 2, C.RED, (d.opponentName || 'RIVAL').slice(0, 10).toUpperCase(), formatScore(d.opponentScore), C.WHITE);
    else drawCaption(sideX - boxW / 2, top, boxW, boxH, 2, C.BLUE, 'BEST', formatScore(state.best), C.WHITE);
    if (countingDown) {
      drawCaption(w / 2 - boxW / 2, top, boxW, boxH, 0, C.WHITE, 'TIME', formatTime(d.duelSettings.durationSec * 1000), C.WHITE);
    } else if (E.isTimed(engine.activeSettings)) {
      const remaining = engine.remainingMs(now), warning = remaining <= WARNING_MS && engine.state === 'PLAYING';
      const fill = warning && Math.floor(now / 300) % 2 === 0 ? C.ORANGE : C.WHITE;
      drawCaption(w / 2 - boxW / 2, top, boxW, boxH, 0, fill, 'TIME', formatTime(remaining), warning ? C.YELLOW : C.WHITE);
    }
  }
  function drawBall(c, now) {
    const elapsed = now - c.shownAt;
    const remaining = Math.min(1, Math.max(0, 1 - elapsed / c.lifetimeMs));
    const t = Math.min(1, Math.max(0, elapsed / APPEAR_MS));
    const scale = t < 0.7 ? 0.5 + 0.7 * (t / 0.7) : 1.2 - 0.2 * ((t - 0.7) / 0.3);
    const r = engine.currentRadius(now) * scale, color = ballColor(c.hue);
    painter.lifeRing(c.x, c.y, r + 13, remaining, color);
    painter.ball(c.x, c.y, r, color);
  }
  function drawPopups(now) {
    state.popups = state.popups.filter(p => now - p.startedAt < POPUP_MS);
    for (const p of state.popups) {
      const t = (now - p.startedAt) / POPUP_MS;
      const pop = Math.min(1, t * POPUP_MS / APPEAR_MS);
      const scale = pop < 0.6 ? 0.3 + 0.9 * (pop / 0.6) : 1.2 - 0.2 * ((pop - 0.6) / 0.4);
      const alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y - 46 - t * 36); ctx.rotate(p.rotation * Math.PI / 180); ctx.scale(scale, scale);
      painter.burst(0, 0, 38, p.color, p.rotation * 2, 11);
      painter.outlinedText(p.text, 0, 9, fontBangers(26), p.color === C.YELLOW ? C.INK : C.WHITE, 3, 'center', 'ltr');
      painter.outlinedText(p.word, 0, -36, fontBangers(17), C.WHITE, 4, 'center', 'ltr');
      ctx.restore();
    }
  }
  function drawCountdown(d, now) {
    const elapsed = now - d.countdownStartedAt, n = Math.min(3, Math.max(1, 3 - Math.floor(elapsed / 1000)));
    if (n !== lastCountdownNumber) { lastCountdownNumber = n; sfx.tick(); }
    const cx = state.width / 2, cy = state.hudHeight + (state.height - state.hudHeight) / 2;
    const scale = 1.15 - 0.15 * ((elapsed % 1000) / 1000);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-cx, -cy);
    painter.burst(cx, cy, 96, C.YELLOW, n * 9, 14);
    painter.outlinedText(String(n), cx, cy + 22, fontBangers(64), C.WHITE, 7, 'center', 'ltr');
    ctx.restore();
  }

  function frame() {
    const now = performance.now();
    const d = state.duel;
    if (d && d.phase === 'COUNTDOWN' && now - d.countdownStartedAt >= COUNTDOWN_MS) beginDuelRound(d, now);
    for (const e of engine.tick(now)) handleEvent(e, now);
    if (!d && engine.state === 'GAME_OVER' && state.overlay !== 'ov-gameover') {
      $('final-score').textContent = formatScore(engine.score);
      $('new-best').style.display = state.newBest ? '' : 'none';
      showOverlay('ov-gameover', true);
    }
    if (state.background) ctx.drawImage(state.background, 0, 0, state.width, state.height);
    if (engine.circle) drawBall(engine.circle, now);
    drawHud(now);
    drawPopups(now);
    if (d && d.phase === 'COUNTDOWN') drawCountdown(d, now);
    requestAnimationFrame(frame);
  }

  // ---- input
  document.addEventListener('pointerdown', () => sfx.unlock(), { capture: true });
  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (state.overlay) return;
    const now = performance.now();
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (engine.state === 'PAUSED') { engine.resume(now); return; }
    if (engine.state !== 'PLAYING') return;
    const ticked = engine.tick(now);
    for (const e of ticked) handleEvent(e, now);
    const justVanished = ticked.some(e => e.type === 'vanished');
    if (!justVanished && engine.state === 'PLAYING') {
      const e = engine.tap(x, y, now);
      if (e) handleEvent(e, now);
    }
  }, { passive: false });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { if (state.duel) state.duel.onForeground(); return; }
    const d = state.duel;
    if (d && d.phase === 'PLAYING' && engine.state === 'PLAYING') { engine.stop(); d.publishDone(engine.score); state.popups.length = 0; return; }
    if (!d && engine.state === 'PLAYING') { engine.pause(performance.now()); state.popups.length = 0; showOverlay('ov-pause'); }
  });

  // ---- buttons
  $('btn-solo').addEventListener('click', () => startRound(performance.now()));
  $('btn-host').addEventListener('click', hostDuel);
  $('btn-join').addEventListener('click', () => { $('join-code').value = ''; showOverlay('ov-join'); setTimeout(() => $('join-code').focus(), 50); });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-back').addEventListener('click', () => { saveSettings(); showOverlay('ov-start'); });
  $('btn-join-go').addEventListener('click', () => joinDuel($('join-code').value));
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinDuel($('join-code').value); });
  $('btn-join-cancel').addEventListener('click', () => showOverlay('ov-start'));
  $('btn-waiting-cancel').addEventListener('click', closeDuel);
  $('btn-connecting-cancel').addEventListener('click', closeDuel);
  $('btn-waitresult-menu').addEventListener('click', closeDuel);
  $('btn-error-back').addEventListener('click', closeDuel);
  $('btn-rematch').addEventListener('click', () => { if (state.duel) state.duel.requestRematch(); });
  $('btn-result-menu').addEventListener('click', closeDuel);
  $('btn-again').addEventListener('click', () => startRound(performance.now()));
  $('btn-gameover-menu').addEventListener('click', endToMenu);
  $('btn-resume').addEventListener('click', () => { engine.resume(performance.now()); showOverlay(null); });
  $('btn-restart').addEventListener('click', () => startRound(performance.now()));
  $('btn-menu').addEventListener('click', () => {
    const d = state.duel;
    if (d) { if (d.phase === 'PLAYING' && engine.state === 'PLAYING') { engine.stop(); d.publishDone(engine.score); } closeDuel(); }
    else endToMenu();
  });
  $('btn-invite-join').addEventListener('click', () => {
    store.set('playerName', $('invite-name').value.trim());
    joinDuel($('invite-code').textContent);
  });
  $('btn-invite-cancel').addEventListener('click', () => { history.replaceState(null, '', location.pathname); showOverlay('ov-start'); });

  async function share() {
    const d = state.duel; if (!d || !d.roomCode) return;
    const text = inviteText(d.roomCode), url = inviteUrl(d.roomCode);
    if (navigator.share) {
      try { await navigator.share({ title: 'Tap Circle', text, url }); return; } catch (e) { /* cancelled; fall through */ }
    }
    try { await navigator.clipboard.writeText(text); $('share-note').textContent = 'Link copied – paste it in WhatsApp or any chat'; }
    catch (e) { $('share-note').textContent = url; }
  }
  $('btn-share').addEventListener('click', share);
  $('btn-whatsapp').addEventListener('click', () => {
    const d = state.duel; if (!d || !d.roomCode) return;
    window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(d.roomCode)), '_blank');
  });

  // ---- settings
  function openSettings() {
    $('name').value = store.get('playerName', '') || '';
    document.querySelectorAll('input[name=difficulty]').forEach(r => { r.checked = Number(r.value) === state.settings.difficulty; });
    document.querySelectorAll('input[name=duration]').forEach(r => { r.checked = Number(r.value) === state.settings.durationSec; });
    $('sound').checked = soundEnabled();
    showOverlay('ov-settings');
  }
  function saveSettings() {
    const diff = document.querySelector('input[name=difficulty]:checked');
    const dur = document.querySelector('input[name=duration]:checked');
    state.settings = { difficulty: diff ? Number(diff.value) : 1, durationSec: dur ? Number(dur.value) : 60 };
    store.set('settings', state.settings);
    store.set('playerName', $('name').value.trim());
    store.set('sound', $('sound').checked);
    sfx.setEnabled($('sound').checked);
    engine.applySettings(state.settings);
    state.best = loadBest(state.settings);
  }

  // ---- boot
  function showInvite(code) {
    $('invite-code').textContent = code;
    $('invite-name').value = store.get('playerName', '') || '';
    showOverlay('ov-invite');
  }
  const invited = roomFromLocation();
  if (invited) showInvite(invited); else showOverlay('ov-start');
  window.addEventListener('hashchange', () => {
    const code = roomFromLocation();
    if (code && !(state.duel && state.duel.roomCode === code)) {
      if (state.duel) state.duel.close();
      state.duel = null; engine.stop(); state.popups.length = 0;
      showInvite(code);
    }
  });
  if (document.fonts && document.fonts.load) {
    document.fonts.load('20px "Secular One"'); document.fonts.load('20px Bangers');
  }
  requestAnimationFrame(frame);
})();
