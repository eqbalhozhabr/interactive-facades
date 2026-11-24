# Facade Kit

Standalone interactive building facade: swappable renders, clickable unit shapes with details tooltip (desktop) or
sheet (touch), video transitions between views that can also be scrubbed by dragging. No build step, no dependencies.
Reference project: `armas`. Full notes (Persian): `FACADE-SESSION-NOTES.md`. Working rules for new projects: `CLAUDE.md`.

```
node tools/serve.mjs 5173      # http://localhost:5173/#/armas
```

- `js/facade.js` the whole viewer (`new Facade(root, project, features).init()`), `js/main.js` hash router, `css/facade.css` styles.
- `projects/projects.json` config; `projects/<id>/{units.json,data.json,assets/}` per project.
- `tools/` `sprites-to-video.mjs` (sprite sheet -> mp4, needs ffmpeg), `extract-units.mjs` (SVG shapes -> units.json),
  `sync-sheets.mjs` (Google Sheet CSV -> data.json), `serve.mjs` (static server with Range support).
- `features.tours: false` removes the tour button; `features.back: {href, label}` adds a back link.
- Embed: `<iframe src="<host-path>/index.html#/armas" style="width:100%;height:80vh;border:0" allow="fullscreen"></iframe>`
