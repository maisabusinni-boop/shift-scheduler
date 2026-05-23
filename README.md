# Hebrew Sheets-Master Calendar-Viewer Sync

This folder contains a Google Apps Script implementation for a Hebrew RTL department roster where the Google Sheet is the source of truth and Google Calendar is a read-only viewer.

## Install

1. Open the roster Google Sheet.
2. Go to **Extensions > Apps Script**.
3. Paste the contents of `Code.gs` into the Apps Script editor.
4. Replace `PUT_CALENDAR_ID_HERE` in `CONFIG.CALENDAR_ID` with the shared calendar ID.
   - Alternatively, set a Script Property named `CALENDAR_ID`.
5. Save the script and reload the Google Sheet.
6. Use **סנכרון תורנויות > הגדר / תקן תבנית**.
7. Open **סנכרון תורנויות > פתח לוח בקרה** to use the sidebar actions, or use the new `Dashboard` tab as the app-like home screen.
8. Fill `_Doctors` with doctor names:
   - Column A: `מתמחים`
   - Column B: `בכירים`
   - Column C: `כונני אנגיו`
   - Column D: `כל הרופאים`, rebuilt automatically
   - Column E: `מתמחים ואז בכירים`, rebuilt automatically
   - Column F: `בכירים ואז מתמחים`, rebuilt automatically
9. Use **סנכרון תורנויות > צור חודש חדש** to create each monthly roster.
10. Build the monthly schedule while `G1` is `טיוטה`.
11. Use **פרסם חודש נוכחי** when the month is ready. Publishing runs validation first and refuses hard errors.
12. Run **סנכרון תורנויות > סנכרן את החודש הנוכחי** or **סנכרן חודשים שפורסמו**.
13. Use **התקן סנכרון שעתי** after testing with a test calendar.

## Dashboard and Sidebar

The script creates a visible `Dashboard` tab as the first sheet. It is a status and command surface, not a data table:

- Shows the active month, draft/published state, validation state, issue counts, matching exceptions tab, and last sync time.
- Uses large action cells as a visual launcher map. Actual script execution happens from the custom menu or sidebar.
- Keeps `_Doctors` visible for admin input while `_RoleConfig` and `_SyncState` remain hidden/protected.

Use **סנכרון תורנויות > פתח לוח בקרה** to open the sidebar. The sidebar provides guided buttons for setup/repair, create month, validate, publish/unpublish, sync, open exceptions, open doctors, and jump back to the dashboard.

The sidebar is optimized for speed:

- Status loads from the last saved validation result instead of rescanning the whole month.
- Editing the roster or exceptions marks the month as `צריך בדיקה` rather than repainting every rule result immediately.
- Use **בדוק וסמן בעיות** to run the full validation pass and paint issues on the sheet.
- The issue list in the sidebar shows the latest saved errors/warnings; click an issue to jump to its cell.
- Doctors can add exception blocks from the sidebar form without editing the exceptions grid directly.
- The exception form includes a compact month calendar; doctors can select multiple dates before submitting one block.

## Monthly Sheet Layout

The visible monthly tab uses this structure:

```text
A1: חודש          B1: <month number>
C1: שנה           D1: <year>
F1: סטטוס סנכרון  G1: טיוטה or פורסם

Row 3:
תאריך | יום | תורן | כונן א | כונן ב | כונן אנגיו | תורן חצי מתמחה | תורן חצי מומחה | שישי בוקר מתמחה | שישי בוקר מומחה
```

Data starts on row 4.

The monthly board is RTL and limited to 31 schedule rows, so it always looks like a month. Short months leave the extra bottom rows greyed out.
Because there are eight role columns, roles occupy columns C through J.

Use **צור חודש חדש** to create a new tab such as `2026-06`. The script fills the correct dates and Hebrew day letters automatically. If you manually change `B1` or `D1`, use **רענן תאריכי חודש** to regenerate the date/day columns without touching doctor assignments.

If an existing sheet still has the old English role headers, **הגדר / תקן תבנית** migrates the assignment columns into the new Hebrew order before replacing the headers. If an existing Hebrew sheet has one old `שישי בוקר` column, its data is moved into `שישי בוקר מומחה`.

## Monthly Exceptions

When a new monthly roster is created, the script also creates a visible tab named `Exceptions YYYY-MM`.
Doctors use that tab before scheduling starts:

- Columns A-B contain the same date/day rows as the roster.
- Columns C-J contain the same role headers as the roster.
- Row 2 contains a doctor-facing instruction banner.
- A name in a role/date cell means that doctor must not be assigned to that role on that date.
- Multiple doctors can be entered in the same cell, one name per line.
- To block a full day, enter the doctor name in every active role column for that date.

The exceptions tab is not synced to Google Calendar. During rule checks and calendar sync, the matching roster tab treats exception conflicts as hard errors. Misspelled doctor names in the exceptions tab are also marked red and must match `_Doctors`.

## Assignment Rules

Use **סנכרון תורנויות > בדוק כללי שיבוץ** before publishing.
For responsiveness, edits now mark the month as needing a fresh check; the full rule check and cell painting run when you choose **בדוק כללי שיבוץ**, **בדוק וסמן בעיות**, or **פרסם חודש נוכחי**.
Errors are marked red; warnings are marked yellow.
Error/warning colors are intentionally prominent and bold. Non-Friday rows in the two Friday morning columns are disabled: their dropdowns are removed and typed/pasted values are cleared.

- Column C `תורן`: residents only.
- Columns D/E `כונן א` / `כונן ב`: seniors only.
- Column F `כונן אנגיו`: only doctors listed in `_Doctors` column C.
- Column G `תורן חצי מתמחה`: dropdown shows residents first, then seniors.
- Column H `תורן חצי מומחה`: dropdown shows seniors first, then residents.
- Column I `שישי בוקר מתמחה`: residents only.
- Column J `שישי בוקר מומחה`: seniors only.
- Residents are blocked from any role outside C/G/H/I.
- The same doctor cannot appear twice on the same day, except the allowed Friday senior link below.
- Columns C and H cannot repeat the same doctor two days in a row.
- Column G consecutive repeats are marked as warnings for manual approval.
- Friday `כונן א`, Friday `שישי בוקר מומחה`, and the following Saturday `תורן חצי מומחה` are linked.
- Editing any one of those three cells autofills the other two.
- Clearing one linked cell clears the whole linked trio.

## Sync Rules

- Only sheets with `G1 = פורסם` sync to Calendar.
- Each filled role cell becomes one all-day Calendar event.
- Event title format: `<Role> | <Doctor>`.
- Blank cells and `Pending` / `ממתין` / `טרם שובץ` / `לא שובץ` cells produce no Calendar event.
- If a previous event exists and the cell becomes blank or `Pending`, the event is deleted.
- Event IDs are stored in the hidden `_SyncState` tab.
- Calendar edits are not synced back to the Sheet.

## Test Checklist

- Draft month creates no events.
- Published month creates all-day events for each filled role.
- Searching Calendar for a doctor name finds that doctor's role events.
- Re-running sync creates no duplicates.
- Changing a doctor updates the existing event.
- Clearing a role deletes the event.
- Marking a role `Pending` deletes the event.
- `Dashboard` exists as the first tab after setup/repair.
- `פתח לוח בקרה` opens the sidebar and shows current status.
- `פרסם חודש נוכחי` refuses hard validation errors and colors `G1` as published only when allowed.
