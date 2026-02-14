# Deploy Guide

## Important
This project has a Node.js server (`server.js`) for room state and sync.
So GitHub Pages **alone** cannot run the full game.

Use this setup:
- Frontend: GitHub Pages (`public/`)
- Backend API: Render (or Railway/Fly.io) running `server.js`

## 1) Deploy Backend (Render)
1. Push this repo to GitHub.
2. Create a new **Web Service** on Render from this repo.
3. Settings:
   - Runtime: `Node`
   - Build Command: (empty)
   - Start Command: `npm start`
4. Deploy and copy backend URL, e.g. `https://amber-review-api.onrender.com`

## 2) Connect Frontend to Backend
Edit `public/config.js`:

```js
window.__API_BASE_URL__ = "https://YOUR_BACKEND_URL";
```

Example:

```js
window.__API_BASE_URL__ = "https://amber-review-api.onrender.com";
```

## 3) Publish Frontend on GitHub Pages
1. Push changes.
2. In GitHub repo: `Settings` -> `Pages`
3. Source: `Deploy from a branch`
4. Branch: `main` (or `master`), folder: `/public`
5. Save and wait for publish.

## Notes
- `public/index.html` uses relative asset paths, so it works under `/repo-name/` on GitHub Pages.
- API CORS is enabled in `server.js` for cross-origin calls from GitHub Pages.
