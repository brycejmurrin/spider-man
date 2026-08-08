/* Web-Slinger — WebAudio: wind loop scaled by speed, web thwip, landing
   thump, UI click. The minimal subset of Apex 26's audio.js, keeping the
   parts its header calls non-negotiable: init() only from a user gesture,
   persistent resume listeners (iOS suspends and never self-resumes), never
   tear the context down on a timer, and the blip()/noise() synth primitives
   every one-shot composes from.

   The soundtrack is deliberately NOT in the WebAudio graph. A
   MediaElementSource would put an 8 MB stream behind the same suspended
   context the synth sits behind, so a browser that blocks the context blocks
   the music too — and it would decode the whole file into memory instead of
   streaming it. Plain <audio> elements stream, seek and survive a suspended
   context, at the cost of one extra volume knob to keep in step. */
import { store } from "./store.js";

let ctx = null, master = null, sfxBus = null;
let windSrc = null, windGain = null, windLp = null;
let enabled = store.get("sound", true);

function createCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = enabled ? 0.8 : 0;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 1;
    sfxBus.connect(master);
    return true;
  } catch (_) { return false; }
}

function resumeIfNeeded() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

const now = () => ctx.currentTime;
const sfxOk = () => ctx && enabled;

function env(g, t0, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function blip(freq, type, peak, attack, decay, slideTo, when) {
  if (!sfxOk()) return;
  const t0 = now() + (when || 0);
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + attack + decay);
  env(g, t0, peak, attack, decay);
  osc.connect(g).connect(sfxBus);
  osc.start(t0); osc.stop(t0 + attack + decay + 0.05);
  osc.onended = () => { osc.disconnect(); g.disconnect(); };
}

let _noiseBuf = null;
function noiseBuf() {
  if (_noiseBuf) return _noiseBuf;
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (_noiseBuf = b);
}

function noise(peak, decay, filterFreq, when) {
  if (!sfxOk()) return;
  const t0 = now() + (when || 0);
  const src = ctx.createBufferSource(); src.buffer = noiseBuf();
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filterFreq;
  const g = ctx.createGain();
  env(g, t0, peak, 0.005, decay);
  src.connect(f).connect(g).connect(sfxBus);
  src.start(t0); src.stop(t0 + decay + 0.1);
  src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
}

/* ── soundtrack ─────────────────────────────────────────────────────────────
   Streamed <audio>, one element per track so the next one is already buffered
   when the current ends. `preload="none"` on all but the first: three tracks
   at 192 kbps is 17 MB, and fetching all of it during boot competes with the
   asset pack for the same connection. */
const TRACKS = [
  { id: "webslinger1", src: "assets/music/webslinger1.mp3", title: "Webslinger I" },
  { id: "webslinger2", src: "assets/music/webslinger2.mp3", title: "Webslinger II" },
  { id: "webslinger-ps", src: "assets/music/webslinger-ps.mp3", title: "Webslinger (PS)" },
];

let els = null, cur = 0, musicOn = store.get("music", true);
let musicVol = store.get("musicVol", 0.55);
let onTrack = null;   // driver hook, so the HUD can name the track

function musicEls() {
  if (els) return els;
  els = TRACKS.map((t, i) => {
    const a = new Audio();
    a.src = t.src;
    a.preload = i === 0 ? "auto" : "none";
    a.volume = 0;                        // faded in by applyMusicVol
    a.addEventListener("ended", () => GameAudio.nextTrack());
    // A missing/undecodable file must not take the game with it: skip on.
    a.addEventListener("error", () => { if (i === cur) GameAudio.nextTrack(); });
    return a;
  });
  return els;
}

function applyMusicVol() {
  if (!els) return;
  els.forEach((a, i) => { a.volume = i === cur && musicOn ? musicVol : 0; });
}

