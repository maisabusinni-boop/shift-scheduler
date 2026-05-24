# Department Shift Scheduler Chrome App

Static Hebrew RTL scheduling app that runs in Chrome. The app uses username/password login through the Google Apps Script backend, browser storage for fast local work, and one visible Google Drive JSON file as the shared workspace.

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

For a final shared build, serve the `dist/` folder from a stable static origin, then install it from Chrome. The browser app calls the deployed Apps Script backend, so Drive and Calendar permissions are controlled by the Apps Script deployment owner rather than by a browser OAuth client.

## What is implemented

- Chrome-only React/Vite app with no server, Prisma, or database service.
- PWA manifest, icons, service worker, and install prompt support.
- Polished Sheet-like RTL roster board with the current eight active roster roles and colors.
- Username/password login through the Apps Script backend.
- Practical app roles: resident, senior, chief resident, senior planner.
- Senior-planner bootstrap for the first signed-in user.
- Role-separated tabs and action permissions.
- Structured mid-month change requests.
- Append-only audit trail for schedule, request, user, Drive, and Calendar actions.
- Local browser persistence.
- Manual Google Drive sync to a visible JSON file.
- Multi-date scheduler-entered exclusions.
- Doctors and role management.
- Validation, review, draft/publish, publish snapshots.
- Calendar settings and browser-side dry-run/mock sync payloads.
- JSON and CSV export/import.

## Apps Script backend and Drive setup

The app is preconfigured with an Apps Script Web App URL in `src/googleDrive.ts`. If you deploy a new backend, paste the new `/exec` URL into the advanced URL field on the login screen.

The first successful bootstrap creates the senior planner account. After that, the senior planner adds users, assigns app roles, links users to doctors, and sets passwords.

The browser talks only to Apps Script. Apps Script owns the Drive file access, stores the shared `department-shift-scheduler.json` file, uploads swap snapshot images, and runs optional Calendar sync.
