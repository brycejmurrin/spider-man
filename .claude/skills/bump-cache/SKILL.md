---
name: bump-cache
description: Use when JS or CSS changed, index.html's import map or module list changed, the user says bump the version or cache bust, stale GitHub Pages / browser / PWA cache is suspected, or a Web-Slinger asset change needs a new ?v=N and version.json build.
---

# Bump the cache-busting version

There is no build step, so nothing renames a file when its contents change.
Browsers cache by full URL, and the service worker caches by generation, so a
shipped change that keeps the same URL is a change returning players never see.

This repo has a wrinkle a classic script-tag project does not: **an import
specifier is a static string inside a module.** Bumping the entry's `?v=` does
not reach `js/render/glx.js`, because `js/game.js` asks for `"./render/glx.js"`
by name. That is what the import map in `index.html` is for — it remaps every
module to itself with the build appended, so one bump busts the whole graph.

This is the single most-forgotten step in the repo.

## When to run

Run it when you changed anything under `js/` or `css/`, or changed the module
list, the import map or the modulepreload links in `index.html`.

You do **not** need to bump if you touched only `docs/`, `tests/`, `tools/`, or
markup in `index.html` that carries no `?v=`.

Never bump while a Playwright run is in flight: the shell version guard sees a
newer `version.json` and force-reloads every open test page. Bump as the **last**
edit before the commit.

## Steps

1. Read the current build — take the MAX, not the first match:

```sh
grep -o '?v=[0-9]\+' index.html | sed 's/?v=//' | sort -n | tail -1
```

2. Rewrite every occurrence to that number plus one, and set `version.json` to
   the same value (replace `NEW` in both):

```sh
sed -i -E 's/\?v=[0-9]+/?v=NEW/g' index.html
echo '{ "build": NEW }' > version.json
```

3. Verify. The grep must print **exactly one line**, and it must match
   `version.json`:

```sh
grep -o '?v=[0-9]\+' index.html | sort -u && cat version.json
```

4. Let the test prove it, since it checks more than the grep does — that the
   import map covers the module graph, that every target is its own key plus the
   build, and that the modulepreload links point at the mapped URLs:

```sh
node --test tests/unit/load-order.test.mjs
```

## Notes

- Bump by exactly +1 per logical change set, not per file edited.
- On a merge conflict, resolve to `max(both) + 1` in **both** files. Taking one
  side leaves the two out of step, and the shell guard will then reload forever
  or never.
- Adding a module means three edits in `index.html` — the import-map entry, the
  modulepreload link — plus its `MODULES` entry in `tools/manifest.cjs`. The
  load-order test fails on any one of them being missing, and names which.
- `window.__SPIDEY_BUILD` is parsed from the stylesheet `?v=` at runtime. Do not
  replace it with a literal: the `sed` above would not touch it, and it would
  silently drift behind on the error overlay.