export const GameAudio = {
  init() {   // ONLY from a user gesture
    if (ctx) { resumeIfNeeded(); return; }
    if (!createCtx()) return;
    window.addEventListener("touchend", resumeIfNeeded, true);
    window.addEventListener("pointerdown", resumeIfNeeded, true);
    window.addEventListener("keydown", resumeIfNeeded, true);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeIfNeeded(); });
  },
  setEnabled(on) {
    enabled = on; store.set("sound", on);
    if (master) master.gain.setTargetAtTime(on ? 0.8 : 0, ctx ? now() : 0, 0.05);
  },
  get enabled() { return enabled; },

  // ── soundtrack ───────────────────────────────────────────────────────────
  /* startMusic() — ONLY from a user gesture, same as init(). play() rejects
     outside one, and an unhandled rejection here would surface as a page
     error in the smoke spec. */
  startMusic() {
    if (!musicOn) return false;
    const a = musicEls()[cur];
    if (!a) return false;
    a.preload = "auto";
    applyMusicVol();
    a.play().catch(() => {});   // blocked autoplay is not an error worth raising
    if (onTrack) onTrack(TRACKS[cur]);
    return true;
  },
  nextTrack() {
    if (!els) return null;
    const prev = els[cur];
    try { prev.pause(); prev.currentTime = 0; } catch (_) {}
    cur = (cur + 1) % TRACKS.length;
    const a = els[cur];
    a.preload = "auto";
    applyMusicVol();
    if (musicOn) a.play().catch(() => {});
    if (onTrack) onTrack(TRACKS[cur]);
    return TRACKS[cur];
  },
  setMusic(on) {
    musicOn = on; store.set("music", on);
    if (!els) { if (on) GameAudio.startMusic(); return musicOn; }
    applyMusicVol();
    if (on) els[cur].play().catch(() => {}); else els[cur].pause();
    if (onTrack) onTrack(on ? TRACKS[cur] : null);
    return musicOn;
  },
  setMusicVol(v) {
    musicVol = Math.max(0, Math.min(1, v));
    store.set("musicVol", musicVol);
    applyMusicVol();
    return musicVol;
  },
  get music() { return musicOn; },
  get musicVol() { return musicVol; },
  get track() { return musicOn && els ? TRACKS[cur] : null; },
  onTrackChange(fn) { onTrack = fn; },

  /* wind loop, driven by speed01 every frame — loudens AND brightens */
  setWind(speed01) {
    if (!sfxOk()) { if (windGain) windGain.gain.value = 0; return; }
    if (!windSrc) {
      windSrc = ctx.createBufferSource(); windSrc.buffer = noiseBuf(); windSrc.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 120;
      windLp = ctx.createBiquadFilter(); windLp.type = "lowpass"; windLp.frequency.value = 800;
      windGain = ctx.createGain(); windGain.gain.value = 0;
      windSrc.connect(hp).connect(windLp).connect(windGain).connect(sfxBus);
      windSrc.start();
    }
    const s = Math.max(0, Math.min(1, speed01));
    windGain.gain.setTargetAtTime(s * s * 0.4, now(), 0.15);
    windLp.frequency.setTargetAtTime(600 + s * 4200, now(), 0.2);
  },

  thwip() {   // bandpass sweep 4000 -> 600 Hz + a short saw drop
    if (!sfxOk()) return;
    const t0 = now();
    const src = ctx.createBufferSource(); src.buffer = noiseBuf();
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 2.5;
    f.frequency.setValueAtTime(4000, t0);
    f.frequency.exponentialRampToValueAtTime(600, t0 + 0.12);
    const g = ctx.createGain(); env(g, t0, 0.3, 0.005, 0.12);
    src.connect(f).connect(g).connect(sfxBus);
    src.start(t0); src.stop(t0 + 0.25);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    blip(1200, "sawtooth", 0.08, 0.005, 0.1, 400);
  },
  land(hard01) {   // the collision thump: 150 -> 45 Hz slide + filtered noise
    blip(150, "sine", 0.1 + 0.24 * hard01, 0.005, 0.25, 45);
    noise(0.08 + 0.18 * hard01, 0.18, 900);
  },
  uiTick() { blip(660, "square", 0.08, 0.004, 0.05); },
  uiSelect() { blip(880, "square", 0.13, 0.005, 0.09); },
};
