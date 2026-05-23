# Deploy the Scheduler PWA to GitHub Pages

This app is now a static Chrome/PWA app. GitHub Pages can host it for free.

## 1. Create the GitHub repository

Create a GitHub repo, for example:

```text
shift-scheduler
```

Then from this project folder:

```powershell
git remote add origin https://github.com/YOUR_USERNAME/shift-scheduler.git
git add .
git commit -m "Build Chrome-only scheduler PWA"
git push -u origin master
```

If your default branch is `main`, rename before pushing:

```powershell
git branch -M main
git push -u origin main
```

## 2. Enable GitHub Pages

In GitHub:

1. Open the repo.
2. Go to **Settings > Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Push to `master` or `main`, or run the workflow manually.

The workflow is:

```text
.github/workflows/deploy-pages.yml
```

It installs dependencies, typechecks, runs tests, builds `webapp/dist`, and deploys it to Pages.

## 3. Open the app

After the workflow finishes, GitHub Pages gives a URL like:

```text
https://YOUR_USERNAME.github.io/shift-scheduler/
```

Open that URL in Chrome.

## 4. Install as a Chrome app icon

In the scheduler:

1. Go to **Dashboard**.
2. Click **התקן כאייקון Chrome**.
3. If Chrome does not show the prompt, use Chrome menu > **Install app**.

It will open as a standalone Chrome app window from a desktop/start-menu icon.

## 5. Configure Google login and Drive sync

Create a Google OAuth Web Client ID in Google Cloud Console and add this authorized JavaScript origin:

```text
https://YOUR_USERNAME.github.io
```

The deployed app is preconfigured with this Google OAuth Web Client ID:

```text
264155836518-nqcoltph397ta3ua8hpemsegk3v5o5ck.apps.googleusercontent.com
```

Connect with Google from the app login bar.

The first signed-in Google user can click the bootstrap button to become the initial **senior planner**. After that, the senior planner adds residents, seniors, and the chief resident by Google email inside **רופאים ומשתמשים**.

Use **צור קובץ** to create the shared `department-shift-scheduler.json` file, or **פתח** to open an existing Drive file by URL/ID.

## Notes

- The app data lives in browser storage plus the visible shared Google Drive JSON file.
- User roles are practical app-level permissions based on Google email. They are not backend-grade security rules.
- Every meaningful edit is written to the app audit log with user, time, device, before, and after data.
- GitHub Pages hosts only static app files. It does not see schedule data.
- Google Calendar sync is currently dry-run/mock-ready in the app and can be wired to real Calendar writes later.
