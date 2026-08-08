/* Web-Slinger — DOM HUD (the Apex 26 pattern: write-cached setters so a
   ~10 Hz tick with mostly-steady values costs nothing; quantise anything fed
   to a setter or the cache buys nothing). */
const _txt = new WeakMap();
const hText = (el, v) => { if (el && _txt.get(el) !== v) { _txt.set(el, v); el.textContent = v; } };

export function createHud(els) {
  let gate = 0;
  return {
    update(hero, force) {
      if (!force && --gate > 0) return;
      gate = 6;   // ~10 Hz at 60 fps
      hText(els.speed, String(Math.round(hero.speed * 3.6)));
      hText(els.alt, Math.round(hero.p[1]) + " m");
      hText(els.mode, hero.state);
    },
    show(on) { els.hud.hidden = !on; },
    /* Named track, shown briefly on change. Not on the update() path — it
       fires on a track boundary, which is minutes apart, so it costs nothing
       to write straight through. */
    setTrack(t) {
      if (!els.track) return;
      els.track.hidden = !t;
      if (t) hText(els.trackV, t.title);
    },
  };
}
