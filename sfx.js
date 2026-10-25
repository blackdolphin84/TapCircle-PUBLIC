/* Tap Circle – synthesized sound effects with the Web Audio API (no audio files). */
(function (root) {
  'use strict';
  let ctx = null;
  let enabled = true;

  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /* Plays one note: a wave at freq (or a frequency sweep) with a decaying envelope. */
  function note(c, { type, from, to, start, dur, peak, decay }) {
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.008);
    if (decay) gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    else { gain.gain.setValueAtTime(peak, start + dur - 0.01); gain.gain.linearRampToValueAtTime(0.0001, start + dur); }
    osc.connect(gain).connect(c.destination);
    osc.start(start); osc.stop(start + dur + 0.02);
  }

  const Sfx = {
    setEnabled(v) { enabled = !!v; },
    /* Must be called from a user gesture once, so mobile browsers allow audio. */
    unlock() { const c = context(); if (c && c.state === 'suspended') c.resume().catch(() => {}); },
    hit() {
      if (!enabled) return; const c = context(); if (!c) return; const t = c.currentTime;
      note(c, { type: 'square', from: 988, start: t, dur: 0.07, peak: 0.18, decay: false });
      note(c, { type: 'square', from: 1319, start: t + 0.07, dur: 0.2, peak: 0.18, decay: true });
    },
    miss() {
      if (!enabled) return; const c = context(); if (!c) return; const t = c.currentTime;
      note(c, { type: 'sawtooth', from: 330, to: 140, start: t, dur: 0.32, peak: 0.16, decay: true });
      note(c, { type: 'square', from: 333, to: 141, start: t, dur: 0.32, peak: 0.08, decay: true });
    },
    tick() {
      if (!enabled) return; const c = context(); if (!c) return;
      note(c, { type: 'sine', from: 440, start: c.currentTime, dur: 0.1, peak: 0.35, decay: true });
    },
    go() {
      if (!enabled) return; const c = context(); if (!c) return; const t = c.currentTime;
      note(c, { type: 'sine', from: 880, start: t, dur: 0.3, peak: 0.3, decay: true });
      note(c, { type: 'sine', from: 1760, start: t, dur: 0.3, peak: 0.1, decay: true });
    },
    end() {
      if (!enabled) return; const c = context(); if (!c) return; const t = c.currentTime;
      [[523.25, 0], [659.25, 0.14], [783.99, 0.28]].forEach(([f, o]) =>
        note(c, { type: 'triangle', from: f, start: t + o, dur: 0.14, peak: 0.3, decay: false }));
      note(c, { type: 'triangle', from: 1046.5, start: t + 0.42, dur: 0.45, peak: 0.32, decay: true });
    },
  };
  root.TapSfx = Sfx;
})(window);
