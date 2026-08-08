/* Web-Slinger — WebAudio: wind loop scaled by speed, web thwip, landing
   thump, UI click. The minimal subset of Apex 26's audio.js, keeping the
   parts its header calls non-negotiable: init() only from a user gesture,
   persistent resume listeners (iOS suspends and never self-resumes), never
   tear the context down on a timer, and the blip()/noise() synth primitives
   every one-shot composes from. */
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
