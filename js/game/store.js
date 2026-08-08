/* Web-Slinger — cached localStorage wrapper (the Apex 26 store: reads through
   an in-memory Map so hot paths never re-parse; writes cache even when disk
   throws — iOS Private Browsing has a ZERO quota, and dropping the value would
   break the session as well as the save; `broken` records the failure so it
   is testable instead of silent). Keys all prefixed `spidey.`. */
export const store = {
  _cache: new Map(),
  rev: 0,
  broken: null,
  get(k, d) {
    const key = "spidey." + k;
    if (this._cache.has(key)) return this._cache.get(key);
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      const v = raw == null ? d : JSON.parse(raw);
      this._cache.set(key, v);
      return v;
    } catch (e) {
      if (!this.broken) this.broken = (e && e.name) || "Error";
      return d;
    }
  },
  set(k, v) {
    const key = "spidey." + k;
    try { localStorage.setItem(key, JSON.stringify(v)); }
    catch (e) { if (!this.broken) this.broken = (e && e.name) || "Error"; }
    this._cache.set(key, v);   // cache regardless — see header
    this.rev++;
  },
};
