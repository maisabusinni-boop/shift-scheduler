# Department Shift Scheduler Chrome App

Static Hebrew RTL scheduling app that runs entirely in Chrome. The app uses browser storage for fast local work and can sync the canonical workspace JSON file to a visible Google Drive file.

## Run for development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

## Build static files

```bash
npm run build
```

The static bundle is written to `dist/`.

## GitHub Pages deploy check

Before pushing:

```bash
npm run deploy:check
```

The repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml`. Enable **Settings > Pages > Build and deployment > GitHub Actions** in the GitHub repo, then push to `master` or `main`.

## Install as a Chrome icon

During development:

1. Run `npm run dev`.
2. Open `http://127.0.0.1:3000`.
3. Use the Dashboard button **התקן כאייקון Chrome**, or open Chrome's menu and choose **Install app** / **Create shortcut**.
4. Enable **Open as window** if Chrome asks.

After installation, the scheduler opens from a desktop/start-menu icon like an app window. Internally it is still Chrome, but users do not need to interact with a visible URL.

For a final shared build, serve the `dist/` folder from a stable static origin, then install it from Chrome. Google Drive OAuth works best from an `http://localhost`, `http://127.0.0.1`, or `https://...` origin that is listed in the Google OAuth client settings.

For GitHub Pages, add this origin to the Google OAuth Web Client:

```text
https://YOUR_USERNAME.github.io
```

## What is implemented

- Chrome-only React/Vite app with no server, Prisma, or database service.
- PWA manifest, icons, service worker, and install prompt support.
- Polished Sheet-like RTL roster board with the same eight roles and colors.
- Local browser persistence.
- Manual Google Drive sync to a visible JSON file.
- Multi-date scheduler-entered exclusions.
- Doctors and role management.
- Validation, review, draft/publish, publish snapshots.
- Calendar settings and browser-side dry-run/mock sync payloads.
- JSON and CSV export/import.

## Google Drive setup

Create a Google OAuth Web Client ID and add the app origin, such as `http://127.0.0.1:3000`, to authorized JavaScript origins. Paste that Client ID in the Drive Sync tab, connect, then create or open the shared `department-shift-scheduler.json` file.

The app requests Drive file access from the browser. For a shared department workflow, keep the JSON file visible in a shared Drive folder.
