/* Tap Circle – game logic shared by the web version. Mirrors GameEngine.kt in the Android app so that
   two players with the same seed see the same sequence of circles, whatever their screen size. */
(function (root) {
  'use strict';

  /* kotlin.random.XorWowRandom, as constructed by Random(seed: Long) for |seed| < 2^31. */
  class XorWow {
    constructor(seed1, seed2) {
      this.x = seed1 | 0; this.y = seed2 | 0; this.z = 0; this.w = 0; this.v = ~seed1 | 0;
      this.addend = ((seed1 << 10) ^ (seed2 >>> 4)) | 0;
      for (let i = 0; i < 64; i++) this.nextInt();
    }
    nextInt() {
      let t = this.x;
      t = (t ^ (t >>> 2)) | 0;
      this.x = this.y; this.y = this.z; this.z = this.w;
      const v0 = this.v; this.w = v0;
      t = ((t ^ (t << 1)) ^ v0 ^ (v0 << 4)) | 0;
      this.v = t;
      this.addend = (this.addend + 362437) | 0;
      return (t + this.addend) | 0;
    }
    /* Kotlin's nextFloat(): 24 random bits over 2^24, a single-precision value. */
    nextFloat() { return Math.fround((this.nextInt() >>> 8) / 16777216); }
  }
  function kotlinRandom(seed) { return new XorWow(seed | 0, seed < 0 ? -1 : 0); }

  const f = Math.fround;

  const DIFFICULTIES = [
    { key: 'EASY', startLifetimeMs: 2000, minLifetimeMs: 1000, lifetimeStepMs: 25, radiusFactor: 0.10 },
    { key: 'MEDIUM', startLifetimeMs: 1500, minLifetimeMs: 650, lifetimeStepMs: 30, radiusFactor: 0.085 },
    { key: 'HARD', startLifetimeMs: 1000, minLifetimeMs: 450, lifetimeStepMs: 30, radiusFactor: 0.068 },
  ];
  const DURATION_OPTIONS = [30, 60, 90, 120, 0];

  const HIT_POINTS = 100, MISS_POINTS = 100, GAP_MS = 350, FIRST_SPAWN_DELAY_MS = 500;
  const END_SHRINK = 0.45, MIN_SPAWN_DISTANCE = 0.3;

  function isTimed(s) { return s.durationSec > 0; }
  function durationMs(s) { return s.durationSec * 1000; }

  class GameEngine {
    constructor() {
      this.random = kotlinRandom(1);
      this.settings = { difficulty: 1, durationSec: 60 };
      this.activeSettings = this.settings;
      this.state = 'IDLE';
      this.score = 0; this.hits = 0; this.circle = null;
      this.width = 0; this.height = 0; this.hudHeight = 0; this.minRadius = 0; this.hitPadding = 0; this.fullRadius = 0;
      this.lifetimeMs = 0; this.nextSpawnAt = 0; this.roundStartedAt = 0; this.roundEndsAt = 0;
      this.pausedElapsedMs = 0; this.pausedRemainingMs = 0;
      this.lastU = NaN; this.lastV = NaN; this.hue = f(340);
    }
    difficulty() { return DIFFICULTIES[this.activeSettings.difficulty] || DIFFICULTIES[1]; }
    setBounds(width, height, hudHeight, minRadius, hitPadding) {
      this.width = width; this.height = height; this.hudHeight = hudHeight;
      this.minRadius = minRadius; this.hitPadding = hitPadding;
      this.fullRadius = this.computeFullRadius();
    }
    applySettings(s) {
      this.settings = s;
      if (this.state === 'IDLE' || this.state === 'GAME_OVER') {
        this.activeSettings = s;
        this.fullRadius = this.computeFullRadius();
      }
    }
    computeFullRadius() { return Math.min(this.width, this.height) * this.difficulty().radiusFactor; }
    reseed(seed) { this.random = kotlinRandom(seed); this.lastU = NaN; this.lastV = NaN; this.hue = f(340); }
    start(now) {
      this.activeSettings = this.settings;
      this.fullRadius = this.computeFullRadius();
      this.score = 0; this.hits = 0;
      this.lifetimeMs = this.difficulty().startLifetimeMs;
      this.circle = null;
      this.roundStartedAt = now;
      this.roundEndsAt = now + durationMs(this.activeSettings);
      this.nextSpawnAt = now + FIRST_SPAWN_DELAY_MS;
      this.state = 'PLAYING';
    }
    stop() {
      this.circle = null; this.state = 'IDLE';
      this.activeSettings = this.settings; this.fullRadius = this.computeFullRadius();
    }
    pause(now) {
      if (this.state !== 'PLAYING') return;
      this.pausedElapsedMs = now - this.roundStartedAt;
      this.pausedRemainingMs = this.roundEndsAt - now;
      this.circle = null; this.state = 'PAUSED';
    }
    resume(now) {
      if (this.state !== 'PAUSED') return;
      this.roundStartedAt = now - this.pausedElapsedMs;
      this.roundEndsAt = now + this.pausedRemainingMs;
      this.nextSpawnAt = now + FIRST_SPAWN_DELAY_MS;
      this.state = 'PLAYING';
    }
    timeProgress(now) {
      if (!isTimed(this.activeSettings)) return 0;
      let elapsed;
      switch (this.state) {
        case 'PLAYING': elapsed = now - this.roundStartedAt; break;
        case 'PAUSED': elapsed = this.pausedElapsedMs; break;
        case 'GAME_OVER': elapsed = durationMs(this.activeSettings); break;
        default: elapsed = 0;
      }
      return Math.min(1, Math.max(0, elapsed / durationMs(this.activeSettings)));
    }
    remainingMs(now) {
      if (!isTimed(this.activeSettings)) return Infinity;
      switch (this.state) {
        case 'PLAYING': return Math.max(0, this.roundEndsAt - now);
        case 'PAUSED': return Math.max(0, this.pausedRemainingMs);
        case 'GAME_OVER': return 0;
        default: return durationMs(this.activeSettings);
      }
    }
    currentRadius(now) {
      const shrink = 1 - (1 - END_SHRINK) * this.timeProgress(now);
      return Math.max(this.minRadius, this.fullRadius * shrink);
    }
    tick(now) {
      if (this.state !== 'PLAYING') return [];
      const events = [];
      if (isTimed(this.activeSettings) && now >= this.roundEndsAt) {
        this.circle = null; this.state = 'GAME_OVER';
        events.push({ type: 'roundEnded' });
        return events;
      }
      const c = this.circle;
      if (c && now - c.shownAt >= c.lifetimeMs) {
        this.circle = null; this.nextSpawnAt = now + GAP_MS; this.score -= MISS_POINTS;
        events.push({ type: 'vanished', x: c.x, y: c.y, points: -MISS_POINTS });
      }
      if (!this.circle && now >= this.nextSpawnAt) this.spawn(now);
      return events;
    }
    tap(x, y, now) {
      if (this.state !== 'PLAYING') return null;
      const c = this.circle;
      if (c) {
        const r = this.currentRadius(now);
        const tolerance = r + Math.max(r * 0.15, this.hitPadding);
        if (Math.hypot(x - c.x, y - c.y) <= tolerance) {
          this.hits++;
          const d = this.difficulty();
          this.lifetimeMs = Math.max(d.minLifetimeMs, d.startLifetimeMs - this.hits * d.lifetimeStepMs);
          this.circle = null; this.nextSpawnAt = now + GAP_MS; this.score += HIT_POINTS;
          return { type: 'hit', x, y, points: HIT_POINTS };
        }
      }
      if (y > this.hudHeight) {
        this.score -= MISS_POINTS;
        return { type: 'miss', x, y, points: -MISS_POINTS };
      }
      return null;
    }
    spawn(now) {
      const margin = this.fullRadius * 1.4;
      const left = margin, right = this.width - margin, top = this.hudHeight + margin, bottom = this.height - margin;
      if (right <= left || bottom <= top) return;
      let u, v, tries = 0;
      do {
        u = this.random.nextFloat(); v = this.random.nextFloat(); tries++;
      } while (tries < 12 && !Number.isNaN(this.lastU) &&
        f(Math.sqrt(f(f(f(u - this.lastU) * f(u - this.lastU)) + f(f(v - this.lastV) * f(v - this.lastV))))) < f(MIN_SPAWN_DISTANCE));
      this.lastU = u; this.lastV = v;
      this.hue = f(f(f(this.hue + f(47)) + f(this.random.nextFloat() * f(40))) % f(360));
      this.circle = { x: left + u * (right - left), y: top + v * (bottom - top), shownAt: now, lifetimeMs: this.lifetimeMs, hue: this.hue };
    }
  }

  const api = { XorWow, kotlinRandom, GameEngine, DIFFICULTIES, DURATION_OPTIONS, isTimed,
    GAP_MS, FIRST_SPAWN_DELAY_MS, END_SHRINK, MIN_SPAWN_DISTANCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TapEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
