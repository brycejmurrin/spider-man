# docs

Three tiers. Know which one you are reading.

## Engineering reference — how the game works today

Read these before touching the subsystem they describe.

| Doc | Covers |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | The working reference: commands, conventions, file map, the dev API. Start here. |
| [`PLAN.md`](PLAN.md) | Why this project exists, what shipped, the phased roadmap, and the sources behind the design numbers. |
| [`TESTING.md`](TESTING.md) | Every suite, how to run them, and the three rules the browser half obeys. |

## Research — design notes still cited from source or from CLAUDE.md

Nothing here yet. The rule that keeps this tier honest: a research note stays
only while something in the code or in `CLAUDE.md` cites it. A note indexed by
nothing gets archived, because a document nobody reaches is a document nobody
maintains — and it will quietly stop being true.

## Archive — finished plans, kept for provenance

Nothing here yet. **Never read the archive for current structure.** It records
what was true when it was written, which is exactly what makes it useless as a
guide and valuable as a record.

---

Two conventions worth stating once:

**Numbers carry their measurement.** Where a comment in the code or a value in
these docs says "measured", the number came from a run, and the run is named.
A tuning constant without a reason is a constant nobody can safely change.

**Rules carry their failure.** Most of the rules in `CLAUDE.md` exist because
something broke in a specific, hard-to-reproduce way. The failure is recorded
with the rule so a future reader can tell a real constraint from a superstition.
