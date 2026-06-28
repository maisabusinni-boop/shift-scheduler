# Department Shift Scheduler

Hebrew RTL department roster app. The current system is a static React/Vite Chrome PWA in `webapp/`, with Google Apps Script in `Code.gs` acting as the shared backend for login, Drive JSON storage, snapshot upload, and optional Calendar sync.

The app no longer uses a Google Sheet as the source of truth. The shared source of truth is the visible Drive JSON file `department-shift-scheduler.json`.

## Current Architecture

- `webapp/`: browser app, installable as a Chrome/PWA window.
- `Code.gs`: Apps Script web app API proxy deployed as the backend.
- `department-shift-scheduler.json`: shared Drive database file created or opened by the backend.
- GitHub Pages workflow: builds and deploys the static app from `webapp/dist`.

## Active Role Model

The webapp role list in `webapp/src/domain.ts` is canonical. The backend default workspace in `Code.gs` uses the same eight active schedule roles:

| Code | Hebrew label | Eligibility |
| --- | --- | --- |
| `resident-on-call` | `תורן` | residents only |
| `senior-a` | `כונן א` | seniors only |
| `senior-b` | `כונן ב` | seniors only |
| `angio` | `כונן אנגיו` | doctors marked as Angio |
| `half-resident` | `תורן חצי מתמחה` | residents first, then seniors |
| `half-senior` | `תורן חצי מומחה` | seniors first, then residents |
| `friday-morning-resident` | `שישי בוקר מתמחה` | residents only, Fridays only |
| `friday-morning-senior` | `שישי בוקר מומחה` | seniors only, Fridays only |

For `אילוצים`, the app intentionally shows a smaller blocking list. `כונן א` and `כונן ב` are represented by one `כונן` blocker, and `שישי בוקר מומחה` is covered by that same senior on-call blocker because it is linked to the Friday senior assignment.

## Backend Setup

1. Open Google Apps Script.
2. Paste the contents of `Code.gs`.
3. Deploy as a Web App.
4. Use these deployment settings:
   - Execute as: the owner/admin account.
   - Who has access: Anyone.
5. Copy the Web App `/exec` URL.
6. In the PWA login screen, open the advanced URL field and paste that URL if it differs from the bundled default.

The first successful bootstrap creates the first `senior-planner` user. After that, only the senior planner manages doctors, users, roles, and passwords from inside the app.

## Webapp Development

```bash
cd webapp
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

Before pushing or deploying:

```bash
cd webapp
npm run deploy:check
```

This runs typecheck, tests, and the production build.

## Main Workflows

- Senior planner bootstraps the first account.
- Planner adds doctors and creates users with app roles.
- Draft schedules can be edited by the senior planner and chief resident.
- Published schedules are visible to regular doctors.
- Published schedule swaps can be started from the published roster.
- Direct swaps by permitted users create audit entries and Drive snapshot images.
- Other swaps become structured change requests for review.
- Autosave sends schedule changes to the Apps Script backend after local edits.
- Apps Script preserves server-side user credentials when saving workspace data.
- Calendar sync runs server-side for planner/chief saves when a calendar ID is configured.

## Concurrent-use backend

The production workspace schema is version 3. Browser edits are sent as small, idempotent mutation batches rather than replacing the complete Drive JSON file. Apps Script locks only the short read/validate/write section, rejects stale changes to the same target, and accepts unrelated changes in the same batch. Login and load requests are lock-free.

Before deploying the v2 backend API:

1. Run `createDatabaseBackup` once in the Apps Script editor and retain the returned Drive file ID.
2. Deploy the current `Code.gs` as a new Web App version.
3. Run `installCalendarSyncTrigger` once as the script owner; confirm exactly one one-minute trigger exists.
4. Leave the `ALLOW_LEGACY_WRITES` Script Property absent or set to `false` so stale PWAs cannot replace the workspace.
5. Set `ALLOW_TEST_DATA=true` only in a non-production deployment if the test-data command is needed.

Calendar synchronization is marked pending by relevant mutations and runs outside the database lock. The browser makes a best-effort kick after a save, while the one-minute trigger provides recovery and retries.

There is no built-in `admin` login. The first bootstrap user is the senior planner. For owner recovery, set temporary `RECOVERY_USERNAME` and `RECOVERY_PASSWORD_HASH` Script Properties, run `recoverSeniorPlannerPassword`, and confirm that the function removed both temporary properties.

## Validation Rules

- `תורן`: residents only.
- `כונן א` and `כונן ב`: seniors only.
- `כונן אנגיו`: Angio-enabled doctors only.
- `תורן חצי מתמחה`: residents before seniors.
- `תורן חצי מומחה`: seniors before residents.
- `שישי בוקר מתמחה`: residents only and Friday-only.
- The same doctor cannot appear twice on the same day.
- `תורן` and `תורן חצי מומחה` cannot repeat the same doctor on consecutive days.
- Consecutive `תורן חצי מתמחה` assignments are warnings for manual review.
- Friday `כונן א`, Friday `שישי בוקר מומחה`, and the following Saturday `תורן חצי מומחה` are linked.

## Useful Files

- `webapp/src/domain.ts`: canonical schedule roles and eligibility helpers.
- `webapp/src/migration.ts`: workspace normalization.
- `webapp/src/permissions.ts`: role permissions.
- `webapp/src/validation.ts`: schedule validation.
- `webapp/src/googleDrive.ts`: browser API client for Apps Script.
- `Code.gs`: Apps Script backend implementation.
