# Gym Tracker

A personal, phone-first gym tracker. No accounts, no subscriptions, no server to run —
your data lives on your device and (optionally) syncs to your own **private GitHub repo**
so it follows you across phone + laptop.

Three modes:

- **Build** — your exercise library (add anything custom) + workouts you arrange (Push, Pull, …), with a set count per exercise.
- **Train** — tap a workout, punch in weight × reps per set. Last session's numbers are pre-filled as ghost text so you just beat them.
- **Progress** — volume per 8-day cycle, PRs (heaviest + estimated 1RM), a graph per exercise, and full history. *(Friend comparison lands here in v2.)*

Works offline, installs to your home screen like a real app.

---

## Run it locally

It's plain static files — no build step.

```bash
cd gym-tracker
python3 -m http.server 8000
```

Open http://localhost:8000. (You can also just double-click `index.html`, but the home-screen install + offline cache only kick in when it's served over http/https.)

---

## Put it online (free) — GitHub Pages

1. Create a repo (can be public — there are **no secrets in the code**) and push these files to it.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. Wait ~1 min. Your app is live at `https://<you>.github.io/<repo>/`.
4. Open it on your phone → Share → **Add to Home Screen**.

Point a custom domain at it later from that same Pages screen whenever you buy one.

> Alternatives that also work with zero config: Cloudflare Pages, Netlify. Drag-and-drop the folder.

---

## Cross-device sync (optional) — your private data repo

This keeps your log on **your** GitHub, synced across every device you sign in on.

1. Create a **private** repo, e.g. `gym-data` (this is separate from the app code repo).
2. Create a **fine-grained personal access token**:
   GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new.
   - **Repository access:** Only select repositories → `gym-data`.
   - **Permissions → Repository → Contents: Read and write.**
   - Copy the `github_pat_…` token.
3. In the app → **Settings → GitHub sync**, fill:
   - Owner = your GitHub username · Repo = `gym-data` · Your name = e.g. `mobashir` · Branch = `main`
   - Paste the token (it's stored **only on this device**, never in the code, and only ever talks to GitHub's own API).
4. Tap **Push to cloud**. On another device, enter the same details and tap **Pull from cloud**.

After that it auto-pushes a few seconds after each saved workout. Every push is a git commit, so you get a **full history/backup for free**.

### Later: the 3-person compare (v2)
Have all three of you sync into the **same** private `gym-data` repo (add your 2 friends as collaborators), each with your own file (`mobashir.json`, etc.). The Progress "compare" view will read all three. That's the only change needed — the data model already separates users by file.

---

## Notes

- **Units / cycle:** set in Settings. The 8-day cycle is a calendar window from a start date you choose; "volume per cycle" is total lifting tonnage (weight × reps) in each window. Change the length if 8 ever changes.
- **Data:** Settings → Export / Import JSON for manual backups or moving data between the preview and your hosted copy.
- **Extending it:** everything is in `app.js`, organized as `state → lookups/math → render<Mode> → events`. Charts are hand-rolled SVG in `lineChart` / `barChart` (no dependencies). Data shape:
  ```
  exercises[] · workouts[] (items: {exerciseId, sets}) · sessions[] (entries: {exerciseId, sets:[{weight,reps}]})
  ```

## Files
```
index.html   app shell + bottom nav
styles.css   mobile-first dark theme
app.js       all logic (3 modes, cycle math, charts, GitHub sync)
sw.js        service worker (offline cache; skips localhost in dev)
manifest.webmanifest   home-screen install
icons/icon.svg
```
