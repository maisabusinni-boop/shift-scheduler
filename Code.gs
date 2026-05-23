/**
 * Sheets-master / Calendar-viewer sync for monthly doctor schedules.
 *
 * Install this as a Google Apps Script bound to the roster spreadsheet.
 * Set CONFIG.CALENDAR_ID below, or set a Script Property named CALENDAR_ID.
 */
var CONFIG = {
  VERSION: '2026-05-23.2-grouped-doctor-dropdowns',
  CALENDAR_ID: 'a0764444469f4ba71501b677f3c9de456ce849061213e777d8fe56a0a8e06634@group.calendar.google.com',
  CALENDAR_ID_PROPERTY: 'CALENDAR_ID',
  DASHBOARD_SHEET: 'Dashboard',
  EXCEPTIONS_PREFIX: 'Exceptions ',
  DROPDOWN_HELPER_PREFIX: '_DoctorDropdowns ',
  DROPDOWN_CONSTRAINTS_LABEL: '━━ אילוצים ━━',
  MENU_NAME: 'סנכרון תורנויות',
  PUBLISHED_CELL: 'G1',
  PUBLISHED_VALUE: 'פורסם',
  PUBLISHED_VALUES: ['פורסם', 'published'],
  DRAFT_VALUE: 'טיוטה',
  DATA_START_ROW: 4,
  HEADER_ROW: 3,
  DATE_COLUMN: 1,
  DAY_COLUMN: 2,
  MONTH_DAY_ROWS: 31,
  SUPPORT_SHEETS: {
    DOCTORS: '_Doctors',
    ROLE_CONFIG: '_RoleConfig',
    SYNC_STATE: '_SyncState'
  },
  DOCTOR_HEADERS: ['מתמחים', 'בכירים', 'כונני אנגיו', 'כל הרופאים', 'מתמחים ואז בכירים', 'בכירים ואז מתמחים'],
  ROLE_CONFIG_HEADERS: ['תפקיד', 'שם כותרת', 'צבע ביומן'],
  SYNC_STATE_HEADERS: [
    'Key',
    'Sheet Name',
    'Date',
    'Role',
    'Doctor',
    'Event ID',
    'Last Hash',
    'Last Synced At'
  ],
  DEFAULT_ROLES: [
    ['תורן', 'תורן', 'Red'],
    ['כונן א', 'כונן א', 'Blue'],
    ['כונן ב', 'כונן ב', 'Green'],
    ['כונן אנגיו', 'כונן אנגיו', 'Yellow'],
    ['תורן חצי מתמחה', 'תורן חצי מתמחה', 'Orange'],
    ['תורן חצי מומחה', 'תורן חצי מומחה', 'Purple'],
    ['שישי בוקר מתמחה', 'שישי בוקר מתמחה', 'Gray'],
    ['שישי בוקר מומחה', 'שישי בוקר מומחה', 'Gray']
  ],
  PENDING_VALUES: ['pending', 'pending assignment', 'ממתין', 'טרם שובץ', 'לא שובץ']
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(CONFIG.MENU_NAME)
    .addItem('פתח לוח בקרה', 'openDashboardSidebar')
    .addSeparator()
    .addItem('סנכרן חודשים שפורסמו', 'syncPublishedSchedules')
    .addItem('סנכרן את החודש הנוכחי', 'syncCurrentSheet')
    .addSeparator()
    .addItem('צור חודש חדש', 'createNewMonth')
    .addItem('רענן תאריכי חודש', 'refreshMonthDates')
    .addItem('בדוק כללי שיבוץ', 'checkCurrentSheetRules')
    .addItem('פרסם חודש נוכחי', 'publishCurrentSheet')
    .addItem('החזר חודש לטיוטה', 'unpublishCurrentSheet')
    .addItem('פתח גיליון חריגים', 'openMatchingExceptionsSheet')
    .addItem('פתח רשימת רופאים', 'openDoctorsSheet')
    .addItem('הגדר / תקן תבנית', 'setupOrRepairTemplate')
    .addItem('עצב מחדש את הגיליון', 'restyleCurrentSheet')
    .addItem('התקן סנכרון שעתי', 'installHourlySync')
    .addToUi();
}

function onEdit(e) {
  if (!e || !e.range) {
    return;
  }

  var range = e.range;
  var sheet = range.getSheet();
  if (isExceptionsSheet_(sheet)) {
    if (!intersectsScheduleBody_(range)) {
      return;
    }

    var exceptionsLock = LockService.getScriptLock();
    if (!exceptionsLock.tryLock(5000)) {
      return;
    }

    try {
      clearDisabledFridayMorningEdit_(range);
      var matchingSchedule = getScheduleSheetForExceptions_(SpreadsheetApp.getActiveSpreadsheet(), sheet);
      if (matchingSchedule) {
        applyDoctorValidation_(SpreadsheetApp.getActiveSpreadsheet(), matchingSchedule);
        markValidationStale_(matchingSchedule.getName(), 'נערכו חריגים');
        refreshDashboardStatus_(SpreadsheetApp.getActiveSpreadsheet(), matchingSchedule);
      }
    } finally {
      exceptionsLock.releaseLock();
    }
    return;
  }

  if (!isScheduleSheet_(sheet)) {
    return;
  }

  var row = range.getRow();
  var column = range.getColumn();
  if (!intersectsScheduleBody_(range)) {
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return;
  }

    try {
      clearDisabledFridayMorningEdit_(range);
      if (range.getNumRows() === 1 && range.getNumColumns() === 1 && clearBlockedDoctorDropdownSelection_(sheet, row, column)) {
        markValidationStale_(sheet.getName(), 'נבחר רופא חסום');
        refreshDashboardStatus_(SpreadsheetApp.getActiveSpreadsheet(), sheet);
        return;
      }
      if (range.getNumRows() === 1 && range.getNumColumns() === 1 && [4, 8, 10].indexOf(column) !== -1) {
        syncLinkedFridaySeniorAssignment_(sheet, row, column);
      }
    markValidationStale_(sheet.getName(), 'נערך שיבוץ');
    refreshDashboardStatus_(SpreadsheetApp.getActiveSpreadsheet(), sheet);
  } finally {
    lock.releaseLock();
  }
}

function syncPublishedSchedules() {
  return withScriptLock_(function() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureSupportSheets_(ss);

    var calendar = getCalendar_();
    var roleConfigs = getRoleConfigs_(ss);
    var state = readSyncState_(ss);
    var summary = createSummary_();

    ss.getSheets().forEach(function(sheet) {
      if (!isScheduleSheet_(sheet) || !isPublished_(sheet)) {
        return;
      }
      syncSheet_(sheet, calendar, roleConfigs, state, summary);
    });
    deleteEventsForUnpublishedOrDeletedSheets_(ss, calendar, state, summary);

    writeSyncState_(ss, state);
    refreshDashboardStatus_(ss, ss.getActiveSheet());
    Logger.log(formatSummary_(summary));
    return summary;
  });
}

function syncCurrentSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui = SpreadsheetApp.getUi();

  if (!isScheduleSheet_(sheet)) {
    ui.alert('פתח/י לשונית חודשית לפני סנכרון החודש הנוכחי.');
    return;
  }

  if (false && !isPublished_(sheet)) {
    ui.alert('הגיליון עדיין בטיוטה. יש להגדיר את ' + CONFIG.PUBLISHED_CELL + ' ל"פורסם" לפני סנכרון.');
    return;
  }

  var summary = withScriptLock_(function() {
    ensureSupportSheets_(ss);
    var calendar = getCalendar_();
    var roleConfigs = getRoleConfigs_(ss);
    var state = readSyncState_(ss);
    var localSummary = createSummary_();

    if (isPublished_(sheet)) {
      syncSheet_(sheet, calendar, roleConfigs, state, localSummary);
    } else {
      deleteOrphansForSheet_(calendar, state, sheet.getName(), {}, localSummary);
    }
    writeSyncState_(ss, state);
    refreshDashboardStatus_(ss, sheet);
    Logger.log(formatSummary_(localSummary));
    return localSummary;
  });

  ui.alert(formatSummary_(summary));
}

function setupOrRepairTemplate(showAlert) {
  showAlert = showAlert !== false;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSupportSheets_(ss);
  var startedAt = new Date().getTime();
  var maxRuntimeMs = 270000;
  var activeSheet = ss.getActiveSheet();

  var scheduleSheets = ss.getSheets().filter(function(sheet) {
    return isScheduleSheet_(sheet);
  });

  if (!scheduleSheets.length) {
    scheduleSheets.push(createMonthlyScheduleSheet_(ss, getCurrentYearMonth_(ss)));
  }

  scheduleSheets.sort(function(first, second) {
    if (first.getName() === activeSheet.getName()) {
      return -1;
    }
    if (second.getName() === activeSheet.getName()) {
      return 1;
    }
    return first.getName() < second.getName() ? -1 : 1;
  });

  var processedCount = 0;
  for (var i = 0; i < scheduleSheets.length; i++) {
    if (new Date().getTime() - startedAt > maxRuntimeMs) {
      Logger.log('Setup stopped early after ' + processedCount + ' of ' + scheduleSheets.length + ' monthly sheets. Run setup again to continue.');
      break;
    }
    var sheet = scheduleSheets[i];
    setupMonthlySheet_(ss, sheet, { populateDatesIfEmpty: true });
    setupMonthlyExceptionsSheet_(ss, ensureMonthlyExceptionsSheet_(ss, sheet), { populateDatesIfEmpty: true });
    processedCount++;
  }

  ss.setActiveSheet(scheduleSheets[0]);
  hideSupportSheets_(ss);
  protectSupportSheets_(ss);
  ensureDashboardSheet_(ss);
  refreshDashboardStatus_(ss, scheduleSheets[0]);
  if (processedCount < scheduleSheets.length) {
    if (showAlert) {
      alertUser_('Setup processed ' + processedCount + ' of ' + scheduleSheets.length + ' monthly sheets before the safe time limit. Run setup again to continue.');
    }
    return;
  }
  if (showAlert) {
    alertUser_(
      'התבנית הוגדרה.\n\n' +
      'הצעדים הבאים:\n' +
      '1. מלא/י את _Doctors בשמות הרופאים הפעילים.\n' +
      '2. הגדר/י את מזהה היומן ב-CONFIG.CALENDAR_ID או ב-Script Properties.\n' +
      '3. כשהסידור מוכן, שנה/י את סטטוס החודש ל"פורסם".'
    );
  }
}

function createNewMonth() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  ensureSupportSheets_(ss);

  var nextMonth = inferNextMonth_(ss);
  var defaultText = formatYearMonthText_(nextMonth.year, nextMonth.month);
  var response = ui.prompt(
    'יצירת חודש חדש',
    'הכנס/י חודש בפורמט YYYY-MM. החודש הבא המוצע: ' + defaultText,
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var yearMonth = parseYearMonthInput_(response.getResponseText() || defaultText);
  if (!yearMonth) {
    ui.alert('יש להשתמש בפורמט YYYY-MM, לדוגמה 2026-06.');
    return;
  }

  var sheet = createMonthlyScheduleSheet_(ss, yearMonth);
  setupMonthlySheet_(ss, sheet, { populateDates: true });
  setupMonthlyExceptionsSheet_(ss, ensureMonthlyExceptionsSheet_(ss, sheet), { populateDates: true });
  markValidationStale_(sheet.getName(), 'חודש חדש נוצר');
  ss.setActiveSheet(sheet);
  hideSupportSheets_(ss);
  ensureDashboardSheet_(ss);
  refreshDashboardStatus_(ss, sheet);
  ui.alert('נוצר חודש ' + sheet.getName() + ' כטיוטה, עם התאריכים הנכונים.');
}

function restyleCurrentSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    SpreadsheetApp.getUi().alert('פתח/י לשונית חודשית לפני עיצוב מחדש.');
    return;
  }

  formatMonthlySheet_(sheet);
  refreshDashboardStatus_(SpreadsheetApp.getActiveSpreadsheet(), sheet);
  SpreadsheetApp.getUi().alert('הגיליון עוצב מחדש לפי תבנית v' + CONFIG.VERSION + '.');
}

function refreshMonthDates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    SpreadsheetApp.getUi().alert('פתח/י לשונית חודשית לפני רענון תאריכים.');
    return;
  }

  ensureMonthYearCells_(ss, sheet);
  populateMonthDates_(ss, sheet);
  formatMonthlySheet_(sheet);
  refreshDashboardStatus_(ss, sheet);
  SpreadsheetApp.getUi().alert('התאריכים רועננו עבור ' + sheet.getName() + '.');
}

function checkCurrentSheetRules() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    SpreadsheetApp.getUi().alert('פתח/י לשונית חודשית לפני בדיקת כללי השיבוץ.');
    return;
  }

  var result = validateScheduleRules_(ss, sheet, true);
  cacheValidationResult_(ss, sheet, result);
  refreshDashboardStatus_(ss, sheet);
  if (!result.errors.length && !result.warnings.length) {
    SpreadsheetApp.getUi().alert('הבדיקה הסתיימה: לא נמצאו חריגות.');
    return;
  }

  var message = [];
  if (result.errors.length) {
    message.push('שגיאות שחוסמות סנכרון:');
    message = message.concat(result.errors.slice(0, 12));
  }
  if (result.warnings.length) {
    if (message.length) {
      message.push('');
    }
    message.push('אזהרות לבדיקה ידנית:');
    message = message.concat(result.warnings.slice(0, 12));
  }
  if (result.errors.length + result.warnings.length > 24) {
    message.push('');
    message.push('מוצגות רק 24 החריגות הראשונות. תאים מסומנים בגיליון.');
  }

  SpreadsheetApp.getUi().alert(message.join('\n'));
}

function openDashboardSidebar() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.DASHBOARD_SHEET)) {
    ensureDashboardSheet_(ss);
  }
  refreshDashboardStatus_(ss, ss.getActiveSheet());

  var html = HtmlService
    .createHtmlOutput(buildDashboardSidebarHtml_())
    .setTitle('לוח בקרה');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getDashboardSidebarState() {
  return getDashboardState_(SpreadsheetApp.getActiveSpreadsheet(), SpreadsheetApp.getActiveSheet(), true);
}

function sidebarSetupOrRepair() {
  setupOrRepairTemplate(false);
  return {
    state: getDashboardSidebarState(),
    message: 'התבנית עודכנה. Dashboard, חודשים וחריגים רועננו.'
  };
}

function sidebarCreateNewMonth() {
  var result = createNextMonthFromSidebar_();
  return {
    state: getDashboardSidebarState(),
    message: result.message
  };
}

function sidebarValidateCurrentSheet() {
  var result = validateCurrentSheetForAction_(false);
  return {
    state: getDashboardSidebarState(),
    message: result.message
  };
}

function sidebarPublishCurrentSheet() {
  var result = publishCurrentSheet_(false);
  return {
    state: getDashboardSidebarState(),
    message: result.message
  };
}

function sidebarUnpublishCurrentSheet() {
  var result = unpublishCurrentSheet_(false);
  return {
    state: getDashboardSidebarState(),
    message: result.message
  };
}

function sidebarSyncPublishedSchedules() {
  var summary = syncPublishedSchedules();
  return {
    state: getDashboardSidebarState(),
    message: formatSummary_(summary)
  };
}

function sidebarOpenMatchingExceptionsSheet() {
  openMatchingExceptionsSheet();
  return {
    state: getDashboardSidebarState(),
    message: 'נפתח גיליון החריגים.'
  };
}

function sidebarOpenDoctorsSheet() {
  openDoctorsSheet();
  return {
    state: getDashboardSidebarState(),
    message: 'נפתחה רשימת הרופאים.'
  };
}

function sidebarOpenDashboardSheet() {
  openDashboardSheet();
  return {
    state: getDashboardSidebarState(),
    message: 'נפתח לוח הבקרה.'
  };
}

function sidebarSelectMonth(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || !isScheduleSheet_(sheet)) {
    throw new Error('לא נמצא חודש בשם ' + sheetName + '.');
  }
  ss.setActiveSheet(sheet);
  refreshDashboardStatus_(ss, sheet);
  return getDashboardSidebarState();
}

function sidebarJumpToCell(sheetName, a1Notation) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || !isScheduleSheet_(sheet)) {
    throw new Error('לא נמצא גיליון יעד.');
  }
  ss.setActiveSheet(sheet);
  if (a1Notation) {
    sheet.setActiveRange(sheet.getRange(a1Notation));
  }
  return getDashboardSidebarState();
}

function sidebarSubmitException(payload) {
  var result = submitDoctorException_(payload || {});
  return {
    state: getDashboardSidebarState(),
    message: result.message
  };
}

function publishCurrentSheet() {
  publishCurrentSheet_(true);
}

function unpublishCurrentSheet() {
  unpublishCurrentSheet_(true);
}

function openDashboardSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dashboard = ss.getSheetByName(CONFIG.DASHBOARD_SHEET) || ensureDashboardSheet_(ss);
  dashboard.showSheet();
  refreshDashboardStatus_(ss, ss.getActiveSheet());
  ss.setActiveSheet(dashboard);
}

function openDoctorsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSupportSheets_(ss);
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('לא נמצא גיליון _Doctors.');
    return;
  }
  sheet.showSheet();
  ss.setActiveSheet(sheet);
  refreshDashboardStatus_(ss, sheet);
}

function openMatchingExceptionsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var activeSheet = ss.getActiveSheet();
  var scheduleSheet = isScheduleSheet_(activeSheet) ?
    activeSheet :
    (isExceptionsSheet_(activeSheet) ? getScheduleSheetForExceptions_(ss, activeSheet) : getDashboardTargetScheduleSheet_(ss, activeSheet));

  if (!scheduleSheet) {
    SpreadsheetApp.getUi().alert('לא נמצא חודש פעיל לפתיחת גיליון חריגים.');
    return;
  }

  var exceptionsSheet = ensureMonthlyExceptionsSheet_(ss, scheduleSheet);
  setupMonthlyExceptionsSheet_(ss, exceptionsSheet, { populateDatesIfEmpty: true });
  ss.setActiveSheet(exceptionsSheet);
  applyDoctorValidation_(ss, scheduleSheet);
  refreshDashboardStatus_(ss, scheduleSheet);
}

function publishCurrentSheet_(showAlert) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    var notScheduleMessage = 'פתח/י לשונית חודשית לפני פרסום.';
    if (showAlert) {
      SpreadsheetApp.getUi().alert(notScheduleMessage);
    }
    return { message: notScheduleMessage };
  }

  var result = validateScheduleRules_(ss, sheet, true);
  cacheValidationResult_(ss, sheet, result);
  if (result.errors.length) {
    var blockedMessage = 'לא ניתן לפרסם: נמצאו ' + result.errors.length + ' שגיאות שחוסמות סנכרון.\n\n' +
      result.errors.slice(0, 10).join('\n');
    refreshDashboardStatus_(ss, sheet);
    if (showAlert) {
      SpreadsheetApp.getUi().alert(blockedMessage);
    }
    return {
      message: blockedMessage,
      errors: result.errors,
      warnings: result.warnings
    };
  }

  sheet.getRange(CONFIG.PUBLISHED_CELL).setValue(CONFIG.PUBLISHED_VALUE);
  formatPublishStatusCell_(sheet);
  refreshDashboardStatus_(ss, sheet);
  var message = result.warnings.length ?
    'החודש פורסם עם ' + result.warnings.length + ' אזהרות לבדיקה ידנית.' :
    'החודש פורסם ומוכן לסנכרון.';
  if (showAlert) {
    SpreadsheetApp.getUi().alert(message);
  }
  return {
    message: message,
    errors: result.errors,
    warnings: result.warnings
  };
}

function unpublishCurrentSheet_(showAlert) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    var notScheduleMessage = 'פתח/י לשונית חודשית לפני החזרה לטיוטה.';
    if (showAlert) {
      SpreadsheetApp.getUi().alert(notScheduleMessage);
    }
    return { message: notScheduleMessage };
  }

  sheet.getRange(CONFIG.PUBLISHED_CELL).setValue(CONFIG.DRAFT_VALUE);
  formatPublishStatusCell_(sheet);
  refreshDashboardStatus_(ss, sheet);
  var message = 'החודש הוחזר לטיוטה. בסנכרון הבא אירועים קיימים לחודש הזה יימחקו מהיומן.';
  if (showAlert) {
    SpreadsheetApp.getUi().alert(message);
  }
  return { message: message };
}

function validateCurrentSheetForAction_(showAlert) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!isScheduleSheet_(sheet)) {
    var notScheduleMessage = 'פתח/י לשונית חודשית לפני בדיקת כללי השיבוץ.';
    if (showAlert) {
      SpreadsheetApp.getUi().alert(notScheduleMessage);
    }
    return { message: notScheduleMessage };
  }

  var result = validateScheduleRules_(ss, sheet, true);
  cacheValidationResult_(ss, sheet, result);
  refreshDashboardStatus_(ss, sheet);
  var message = formatValidationMessage_(result);
  if (showAlert) {
    SpreadsheetApp.getUi().alert(message);
  }
  return {
    message: message,
    errors: result.errors,
    warnings: result.warnings
  };
}

function intersectsScheduleBody_(range) {
  var startRow = range.getRow();
  var endRow = range.getLastRow();
  var startColumn = range.getColumn();
  var endColumn = range.getLastColumn();
  var scheduleStartRow = CONFIG.DATA_START_ROW;
  var scheduleEndRow = CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS - 1;

  return endRow >= scheduleStartRow &&
    startRow <= scheduleEndRow &&
    endColumn >= 3 &&
    startColumn <= 10;
}

function clearDisabledFridayMorningEdit_(range) {
  var sheet = range.getSheet();
  var startRow = Math.max(range.getRow(), CONFIG.DATA_START_ROW);
  var endRow = Math.min(range.getLastRow(), CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS - 1);
  var startColumn = Math.max(range.getColumn(), 9);
  var endColumn = Math.min(range.getLastColumn(), 10);
  var cleared = false;

  if (startColumn > endColumn || startRow > endRow) {
    return false;
  }

  for (var row = startRow; row <= endRow; row++) {
    var date = parseScheduleDate_(sheet.getRange(row, CONFIG.DATE_COLUMN).getValue());
    if (date && date.getDay() === 5) {
      continue;
    }

    sheet.getRange(row, startColumn, 1, endColumn - startColumn + 1).clearContent();
    cleared = true;
  }

  return cleared;
}

function clearBlockedDoctorDropdownSelection_(sheet, row, column) {
  if (row < CONFIG.DATA_START_ROW ||
      row >= CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS ||
      column < 3 ||
      column > 10) {
    return false;
  }

  var selectedDoctor = normalizeCellText_(sheet.getRange(row, column).getValue());
  if (!selectedDoctor) {
    return false;
  }

  if (selectedDoctor === CONFIG.DROPDOWN_CONSTRAINTS_LABEL || selectedDoctor === 'אילוצים') {
    sheet.getRange(row, column).clearContent();
    SpreadsheetApp.getActiveSpreadsheet().toast('אילוצים היא כותרת בלבד, לא שיבוץ.', 'בחירת רופא', 5);
    return true;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var date = parseScheduleDate_(sheet.getRange(row, CONFIG.DATE_COLUMN).getValue());
  if (!date) {
    return false;
  }

  var doctors = getDoctorSets_(ss);
  var exceptions = readMatchingExceptions_(ss, sheet, doctors, { errors: [], warnings: [] }, false);
  var dateKey = formatDateKey_(date, ss.getSpreadsheetTimeZone());
  var entry = exceptions.blocked[dateKey + '|' + column];
  if (!entry || !entry.names[normalizeDoctorKey_(selectedDoctor)]) {
    return false;
  }

  sheet.getRange(row, column).clearContent();
  SpreadsheetApp.getActiveSpreadsheet().toast('הרופא/ה חסום/ה בתאריך ובתפקיד הזה.', 'בחירת רופא', 5);
  return true;
}

function syncLinkedFridaySeniorAssignment_(sheet, editedRow, editedColumn) {
  var date = parseScheduleDate_(sheet.getRange(editedRow, CONFIG.DATE_COLUMN).getValue());
  if (!date) {
    return;
  }

  var fridayRow = null;
  var saturdayRow = null;
  if (date.getDay() === 5 && (editedColumn === 4 || editedColumn === 10)) {
    fridayRow = editedRow;
    saturdayRow = editedRow + 1;
  } else if (date.getDay() === 6 && editedColumn === 8) {
    fridayRow = editedRow - 1;
    saturdayRow = editedRow;
  } else {
    return;
  }

  if (!isLinkedFridaySaturdayPair_(sheet, fridayRow, saturdayRow)) {
    return;
  }

  var editedValue = normalizeCellText_(sheet.getRange(editedRow, editedColumn).getValue());
  var valueToApply = isPendingValue_(editedValue) ? '' : editedValue;

  sheet.getRange(fridayRow, 4).setValue(valueToApply);
  sheet.getRange(fridayRow, 10).setValue(valueToApply);
  sheet.getRange(saturdayRow, 8).setValue(valueToApply);
}

function isLinkedFridaySaturdayPair_(sheet, fridayRow, saturdayRow) {
  if (fridayRow < CONFIG.DATA_START_ROW ||
    saturdayRow < CONFIG.DATA_START_ROW ||
    saturdayRow >= CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS) {
    return false;
  }

  var fridayDate = parseScheduleDate_(sheet.getRange(fridayRow, CONFIG.DATE_COLUMN).getValue());
  var saturdayDate = parseScheduleDate_(sheet.getRange(saturdayRow, CONFIG.DATE_COLUMN).getValue());
  if (!fridayDate || !saturdayDate) {
    return false;
  }

  return fridayDate.getDay() === 5 &&
    saturdayDate.getDay() === 6 &&
    daysBetween_(fridayDate, saturdayDate) === 1;
}

function daysBetween_(firstDate, secondDate) {
  var first = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate()).getTime();
  var second = new Date(secondDate.getFullYear(), secondDate.getMonth(), secondDate.getDate()).getTime();
  return Math.round((second - first) / 86400000);
}

function validateScheduleRules_(ss, sheet, markCells) {
  refreshDoctorHelperColumns_(ss);
  if (markCells) {
    clearRuleMarks_(sheet);
  }

  var doctors = getDoctorSets_(ss);
  var values = sheet.getRange(CONFIG.DATA_START_ROW, 1, CONFIG.MONTH_DAY_ROWS, 10).getValues();
  var result = {
    errors: [],
    warnings: []
  };
  var previousByColumn = {};
  var exceptions = readMatchingExceptions_(ss, sheet, doctors, result, markCells);
  var timeZone = ss.getSpreadsheetTimeZone();

  values.forEach(function(row, index) {
    var rowNumber = CONFIG.DATA_START_ROW + index;
    var date = parseScheduleDate_(row[CONFIG.DATE_COLUMN - 1]);
    if (!date) {
      return;
    }

    var seenToday = {};
    for (var column = 3; column <= 10; column++) {
      var doctor = normalizeCellText_(row[column - 1]);
      if (!doctor || isPendingValue_(doctor)) {
        previousByColumn[column] = '';
        continue;
      }

      var key = normalizeDoctorKey_(doctor);
      var cell = columnToLetter_(column) + rowNumber;
      var exceptionEntry = exceptions.blocked[formatDateKey_(date, timeZone) + '|' + column];

      if (!doctors.all[key]) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': רופא/ה לא מופיע/ה ברשימת _Doctors.', markCells);
      }

      if (exceptionEntry && exceptionEntry.names[key]) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': Doctor is blocked for this date/role in ' + exceptions.sheetName + '!' + columnToLetter_(column) + exceptionEntry.row + '.', markCells);
      }

      if (seenToday[key] && !isAllowedSameDayDuplicate_(seenToday[key], column)) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': אותו רופא/ה משובץ/ת יותר מפעם אחת באותו יום.', markCells);
        addRuleIssue_(sheet, result, 'errors', rowNumber, seenToday[key], columnToLetter_(seenToday[key]) + rowNumber + ': אותו רופא/ה משובץ/ת יותר מפעם אחת באותו יום.', markCells);
      } else {
        seenToday[key] = column;
      }

      if (doctors.residents[key] && [3, 7, 8, 9].indexOf(column) === -1) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': מתמחים מותרים רק בעמודות C, G, H, I.', markCells);
      }

      if ((column === 3 || column === 9) && !doctors.residents[key]) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': עמודה זו מיועדת למתמחים בלבד.', markCells);
      }

      if ((column === 4 || column === 5 || column === 10) && !doctors.seniors[key]) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': עמודה זו מיועדת לבכירים בלבד.', markCells);
      }

      if (column === 6 && !doctors.angio[key]) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': כונן אנגיו חייב להופיע בעמודת כונני אנגיו ב-_Doctors.', markCells);
      }

      if ((column === 3 || column === 8) && previousByColumn[column] === key) {
        addRuleIssue_(sheet, result, 'errors', rowNumber, column, cell + ': אסור לשבץ אותו רופא/ה יומיים ברצף בעמודה זו.', markCells);
      }

      if (column === 7 && previousByColumn[column] === key) {
        addRuleIssue_(sheet, result, 'warnings', rowNumber, column, cell + ': שיבוץ רצוף בעמודה G דורש אישור חריג.', markCells);
      }

      previousByColumn[column] = key;
    }
  });

  validateFridaySeniorLinks_(sheet, values, result, markCells);

  return result;
}

function validateExceptionsSheet_(ss, exceptionsSheet, markCells) {
  refreshDoctorHelperColumns_(ss);
  var result = {
    errors: [],
    warnings: []
  };
  var doctors = getDoctorSets_(ss);
  readExceptionsSheet_(ss, exceptionsSheet, doctors, result, markCells);
  return result;
}

function readMatchingExceptions_(ss, scheduleSheet, doctors, result, markCells) {
  var exceptionsSheet = getMatchingExceptionsSheet_(ss, scheduleSheet);
  if (!exceptionsSheet) {
    return {
      sheetName: '',
      blocked: {}
    };
  }

  return readExceptionsSheet_(ss, exceptionsSheet, doctors, result, markCells);
}

function readExceptionsSheet_(ss, exceptionsSheet, doctors, result, markCells) {
  if (markCells) {
    clearExceptionMarks_(exceptionsSheet);
  }

  var timeZone = ss.getSpreadsheetTimeZone();
  var values = exceptionsSheet.getRange(CONFIG.DATA_START_ROW, 1, CONFIG.MONTH_DAY_ROWS, 10).getValues();
  var exceptions = {
    sheetName: exceptionsSheet.getName(),
    blocked: {}
  };

  values.forEach(function(row, index) {
    var rowNumber = CONFIG.DATA_START_ROW + index;
    var date = parseScheduleDate_(row[CONFIG.DATE_COLUMN - 1]);
    if (!date) {
      return;
    }

    var dateKey = formatDateKey_(date, timeZone);
    for (var column = 3; column <= 10; column++) {
      var names = splitExceptionDoctorNames_(row[column - 1]);
      if (!names.length) {
        continue;
      }

      var mapKey = dateKey + '|' + column;
      if (!exceptions.blocked[mapKey]) {
        exceptions.blocked[mapKey] = {
          row: rowNumber,
          names: {}
        };
      }

      names.forEach(function(name) {
        var doctorKey = normalizeDoctorKey_(name);
        if (!doctors.all[doctorKey]) {
          addRuleIssue_(exceptionsSheet, result, 'errors', rowNumber, column, columnToLetter_(column) + rowNumber + ': Doctor is not listed in _Doctors: ' + name + '.', markCells);
          return;
        }
        exceptions.blocked[mapKey].names[doctorKey] = name;
      });
    }
  });

  return exceptions;
}

function splitExceptionDoctorNames_(value) {
  return normalizeCellText_(value)
    .split(/\r?\n/)
    .map(function(name) {
      return normalizeCellText_(name);
    })
    .filter(function(name) {
      return !!name;
    });
}

function clearExceptionMarks_(sheet) {
  sheet.getRange(CONFIG.DATA_START_ROW, 3, CONFIG.MONTH_DAY_ROWS, 8)
    .clearNote()
    .setFontColor('#0f172a')
    .setFontStyle('normal')
    .setFontWeight('normal');
  applyRoleColumnBackgrounds_(sheet, CONFIG.MONTH_DAY_ROWS);
  formatPendingAssignments_(sheet);
  disableNonFridayMorningCells_(sheet);
  shadeUnusedMonthRows_(sheet);
}

function isAllowedSameDayDuplicate_(firstColumn, secondColumn) {
  var pair = [firstColumn, secondColumn].sort(function(a, b) {
    return a - b;
  }).join('|');
  return pair === '4|10';
}

function validateFridaySeniorLinks_(sheet, values, result, markCells) {
  values.forEach(function(row, index) {
    var rowNumber = CONFIG.DATA_START_ROW + index;
    var date = parseScheduleDate_(row[CONFIG.DATE_COLUMN - 1]);
    if (!date || date.getDay() !== 5) {
      return;
    }

    var fridayConanA = normalizeCellText_(row[3]);
    var fridaySenior = normalizeCellText_(row[9]);
    var nextRow = values[index + 1];
    var nextDate = nextRow ? parseScheduleDate_(nextRow[CONFIG.DATE_COLUMN - 1]) : null;
    var saturdayHalfSenior = nextRow ? normalizeCellText_(nextRow[7]) : '';
    var linkedValues = [fridayConanA, fridaySenior, saturdayHalfSenior].filter(function(value) {
      return value && !isPendingValue_(value);
    });

    if (!linkedValues.length) {
      return;
    }

    if (!nextRow || !nextDate || nextDate.getDay() !== 6 || daysBetween_(date, nextDate) !== 1) {
      addRuleIssue_(sheet, result, 'errors', rowNumber, 10, 'J' + rowNumber + ': חסרה שורת שבת עוקבת לבדיקת הקישור בין כונן א, שישי בוקר מומחה ותורן חצי מומחה.', markCells);
      return;
    }

    var expected = normalizeDoctorKey_(linkedValues[0]);
    if (!fridayConanA || isPendingValue_(fridayConanA) || normalizeDoctorKey_(fridayConanA) !== expected) {
      addRuleIssue_(sheet, result, 'errors', rowNumber, 4, 'D' + rowNumber + ': כונן א חייב להתאים לשישי בוקר מומחה ולתורן חצי מומחה בשבת.', markCells);
    }
    if (!fridaySenior || isPendingValue_(fridaySenior) || normalizeDoctorKey_(fridaySenior) !== expected) {
      addRuleIssue_(sheet, result, 'errors', rowNumber, 10, 'J' + rowNumber + ': שישי בוקר מומחה חייב להתאים לכונן א ולתורן חצי מומחה בשבת.', markCells);
    }
    if (!saturdayHalfSenior || isPendingValue_(saturdayHalfSenior) || normalizeDoctorKey_(saturdayHalfSenior) !== expected) {
      addRuleIssue_(sheet, result, 'errors', CONFIG.DATA_START_ROW + index + 1, 8, 'H' + (CONFIG.DATA_START_ROW + index + 1) + ': תורן חצי מומחה בשבת חייב להתאים לכונן א ושישי בוקר מומחה בשישי.', markCells);
    }
  });
}

function getDoctorSets_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var sets = {
    residents: {},
    seniors: {},
    angio: {},
    all: {}
  };

  values.forEach(function(row) {
    addDoctorToSet_(sets.residents, sets.all, row[0]);
    addDoctorToSet_(sets.seniors, sets.all, row[1]);
    addDoctorToSet_(sets.angio, sets.all, row[2]);
    addDoctorToSet_(sets.all, null, row[3]);
  });

  return sets;
}

function addDoctorToSet_(primarySet, allSet, value) {
  var name = normalizeCellText_(value);
  if (!name) {
    return;
  }

  var key = normalizeDoctorKey_(name);
  primarySet[key] = true;
  if (allSet) {
    allSet[key] = true;
  }
}

function normalizeDoctorKey_(value) {
  return normalizeCellText_(value).toLowerCase();
}

function clearRuleMarks_(sheet) {
  sheet.getRange(CONFIG.DATA_START_ROW, 3, CONFIG.MONTH_DAY_ROWS, 8)
    .clearNote()
    .setFontColor('#0f172a')
    .setFontStyle('normal')
    .setFontWeight('normal');
  applyRoleColumnBackgrounds_(sheet, CONFIG.MONTH_DAY_ROWS);
  disableNonFridayMorningCells_(sheet);
  shadeUnusedMonthRows_(sheet);
}

function addRuleIssue_(sheet, result, severity, row, column, message, markCells) {
  result[severity].push(message);
  if (!markCells) {
    return;
  }

  var range = sheet.getRange(row, column);
  range
    .setBackground(severity === 'errors' ? '#f4b4b4' : '#ffd966')
    .setFontColor(severity === 'errors' ? '#7f1d1d' : '#7a4b00')
    .setFontWeight('bold');
  var note = normalizeCellText_(range.getNote());
  range.setNote(note ? note + '\n' + message : message);
}

function columnToLetter_(column) {
  var letter = '';
  while (column > 0) {
    var remainder = (column - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    column = Math.floor((column - 1) / 26);
  }
  return letter;
}

function createMonthlyScheduleSheet_(ss, yearMonth) {
  var baseName = formatYearMonthText_(yearMonth.year, yearMonth.month);
  var name = baseName;
  var counter = 2;

  while (ss.getSheetByName(name)) {
    name = baseName + ' ' + counter;
    counter++;
  }

  return ss.insertSheet(name, 0);
}

function ensureMonthlyExceptionsSheet_(ss, scheduleSheet) {
  var name = getExceptionsSheetName_(scheduleSheet.getName());
  return ss.getSheetByName(name) || ss.insertSheet(name, scheduleSheet.getIndex());
}

function getExceptionsSheetName_(scheduleSheetName) {
  return CONFIG.EXCEPTIONS_PREFIX + scheduleSheetName;
}

function getScheduleNameFromExceptionsName_(exceptionsSheetName) {
  if (exceptionsSheetName.indexOf(CONFIG.EXCEPTIONS_PREFIX) !== 0) {
    return '';
  }
  return exceptionsSheetName.substring(CONFIG.EXCEPTIONS_PREFIX.length);
}

function getMatchingExceptionsSheet_(ss, scheduleSheet) {
  return ss.getSheetByName(getExceptionsSheetName_(scheduleSheet.getName()));
}

function getScheduleSheetForExceptions_(ss, exceptionsSheet) {
  var scheduleName = getScheduleNameFromExceptionsName_(exceptionsSheet.getName());
  return scheduleName ? ss.getSheetByName(scheduleName) : null;
}

function inferNextMonth_(ss) {
  var activeSheet = ss.getActiveSheet();
  var yearMonth = (isScheduleSheet_(activeSheet) || isExceptionsSheet_(activeSheet)) ?
    getSheetYearMonth_(ss, activeSheet) :
    getCurrentYearMonth_(ss);
  var nextMonthDate = new Date(yearMonth.year, yearMonth.month, 1);
  return {
    year: nextMonthDate.getFullYear(),
    month: nextMonthDate.getMonth() + 1
  };
}

function getCurrentYearMonth_(ss) {
  var now = new Date();
  var timeZone = ss.getSpreadsheetTimeZone();
  return {
    year: Number(Utilities.formatDate(now, timeZone, 'yyyy')),
    month: Number(Utilities.formatDate(now, timeZone, 'M'))
  };
}

function getSheetYearMonth_(ss, sheet) {
  var monthValue = normalizeCellText_(sheet.getRange('B1').getValue());
  var yearValue = normalizeCellText_(sheet.getRange('D1').getValue());
  var month = parseMonthValue_(monthValue);
  var year = parseInt(yearValue, 10);

  if (month && year) {
    return {
      year: year,
      month: month
    };
  }

  return parseYearMonthInput_(sheet.getName()) || getCurrentYearMonth_(ss);
}

function parseYearMonthInput_(value) {
  var text = normalizeCellText_(value);
  var match = text.match(/(\d{4})[-\/.](\d{1,2})/);
  if (!match) {
    return null;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    return null;
  }

  return {
    year: year,
    month: month
  };
}

function parseMonthValue_(value) {
  var text = normalizeCellText_(value);
  if (!text) {
    return null;
  }

  var numeric = parseInt(text, 10);
  if (numeric >= 1 && numeric <= 12) {
    return numeric;
  }

  var lower = text.toLowerCase();
  var names = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ];
  for (var i = 0; i < names.length; i++) {
    if (names[i].indexOf(lower) === 0 || lower.indexOf(names[i]) === 0) {
      return i + 1;
    }
  }

  return null;
}

function formatYearMonthText_(year, month) {
  return year + '-' + String(month).padStart(2, '0');
}

function getDaysInMonth_(year, month) {
  return new Date(year, month, 0).getDate();
}

function installHourlySync() {
  var handler = 'syncPublishedSchedules';
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyHours(1)
    .create();

  SpreadsheetApp.getUi().alert('הותקן סנכרון שעתי לחודשים שפורסמו.');
}

function syncSheet_(sheet, calendar, roleConfigs, state, summary) {
  var timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var validation = validateScheduleRules_(SpreadsheetApp.getActiveSpreadsheet(), sheet, false);
  cacheValidationResult_(SpreadsheetApp.getActiveSpreadsheet(), sheet, validation);
  if (validation.errors.length) {
    throw new Error('נמצאו שגיאות שיבוץ ב-' + sheet.getName() + ':\n' + validation.errors.slice(0, 10).join('\n'));
  }

  var roleColumns = getRoleColumns_(sheet, roleConfigs);
  var desiredKeys = {};
  var rowCount = CONFIG.MONTH_DAY_ROWS;

  if (sheet.getLastRow() < CONFIG.DATA_START_ROW) {
    deleteOrphansForSheet_(calendar, state, sheet.getName(), desiredKeys, summary);
    return;
  }

  var width = Math.max(sheet.getLastColumn(), CONFIG.DAY_COLUMN + roleConfigs.length);
  var values = sheet
    .getRange(CONFIG.DATA_START_ROW, 1, rowCount, width)
    .getValues();

  values.forEach(function(row, rowOffset) {
    var dateValue = row[CONFIG.DATE_COLUMN - 1];
    var date = parseScheduleDate_(dateValue);
    if (!date) {
      return;
    }

    var dateKey = formatDateKey_(date, timeZone);
    roleConfigs.forEach(function(roleConfig) {
      var column = roleColumns[roleConfig.headerName];
      if (!column) {
        return;
      }

      var doctor = normalizeCellText_(row[column - 1]);
      var key = buildSyncKey_(sheet.getName(), dateKey, roleConfig.role);
      desiredKeys[key] = true;

      if (!doctor || isPendingValue_(doctor)) {
        deleteStateEvent_(calendar, state, key, summary);
        return;
      }

      var eventPayload = buildEventPayload_(sheet.getName(), dateKey, date, roleConfig, doctor, timeZone);
      upsertEvent_(calendar, state, key, eventPayload, summary);
    });
  });

  deleteOrphansForSheet_(calendar, state, sheet.getName(), desiredKeys, summary);
}

function upsertEvent_(calendar, state, key, payload, summary) {
  var record = state[key];
  var calendarEvent = null;

  if (record && record.eventId) {
    calendarEvent = getCalendarEventById_(calendar, record.eventId);
  }

  if (calendarEvent && record.lastHash === payload.hash) {
    state[key] = buildSyncStateRecord_(key, payload, calendarEvent);
    summary.unchanged++;
    return;
  }

  if (!calendarEvent) {
    calendarEvent = calendar.createAllDayEvent(payload.title, payload.date, {
      description: payload.description
    });
    summary.created++;
  } else {
    calendarEvent.setTitle(payload.title);
    calendarEvent.setDescription(payload.description);
    moveAllDayEvent_(calendarEvent, payload.date);
    summary.updated++;
  }

  if (payload.color) {
    calendarEvent.setColor(payload.color);
  }

  state[key] = buildSyncStateRecord_(key, payload, calendarEvent);
}

function buildSyncStateRecord_(key, payload, calendarEvent) {
  return {
    key: key,
    sheetName: payload.sheetName,
    dateKey: payload.dateKey,
    role: payload.role,
    doctor: payload.doctor,
    eventId: calendarEvent.getId(),
    lastHash: payload.hash,
    lastSyncedAt: new Date()
  };
}

function moveAllDayEvent_(calendarEvent, date) {
  if (typeof calendarEvent.setAllDayDate === 'function') {
    calendarEvent.setAllDayDate(date);
    return;
  }

  var nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  calendarEvent.setTime(date, nextDay);
}

function deleteOrphansForSheet_(calendar, state, sheetName, desiredKeys, summary) {
  Object.keys(state).forEach(function(key) {
    if (state[key].sheetName !== sheetName || desiredKeys[key]) {
      return;
    }
    deleteStateEvent_(calendar, state, key, summary);
  });
}

function deleteEventsForUnpublishedOrDeletedSheets_(ss, calendar, state, summary) {
  var scheduleSheetsByName = {};
  ss.getSheets().forEach(function(sheet) {
    if (isScheduleSheet_(sheet)) {
      scheduleSheetsByName[sheet.getName()] = sheet;
    }
  });

  Object.keys(state).forEach(function(key) {
    var sheetName = state[key].sheetName;
    var sheet = scheduleSheetsByName[sheetName];
    if (sheet && isPublished_(sheet)) {
      return;
    }
    deleteStateEvent_(calendar, state, key, summary);
  });
}

function deleteStateEvent_(calendar, state, key, summary) {
  var record = state[key];
  if (!record) {
    return;
  }

  if (record.eventId) {
    var event = getCalendarEventById_(calendar, record.eventId);
    if (event) {
      event.deleteEvent();
      summary.deleted++;
    }
  }

  delete state[key];
}

function buildEventPayload_(sheetName, dateKey, date, roleConfig, doctor, timeZone) {
  var syncedAt = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd HH:mm:ss');
  var title = roleConfig.role + ' | ' + doctor;
  var description = [
    'תאריך: ' + dateKey,
    'תפקיד: ' + roleConfig.role,
    'רופא/ה: ' + doctor,
    'גיליון מקור: ' + sheetName,
    'סונכרן לאחרונה: ' + syncedAt
  ].join('\n');
  var color = getCalendarEventColor_(roleConfig.color);
  var hash = [
    dateKey,
    roleConfig.role,
    doctor,
    title,
    color || ''
  ].join('|');

  return {
    sheetName: sheetName,
    dateKey: dateKey,
    date: date,
    role: roleConfig.role,
    doctor: doctor,
    title: title,
    description: description,
    color: color,
    hash: hash
  };
}

function ensureSupportSheets_(ss) {
  ensureSheetWithHeaders_(ss, CONFIG.SUPPORT_SHEETS.DOCTORS, CONFIG.DOCTOR_HEADERS);
  ensureSheetWithHeaders_(ss, CONFIG.SUPPORT_SHEETS.ROLE_CONFIG, CONFIG.ROLE_CONFIG_HEADERS);
  ensureSheetWithHeaders_(ss, CONFIG.SUPPORT_SHEETS.SYNC_STATE, CONFIG.SYNC_STATE_HEADERS);
  seedRoleConfig_(ss);
  refreshDoctorHelperColumns_(ss);
  formatDoctorsSheet_(ss);
  hideSupportSheets_(ss);
}

function ensureDashboardSheet_(ss) {
  var activeSheet = ss.getActiveSheet();
  var sheet = ss.getSheetByName(CONFIG.DASHBOARD_SHEET) || ss.insertSheet(CONFIG.DASHBOARD_SHEET, 0);
  moveSheetToIndex_(ss, sheet, 1, activeSheet);
  setSheetRightToLeft_(sheet);

  sheet.showSheet();
  sheet.getRange('A1:J40').breakApart();
  sheet.clear();
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(2);
  sheet.setColumnWidths(1, 10, 120);
  sheet.setRowHeights(1, 40, 32);
  sheet.setRowHeight(1, 54);
  sheet.setRowHeight(2, 8);
  sheet.setRowHeight(8, 54);
  sheet.setRowHeight(9, 54);
  sheet.setRowHeight(11, 54);
  sheet.setRowHeight(12, 54);

  sheet.getRange('A1:J1').merge()
    .setValue('לוח בקרה - סידור תורנויות')
    .setFontFamily('Arial')
    .setFontSize(18)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#24364b')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.getRange('A3:J4')
    .setFontFamily('Arial')
    .setFontSize(11)
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#d9dee8', SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange('A3').setValue('חודש פעיל').setFontWeight('bold').setBackground('#e8eef7');
  sheet.getRange('C3').setValue('סטטוס').setFontWeight('bold').setBackground('#e8eef7');
  sheet.getRange('E3').setValue('בדיקה').setFontWeight('bold').setBackground('#e8eef7');
  sheet.getRange('G3').setValue('סנכרון אחרון').setFontWeight('bold').setBackground('#e8eef7');
  sheet.getRange('A4').setValue('גיליון חריגים').setFontWeight('bold').setBackground('#f4f7fb');
  sheet.getRange('C4').setValue('שגיאות').setFontWeight('bold').setBackground('#f4f7fb');
  sheet.getRange('E4').setValue('אזהרות').setFontWeight('bold').setBackground('#f4f7fb');
  sheet.getRange('G4').setValue('מצב עבודה').setFontWeight('bold').setBackground('#f4f7fb');
  sheet.getRange('H3:J3').merge();
  sheet.getRange('H4:J4').merge();

  sheet.getRange('A6:J6').merge()
    .setValue('פעולות מהירות - להרצה בפועל השתמש/י בתפריט או בסרגל הצד')
    .setFontWeight('bold')
    .setFontColor('#24364b')
    .setBackground('#eef6ff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  [
    { range: 'B8:C9', label: 'צור חודש חדש', note: 'תפריט: סנכרון תורנויות > צור חודש חדש', color: '#d9eaf7' },
    { range: 'D8:E9', label: 'בדוק חודש', note: 'תפריט: סנכרון תורנויות > בדוק כללי שיבוץ', color: '#e8f3ed' },
    { range: 'F8:G9', label: 'פרסם חודש', note: 'תפריט: סנכרון תורנויות > פרסם חודש נוכחי', color: '#fff2cc' },
    { range: 'H8:I9', label: 'סנכרן יומן', note: 'תפריט: סנכרון תורנויות > סנכרן חודשים שפורסמו', color: '#f2ebf8' },
    { range: 'B11:C12', label: 'רשימת רופאים', note: 'תפריט: סנכרון תורנויות > פתח רשימת רופאים', color: '#eef6ff' },
    { range: 'D11:E12', label: 'גיליון חריגים', note: 'תפריט: סנכרון תורנויות > פתח גיליון חריגים', color: '#fdf0e4' },
    { range: 'F11:G12', label: 'פתח סרגל צד', note: 'תפריט: סנכרון תורנויות > פתח לוח בקרה', color: '#e8eef7' },
    { range: 'H11:I12', label: 'החזר לטיוטה', note: 'תפריט: סנכרון תורנויות > החזר חודש לטיוטה', color: '#eef1f5' }
  ].forEach(function(action) {
    sheet.getRange(action.range).merge()
      .setValue(action.label)
      .setNote(action.note)
      .setFontFamily('Arial')
      .setFontSize(12)
      .setFontWeight('bold')
      .setFontColor('#24364b')
      .setBackground(action.color)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setBorder(true, true, true, true, true, true, '#b8c2d2', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });

  sheet.getRange('A15:J18').merge()
    .setValue('איך עובדים: בונים את הסידור בלשונית החודשית, רופאים מזינים חסימות בלשונית החריגים, מריצים בדיקה, מפרסמים רק בלי שגיאות, ואז מסנכרנים ליומן. היומן הוא לצפייה בלבד; שינויים ביומן לא חוזרים לגיליון.')
    .setWrap(true)
    .setFontFamily('Arial')
    .setFontSize(11)
    .setFontColor('#344054')
    .setBackground('#f8fafc')
    .setHorizontalAlignment('right')
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, false, false, '#d9dee8', SpreadsheetApp.BorderStyle.SOLID);

  protectDashboardSheet_(sheet);
  return sheet;
}

function refreshDashboardStatus_(ss, preferredSheet) {
  var dashboard = ss.getSheetByName(CONFIG.DASHBOARD_SHEET);
  if (!dashboard) {
    return;
  }

  var state = getDashboardState_(ss, preferredSheet || ss.getActiveSheet(), false);
  dashboard.getRange('B3').setValue(state.scheduleName || 'אין חודש פעיל');
  dashboard.getRange('D3').setValue(state.publishStatus || '-');
  dashboard.getRange('F3').setValue(state.validationStatus || '-');
  dashboard.getRange('H3').setValue(state.lastSyncedAt || 'לא סונכרן');
  dashboard.getRange('B4').setValue(state.exceptionsName || '-');
  dashboard.getRange('D4').setValue(state.errorCount);
  dashboard.getRange('F4').setValue(state.warningCount);
  dashboard.getRange('H4').setValue(state.workStatus || '-');

  dashboard.getRange('D3')
    .setBackground(state.isPublished ? '#d9ead3' : '#fff2cc')
    .setFontColor(state.isPublished ? '#14532d' : '#7a4b00')
    .setFontWeight('bold');
  dashboard.getRange('F3')
    .setBackground(state.errorCount ? '#f4b4b4' : ((state.warningCount || state.isValidationStale) ? '#ffd966' : '#d9ead3'))
    .setFontColor(state.errorCount ? '#7f1d1d' : ((state.warningCount || state.isValidationStale) ? '#7a4b00' : '#14532d'))
    .setFontWeight('bold');
  dashboard.getRange('D4')
    .setBackground(state.errorCount ? '#f4b4b4' : '#f8fafc')
    .setFontColor(state.errorCount ? '#7f1d1d' : '#344054')
    .setFontWeight('bold');
  dashboard.getRange('F4')
    .setBackground(state.warningCount ? '#ffd966' : '#f8fafc')
    .setFontColor(state.warningCount ? '#7a4b00' : '#344054')
    .setFontWeight('bold');
}

function getDashboardState_(ss, preferredSheet, includeSidebarData) {
  includeSidebarData = !!includeSidebarData;
  var scheduleSheet = getDashboardTargetScheduleSheet_(ss, preferredSheet || ss.getActiveSheet());
  if (!scheduleSheet) {
    return {
      scheduleName: '',
      exceptionsName: '',
      months: includeSidebarData ? getScheduleMonthOptions_(ss) : [],
      isPublished: false,
      publishStatus: 'אין חודש',
      validationStatus: 'אין חודש לבדיקה',
      errorCount: 0,
      warningCount: 0,
      checkedAt: '',
      isValidationStale: true,
      issues: [],
      doctors: includeSidebarData ? getDoctorNamesForSidebar_(ss) : [],
      dates: [],
      roles: includeSidebarData ? getRoleOptionsForSidebar_() : [],
      lastSyncedAt: '',
      workStatus: 'צור/י חודש חדש כדי להתחיל'
    };
  }

  var validation = readValidationCache_(scheduleSheet.getName());
  var exceptionsSheet = getMatchingExceptionsSheet_(ss, scheduleSheet);
  var published = isPublished_(scheduleSheet);
  var errorCount = validation ? validation.errorCount : 0;
  var warningCount = validation ? validation.warningCount : 0;
  var checkedAt = validation ? validation.checkedAt : '';
  var isStale = !validation || validation.isStale;
  return {
    scheduleName: scheduleSheet.getName(),
    exceptionsName: exceptionsSheet ? exceptionsSheet.getName() : getExceptionsSheetName_(scheduleSheet.getName()),
    months: includeSidebarData ? getScheduleMonthOptions_(ss) : [],
    isPublished: published,
    publishStatus: published ? 'פורסם' : 'טיוטה',
    validationStatus: getCachedValidationStatusText_(validation),
    errorCount: errorCount,
    warningCount: warningCount,
    checkedAt: checkedAt,
    isValidationStale: isStale,
    issues: validation && validation.issues ? validation.issues : [],
    doctors: includeSidebarData ? getDoctorNamesForSidebar_(ss) : [],
    dates: includeSidebarData ? getDateOptionsForSidebar_(ss, scheduleSheet) : [],
    roles: includeSidebarData ? getRoleOptionsForSidebar_() : [],
    lastSyncedAt: getLastSyncedAtForSheet_(ss, scheduleSheet.getName()),
    workStatus: isStale ? 'דורש בדיקה לפני פרסום' : (published ? 'מוכן לסנכרון / פורסם' : 'עבודה בטיוטה')
  };
}

function cacheValidationResult_(ss, sheet, result) {
  if (!sheet || !result) {
    return;
  }

  var payload = {
    sheetName: sheet.getName(),
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
    checkedAt: Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    isStale: false,
    staleReason: '',
    issues: buildCachedIssues_(sheet.getName(), result)
  };
  getValidationCacheProperties_().setProperty(getValidationCacheKey_(sheet.getName()), JSON.stringify(payload));
}

function markValidationStale_(sheetName, reason) {
  if (!sheetName) {
    return;
  }

  var cache = readValidationCache_(sheetName) || {
    sheetName: sheetName,
    errorCount: 0,
    warningCount: 0,
    checkedAt: '',
    issues: []
  };
  cache.isStale = true;
  cache.staleReason = reason || 'נערך מאז הבדיקה האחרונה';
  getValidationCacheProperties_().setProperty(getValidationCacheKey_(sheetName), JSON.stringify(cache));
}

function readValidationCache_(sheetName) {
  if (!sheetName) {
    return null;
  }

  var value = getValidationCacheProperties_().getProperty(getValidationCacheKey_(sheetName));
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    Logger.log('Could not parse validation cache for ' + sheetName + ': ' + error);
    return null;
  }
}

function getValidationCacheProperties_() {
  try {
    return PropertiesService.getDocumentProperties();
  } catch (error) {
    return PropertiesService.getScriptProperties();
  }
}

function getValidationCacheKey_(sheetName) {
  return 'validation-cache:' + sheetName;
}

function getCachedValidationStatusText_(cache) {
  if (!cache) {
    return 'לא נבדק';
  }
  if (cache.isStale) {
    return 'צריך בדיקה';
  }
  if (cache.errorCount) {
    return 'חסום לפרסום';
  }
  if (cache.warningCount) {
    return 'תקין עם אזהרות';
  }
  return 'תקין';
}

function buildCachedIssues_(sheetName, result) {
  var issues = [];
  result.errors.forEach(function(message) {
    issues.push(parseCachedIssue_(sheetName, 'error', message));
  });
  result.warnings.forEach(function(message) {
    issues.push(parseCachedIssue_(sheetName, 'warning', message));
  });
  return issues.slice(0, 80);
}

function parseCachedIssue_(sheetName, severity, message) {
  var text = normalizeCellText_(message);
  var match = text.match(/^([A-Z]+[0-9]+):\s*(.*)$/);
  return {
    sheetName: sheetName,
    severity: severity,
    cell: match ? match[1] : '',
    message: match ? match[2] : text
  };
}

function getScheduleMonthOptions_(ss) {
  return ss.getSheets().filter(function(sheet) {
    return isScheduleSheet_(sheet);
  }).sort(function(first, second) {
    var firstMonth = getSheetYearMonth_(ss, first);
    var secondMonth = getSheetYearMonth_(ss, second);
    return (secondMonth.year * 100 + secondMonth.month) - (firstMonth.year * 100 + firstMonth.month);
  }).map(function(sheet) {
    return {
      name: sheet.getName(),
      isPublished: isPublished_(sheet)
    };
  });
}

function getDoctorNamesForSidebar_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var names = [];
  values.forEach(function(row) {
    row.forEach(function(value) {
      var name = normalizeCellText_(value);
      if (name && names.indexOf(name) === -1) {
        names.push(name);
      }
    });
  });
  return names.sort();
}

function getDateOptionsForSidebar_(ss, scheduleSheet) {
  if (!scheduleSheet) {
    return [];
  }

  var timeZone = ss.getSpreadsheetTimeZone();
  var values = scheduleSheet.getRange(CONFIG.DATA_START_ROW, 1, CONFIG.MONTH_DAY_ROWS, 2).getValues();
  return values.map(function(row) {
    var date = parseScheduleDate_(row[0]);
    if (!date) {
      return null;
    }
    var key = formatDateKey_(date, timeZone);
    var dayText = normalizeCellText_(row[1]);
    return {
      key: key,
      label: dayText ? key + ' · ' + dayText : key,
      dayNumber: date.getDate(),
      weekdayIndex: date.getDay()
    };
  }).filter(function(option) {
    return !!option;
  });
}

function getRoleOptionsForSidebar_() {
  return CONFIG.DEFAULT_ROLES.map(function(role, index) {
    return {
      column: 3 + index,
      name: role[1]
    };
  });
}

function createNextMonthFromSidebar_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSupportSheets_(ss);
  var baseSheet = getDashboardTargetScheduleSheet_(ss, ss.getActiveSheet());
  var baseMonth = baseSheet ? getSheetYearMonth_(ss, baseSheet) : getCurrentYearMonth_(ss);
  var nextMonthDate = new Date(baseMonth.year, baseMonth.month, 1);
  var yearMonth = {
    year: nextMonthDate.getFullYear(),
    month: nextMonthDate.getMonth() + 1
  };
  var sheet = createMonthlyScheduleSheet_(ss, yearMonth);
  setupMonthlySheet_(ss, sheet, { populateDates: true });
  setupMonthlyExceptionsSheet_(ss, ensureMonthlyExceptionsSheet_(ss, sheet), { populateDates: true });
  markValidationStale_(sheet.getName(), 'חודש חדש נוצר');
  ss.setActiveSheet(sheet);
  hideSupportSheets_(ss);
  ensureDashboardSheet_(ss);
  refreshDashboardStatus_(ss, sheet);
  return {
    message: 'נוצר חודש ' + sheet.getName() + ' כטיוטה.'
  };
}

function submitDoctorException_(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var scheduleSheet = ss.getSheetByName(normalizeCellText_(payload.scheduleName)) ||
    getDashboardTargetScheduleSheet_(ss, ss.getActiveSheet());
  if (!scheduleSheet) {
    throw new Error('לא נמצא חודש פעיל.');
  }

  var doctor = normalizeCellText_(payload.doctor);
  var dateKeys = (payload.dateKeys || [])
    .map(function(dateKey) {
      return normalizeCellText_(dateKey);
    })
    .filter(function(dateKey, index, allDateKeys) {
      return !!dateKey && allDateKeys.indexOf(dateKey) === index;
    });
  if (!dateKeys.length && payload.dateKey) {
    dateKeys = [normalizeCellText_(payload.dateKey)];
  }
  var roleColumns = (payload.roleColumns || []).map(function(column) {
    return Number(column);
  }).filter(function(column) {
    return column >= 3 && column <= 10;
  });

  if (!doctor) {
    throw new Error('בחר/י רופא/ה.');
  }
  if (!dateKeys.length) {
    throw new Error('בחר/י תאריך אחד או יותר.');
  }
  if (!roleColumns.length) {
    throw new Error('בחר/י לפחות תפקיד אחד לחסימה.');
  }

  var exceptionsSheet = ensureMonthlyExceptionsSheet_(ss, scheduleSheet);
  setupMonthlyExceptionsSheet_(ss, exceptionsSheet, { populateDatesIfEmpty: true });
  var writtenDates = [];
  var skippedFridayOnlyDates = [];
  dateKeys.forEach(function(dateKey) {
    var rowNumber = findDateRowByKey_(ss, exceptionsSheet, dateKey);
    if (!rowNumber) {
      throw new Error('לא נמצא התאריך ' + dateKey + ' בגיליון החריגים.');
    }
    var allowedColumns = roleColumns.slice();
    var exceptionDate = parseScheduleDate_(exceptionsSheet.getRange(rowNumber, CONFIG.DATE_COLUMN).getValue());
    if (exceptionDate && exceptionDate.getDay() !== 5) {
      allowedColumns = allowedColumns.filter(function(column) {
        return column !== 9 && column !== 10;
      });
    }
    if (!allowedColumns.length) {
      skippedFridayOnlyDates.push(dateKey);
      return;
    }
    allowedColumns.forEach(function(column) {
      appendDoctorToExceptionCell_(exceptionsSheet.getRange(rowNumber, column), doctor);
    });
    writtenDates.push(dateKey);
  });
  if (!writtenDates.length) {
    throw new Error('לא נוספה חסימה: התפקידים שנבחרו זמינים רק ביום שישי.');
  }
  applyDoctorValidation_(ss, scheduleSheet);
  markValidationStale_(scheduleSheet.getName(), 'נוספה חסימת רופא');
  refreshDashboardStatus_(ss, scheduleSheet);
  var message = 'נוספה חסימה עבור ' + doctor + ' ב-' + writtenDates.length + ' תאריכים.';
  if (skippedFridayOnlyDates.length) {
    message += '\nדולגו ' + skippedFridayOnlyDates.length + ' תאריכים שבהם נבחרו רק תפקידי שישי.';
  }
  return {
    message: message
  };
}

function findDateRowByKey_(ss, sheet, dateKey) {
  var timeZone = ss.getSpreadsheetTimeZone();
  var values = sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN, CONFIG.MONTH_DAY_ROWS, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var date = parseScheduleDate_(values[i][0]);
    if (date && formatDateKey_(date, timeZone) === dateKey) {
      return CONFIG.DATA_START_ROW + i;
    }
  }
  return null;
}

function appendDoctorToExceptionCell_(range, doctor) {
  var names = splitExceptionDoctorNames_(range.getValue());
  var keys = names.map(function(name) {
    return normalizeDoctorKey_(name);
  });
  if (keys.indexOf(normalizeDoctorKey_(doctor)) === -1) {
    names.push(doctor);
  }
  range.setValue(names.join('\n')).setWrap(true);
}

function getDashboardTargetScheduleSheet_(ss, preferredSheet) {
  if (preferredSheet && isScheduleSheet_(preferredSheet)) {
    return preferredSheet;
  }
  if (preferredSheet && isExceptionsSheet_(preferredSheet)) {
    var matching = getScheduleSheetForExceptions_(ss, preferredSheet);
    if (matching) {
      return matching;
    }
  }

  var scheduleSheets = ss.getSheets().filter(function(sheet) {
    return isScheduleSheet_(sheet);
  });
  if (!scheduleSheets.length) {
    return null;
  }

  scheduleSheets.sort(function(first, second) {
    var firstMonth = getSheetYearMonth_(ss, first);
    var secondMonth = getSheetYearMonth_(ss, second);
    var firstScore = firstMonth.year * 100 + firstMonth.month;
    var secondScore = secondMonth.year * 100 + secondMonth.month;
    return secondScore - firstScore;
  });
  return scheduleSheets[0];
}

function getLastSyncedAtForSheet_(ss, sheetName) {
  var stateSheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.SYNC_STATE);
  if (!stateSheet || stateSheet.getLastRow() < 2) {
    return '';
  }

  var values = stateSheet.getRange(2, 1, stateSheet.getLastRow() - 1, CONFIG.SYNC_STATE_HEADERS.length).getValues();
  var latest = null;
  values.forEach(function(row) {
    if (normalizeCellText_(row[1]) !== sheetName || !row[7]) {
      return;
    }
    var value = row[7];
    var date = Object.prototype.toString.call(value) === '[object Date]' ? value : new Date(value);
    if (!isNaN(date.getTime()) && (!latest || date.getTime() > latest.getTime())) {
      latest = date;
    }
  });

  return latest ? Utilities.formatDate(latest, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm') : '';
}

function protectDashboardSheet_(sheet) {
  removeProtectionsByPrefix_(sheet, 'Schedule Sync Dashboard');
  var protection = sheet.protect();
  protection.setDescription('Schedule Sync Dashboard protected layout');
  protection.setWarningOnly(true);
}

function moveSheetToIndex_(ss, sheet, index, restoreSheet) {
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(index);
  if (restoreSheet && ss.getSheetByName(restoreSheet.getName())) {
    ss.setActiveSheet(restoreSheet);
  }
}

function formatValidationMessage_(result) {
  if (!result.errors.length && !result.warnings.length) {
    return 'הבדיקה הסתיימה: לא נמצאו חריגות.';
  }

  var message = [];
  if (result.errors.length) {
    message.push('שגיאות שחוסמות סנכרון:');
    message = message.concat(result.errors.slice(0, 12));
  }
  if (result.warnings.length) {
    if (message.length) {
      message.push('');
    }
    message.push('אזהרות לבדיקה ידנית:');
    message = message.concat(result.warnings.slice(0, 12));
  }
  if (result.errors.length + result.warnings.length > 24) {
    message.push('');
    message.push('מוצגות רק 24 החריגות הראשונות. תאים מסומנים בגיליון.');
  }
  return message.join('\n');
}

function buildDashboardSidebarHtml_() {
  return [
    '<!doctype html>',
    '<html dir="rtl">',
    '<head>',
    '<base target="_top">',
    '<style>',
    'body{font-family:Arial,sans-serif;margin:0;color:#24364b;background:#f6f8fb;}',
    '.wrap{padding:14px;}',
    'h1{font-size:18px;margin:0 0 10px;}',
    'h2{font-size:13px;margin:14px 0 8px;color:#536176;}',
    '.panel{background:#fff;border:1px solid #d9dee8;border-radius:8px;padding:12px;margin-bottom:12px;}',
    '.muted{color:#667085;font-size:12px;line-height:1.35;}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
    '.stat{border:1px solid #e6ebf2;border-radius:8px;padding:9px;background:#f8fafc;}',
    '.stat .k{font-size:11px;color:#667085;}',
    '.stat .v{font-size:14px;font-weight:bold;margin-top:4px;}',
    'select,input{box-sizing:border-box;width:100%;border:1px solid #c8d1df;border-radius:8px;padding:8px;background:#fff;color:#24364b;}',
    'button{border:1px solid #b8c2d2;border-radius:8px;background:#fff;padding:9px 10px;font-weight:bold;color:#24364b;cursor:pointer;text-align:center;}',
    'button.primary{background:#24364b;color:white;border-color:#24364b;}',
    'button.warn{background:#fff2cc;border-color:#e6c766;}',
    'button:disabled{opacity:.55;cursor:default;}',
    '.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
    '.actions .wide{grid-column:1 / span 2;}',
    '.message{white-space:pre-wrap;background:#eef6ff;border:1px solid #cfe0f3;border-radius:8px;padding:10px;margin-top:10px;font-size:12px;}',
    '.bad{color:#7f1d1d;font-weight:bold;}',
    '.warnText{color:#7a4b00;font-weight:bold;}',
    '.good{color:#14532d;font-weight:bold;}',
    '.issue{border:1px solid #e6ebf2;border-radius:8px;background:#fff;padding:8px;margin-bottom:6px;cursor:pointer;}',
    '.issue:hover{border-color:#9db4d3;background:#f8fafc;}',
    '.issue .cell{font-weight:bold;margin-left:6px;}',
    '.roles{display:grid;grid-template-columns:1fr;gap:6px;margin-top:8px;}',
    '.role{display:flex;align-items:center;gap:8px;font-size:12px;}',
    '.role input{width:auto;}',
    '.calendar{direction:rtl;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin-top:8px;max-width:100%;overflow:hidden;}',
    '.dow{font-size:11px;color:#667085;text-align:center;font-weight:bold;padding:3px 0;}',
    '.day{box-sizing:border-box;width:100%;min-width:0;min-height:36px;padding:0;border:1px solid #c8d1df;border-radius:8px;background:#fff;color:#24364b;font-weight:bold;}',
    '.day:hover{border-color:#536176;background:#f8fafc;}',
    '.day.selected{background:#24364b;color:#fff;border-color:#24364b;}',
    '.day.friday{border-color:#e6c766;background:#fffdf4;}',
    '.day.selected.friday{background:#24364b;color:#fff;}',
    '.blank{min-width:0;min-height:36px;}',
    '.selectedDates{font-size:12px;color:#536176;margin-top:6px;overflow-wrap:anywhere;}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<h1>לוח בקרה</h1>',
    '<div class="panel">',
    '<h2>חודש עבודה</h2>',
    '<select id="monthSelect" onchange="selectMonth(this.value)"></select>',
    '<div class="grid" id="statusGrid" style="margin-top:10px"></div>',
    '<div class="muted" id="checkedAt" style="margin-top:8px"></div>',
    '</div>',
    '<div class="panel">',
    '<h2>פעולות</h2>',
    '<div class="actions">',
    '<button class="primary wide" onclick="runAction(\'sidebarValidateCurrentSheet\')">בדוק וסמן בעיות</button>',
    '<button class="warn" onclick="runAction(\'sidebarPublishCurrentSheet\')">פרסם</button>',
    '<button onclick="runAction(\'sidebarSyncPublishedSchedules\')">סנכרן</button>',
    '<button onclick="runAction(\'sidebarUnpublishCurrentSheet\')">טיוטה</button>',
    '<button onclick="runAction(\'sidebarCreateNewMonth\')">צור חודש הבא</button>',
    '<button onclick="runAction(\'sidebarOpenMatchingExceptionsSheet\')">חריגים</button>',
    '<button onclick="runAction(\'sidebarOpenDoctorsSheet\')">רופאים</button>',
    '<button onclick="runAction(\'sidebarOpenDashboardSheet\')">Dashboard</button>',
    '<button class="wide" onclick="runAction(\'sidebarSetupOrRepair\')">הגדר / תקן תבנית</button>',
    '</div>',
    '<div class="message" id="message">הסטטוס נטען מהר מהמטמון. בדיקה מלאה רצה רק כשלוחצים בדוק או פרסם.</div>',
    '</div>',
    '<div class="panel">',
    '<h2>בעיות אחרונות</h2>',
    '<div id="issueList" class="muted">אין בדיקה שמורה עדיין.</div>',
    '</div>',
    '<div class="panel">',
    '<h2>הוספת חריג לרופא/ה</h2>',
    '<div class="muted">טופס מהיר לרופאים: בוחרים שם, מסמנים תאריך אחד או יותר, ובוחרים תפקידים לחסימה.</div>',
    '<div style="margin-top:8px"><select id="doctorSelect"></select></div>',
    '<div class="calendar" id="dateCalendar"></div>',
    '<div class="selectedDates" id="selectedDates">לא נבחרו תאריכים.</div>',
    '<div class="roles" id="roleChecks"></div>',
    '<button class="primary wide" style="margin-top:10px;width:100%" onclick="submitException()">הוסף חריג</button>',
    '</div>',
    '</div>',
    '<script>',
    'var currentState=null;',
    'var selectedDateKeys=[];',
    'var renderedScheduleName="";',
    'function esc(value){return String(value===0||value?value:"").replace(/[&<>"\']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[ch];});}',
    'function setBusy(busy){document.querySelectorAll("button,select,input").forEach(function(el){el.disabled=busy;});}',
    'function stat(label,value,klass){return "<div class=\\"stat\\"><div class=\\"k\\">"+esc(label)+"</div><div class=\\"v "+(klass||"")+"\\">"+esc(value||"-")+"</div></div>";}',
    'function render(state){',
    ' if(!state){return;}',
    ' currentState=state;',
    ' renderMonths(state);',
    ' var validationClass=state.errorCount?"bad":(state.isValidationStale||state.warningCount?"warnText":"good");',
    ' document.getElementById("statusGrid").innerHTML=',
    '   stat("סטטוס",state.publishStatus,state.isPublished?"good":"warnText")+',
    '   stat("בדיקה",state.validationStatus,validationClass)+',
    '   stat("שגיאות",state.errorCount,state.errorCount?"bad":"")+',
    '   stat("אזהרות",state.warningCount,state.warningCount?"warnText":"")+',
    '   stat("סנכרון",state.lastSyncedAt||"לא סונכרן","")+',
    '   stat("עבודה",state.workStatus,validationClass);',
    ' document.getElementById("checkedAt").textContent=state.checkedAt?("נבדק לאחרונה: "+state.checkedAt):"לא בוצעה בדיקה מלאה עדיין";',
    ' renderIssues(state);',
    ' renderExceptionForm(state);',
    '}',
    'function renderMonths(state){',
    ' var select=document.getElementById("monthSelect");',
    ' select.innerHTML=(state.months||[]).map(function(month){return "<option value=\\""+esc(month.name)+"\\" "+(month.name===state.scheduleName?"selected":"")+">"+esc(month.name+(month.isPublished?" · פורסם":" · טיוטה"))+"</option>";}).join("");',
    '}',
    'function renderIssues(state){',
    ' var box=document.getElementById("issueList");',
    ' if(state.isValidationStale){box.innerHTML="<span class=\\"warnText\\">החודש נערך מאז הבדיקה האחרונה. לחץ/י בדוק כדי לרענן.</span>";return;}',
    ' var issues=state.issues||[];',
    ' if(!issues.length){box.innerHTML="<span class=\\"good\\">אין בעיות שמורות.</span>";return;}',
    ' box.innerHTML=issues.slice(0,20).map(function(issue,index){var cls=issue.severity==="error"?"bad":"warnText";return "<div class=\\"issue\\" onclick=\\"jumpToIssue("+index+")\\"><span class=\\"cell\\">"+esc(issue.cell||"")+"</span><span class=\\""+cls+"\\">"+(issue.severity==="error"?"שגיאה":"אזהרה")+"</span><div>"+esc(issue.message)+"</div></div>";}).join("");',
    '}',
    'function renderExceptionForm(state){',
    ' if(renderedScheduleName!==state.scheduleName){selectedDateKeys=[];renderedScheduleName=state.scheduleName||"";}',
    ' document.getElementById("doctorSelect").innerHTML="<option value=\\"\\">בחר/י רופא/ה</option>"+(state.doctors||[]).map(function(name){return "<option value=\\""+esc(name)+"\\">"+esc(name)+"</option>";}).join("");',
    ' renderDateCalendar(state.dates||[]);',
    ' document.getElementById("roleChecks").innerHTML=(state.roles||[]).map(function(role){return "<label class=\\"role\\"><input type=\\"checkbox\\" value=\\""+esc(role.column)+"\\"> "+esc(role.name)+"</label>";}).join("");',
    '}',
    'function renderDateCalendar(dates){',
    ' var html=["א","ב","ג","ד","ה","ו","ש"].map(function(day){return "<div class=\\"dow\\">"+day+"</div>";});',
    ' var first=dates[0];',
    ' var blanks=first?Number(first.weekdayIndex||0):0;',
    ' for(var i=0;i<blanks;i++){html.push("<div class=\\"blank\\"></div>");}',
    ' dates.forEach(function(date){var selected=selectedDateKeys.indexOf(date.key)!==-1;var cls="day"+(selected?" selected":"")+(date.weekdayIndex===5?" friday":"");html.push("<button type=\\"button\\" class=\\""+cls+"\\" onclick=\\"toggleDate(\\\'"+esc(date.key)+"\\\')\\">"+esc(date.dayNumber)+"</button>");});',
    ' document.getElementById("dateCalendar").innerHTML=html.join("");',
    ' updateSelectedDates();',
    '}',
    'function toggleDate(key){var index=selectedDateKeys.indexOf(key);if(index===-1){selectedDateKeys.push(key);}else{selectedDateKeys.splice(index,1);}renderDateCalendar((currentState&&currentState.dates)||[]);}',
    'function updateSelectedDates(){document.getElementById("selectedDates").textContent=selectedDateKeys.length?("נבחרו "+selectedDateKeys.length+" תאריכים: "+selectedDateKeys.join(", ")):"לא נבחרו תאריכים.";}',
    'function handleResponse(response){',
    ' setBusy(false);',
    ' if(response&&response.state){render(response.state); if(response.message){document.getElementById("message").textContent=response.message;}}',
    ' else {render(response);}',
    '}',
    'function runAction(name){',
    ' setBusy(true);',
    ' document.getElementById("message").textContent="מריץ פעולה...";',
    ' google.script.run.withSuccessHandler(handleResponse).withFailureHandler(function(error){setBusy(false);document.getElementById("message").textContent=error.message||error;})[name]();',
    '}',
    'function selectMonth(name){setBusy(true);google.script.run.withSuccessHandler(handleResponse).withFailureHandler(function(error){setBusy(false);document.getElementById("message").textContent=error.message||error;}).sidebarSelectMonth(name);}',
    'function jumpToIssue(index){var issue=(currentState.issues||[])[index];if(!issue){return;}setBusy(true);google.script.run.withSuccessHandler(handleResponse).withFailureHandler(function(error){setBusy(false);document.getElementById("message").textContent=error.message||error;}).sidebarJumpToCell(issue.sheetName,issue.cell);}',
    'function submitException(){',
    ' var roles=[].slice.call(document.querySelectorAll("#roleChecks input:checked")).map(function(input){return input.value;});',
    ' var payload={scheduleName:currentState&&currentState.scheduleName,doctor:document.getElementById("doctorSelect").value,dateKeys:selectedDateKeys.slice(),roleColumns:roles};',
    ' setBusy(true);document.getElementById("message").textContent="מוסיף חריג...";',
    ' google.script.run.withSuccessHandler(handleResponse).withFailureHandler(function(error){setBusy(false);document.getElementById("message").textContent=error.message||error;}).sidebarSubmitException(payload);',
    '}',
    'google.script.run.withSuccessHandler(render).getDashboardSidebarState();',
    '</script>',
    '</body>',
    '</html>'
  ].join('');
}

function formatDoctorsSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  if (!sheet) {
    return;
  }

  sheet.showSheet();
  setSheetRightToLeft_(sheet);
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 6, 180);
  sheet.getRange('A:A').setBackground('#eef6ff');
  sheet.getRange('B:B').setBackground('#f1f8f4');
  sheet.getRange('C:C').setBackground('#fff7dd');
  sheet.getRange('D:D').setBackground('#f3f4f6');
  sheet.getRange('E:E').setBackground('#f6f2ff');
  sheet.getRange('F:F').setBackground('#edf7f3');
  sheet.getRange(1, 1, 1, CONFIG.DOCTOR_HEADERS.length)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setBackground('#344054');
}

function refreshDoctorHelperColumns_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  if (!sheet) {
    return;
  }

  sheet.getRange(1, 1, 1, CONFIG.DOCTOR_HEADERS.length).setValues([CONFIG.DOCTOR_HEADERS]);
  clearOldActiveStatusColumn_(sheet);
  var residents = readDoctorColumn_(sheet, 1);
  var seniors = readDoctorColumn_(sheet, 2);
  var angio = readDoctorColumn_(sheet, 3);
  var names = uniqueNames_(residents.concat(seniors).concat(angio));
  var residentsThenSeniors = uniqueNames_(residents.concat(seniors));
  var seniorsThenResidents = uniqueNames_(seniors.concat(residents));

  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 3).clearContent();
  writeDoctorList_(sheet, 4, names);
  writeDoctorList_(sheet, 5, residentsThenSeniors);
  writeDoctorList_(sheet, 6, seniorsThenResidents);
}

function readDoctorColumn_(sheet, column) {
  return sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .getValues()
    .map(function(row) {
      return normalizeCellText_(row[0]);
    })
    .filter(function(name) {
      return !!name;
    });
}

function uniqueNames_(names) {
  var unique = [];
  names.forEach(function(name) {
    if (unique.indexOf(name) === -1) {
      unique.push(name);
    }
  });
  return unique;
}

function writeDoctorList_(sheet, column, names) {
  if (names.length) {
    sheet.getRange(2, column, names.length, 1).setValues(names.map(function(name) {
      return [name];
    }));
  }
}

function clearOldActiveStatusColumn_(sheet) {
  var values = sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .getValues()
    .map(function(row) {
      return normalizeCellText_(row[0]).toLowerCase();
    })
    .filter(function(value) {
      return value;
    });
  if (!values.length) {
    return;
  }

  var statusValues = ['כן', 'לא', 'yes', 'no', 'true', 'false', 'active', 'inactive'];
  var statusOnly = values.every(function(value) {
    return statusValues.indexOf(value) !== -1;
  });
  if (statusOnly) {
    sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 1).clearContent();
  }
}

function ensureSheetWithHeaders_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsHeaders = headers.some(function(header, index) {
    return existing[index] !== header;
  });

  if (needsHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function seedRoleConfig_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.ROLE_CONFIG);
  if (sheet.getLastRow() > 1 && roleConfigAlreadyHebrew_(sheet)) {
    return;
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, CONFIG.ROLE_CONFIG_HEADERS.length)
    .setValues([CONFIG.ROLE_CONFIG_HEADERS]);
  sheet.getRange(2, 1, CONFIG.DEFAULT_ROLES.length, CONFIG.DEFAULT_ROLES[0].length)
    .setValues(CONFIG.DEFAULT_ROLES);
}

function roleConfigAlreadyHebrew_(sheet) {
  var values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1)
    .getValues()
    .map(function(row) {
      return normalizeCellText_(row[0]);
    });
  return values.indexOf(CONFIG.DEFAULT_ROLES[0][0]) !== -1 &&
    values.indexOf(CONFIG.DEFAULT_ROLES[CONFIG.DEFAULT_ROLES.length - 1][0]) !== -1;
}

function hideSupportSheets_(ss) {
  var activeSheet = ss.getActiveSheet();
  Object.keys(CONFIG.SUPPORT_SHEETS).forEach(function(key) {
    var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS[key]);
    if (CONFIG.SUPPORT_SHEETS[key] === CONFIG.SUPPORT_SHEETS.DOCTORS) {
      return;
    }
    if (sheet && sheet.getName() !== activeSheet.getName()) {
      sheet.hideSheet();
    }
  });
}

function setupMonthlySheet_(ss, sheet, options) {
  options = options || {};
  setSheetRightToLeft_(sheet);
  migrateOldEnglishRoleColumns_(sheet);
  migrateSingleFridayMorningColumn_(sheet);
  sheet.getRange('A1').setValue('חודש');
  sheet.getRange('C1').setValue('שנה');
  sheet.getRange('F1').setValue('סטטוס סנכרון');
  sheet.getRange('H1').setValue('תבנית v' + CONFIG.VERSION);
  ensureMonthYearCells_(ss, sheet);
  if (!sheet.getRange(CONFIG.PUBLISHED_CELL).getValue()) {
    sheet.getRange(CONFIG.PUBLISHED_CELL).setValue(CONFIG.DRAFT_VALUE);
  }

  var headers = ['תאריך', 'יום'].concat(CONFIG.DEFAULT_ROLES.map(function(role) {
    return role[1];
  }));
  sheet.getRange(CONFIG.HEADER_ROW, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(CONFIG.HEADER_ROW);

  var maxRows = Math.max(sheet.getMaxRows(), CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS - 1);
  if (sheet.getMaxRows() < maxRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), maxRows - sheet.getMaxRows());
  }
  showOnlyMonthBoardRows_(sheet);

  if (options.populateDates || (options.populateDatesIfEmpty && !sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN).getValue())) {
    populateMonthDates_(ss, sheet);
  } else {
    sheet
      .getRange(CONFIG.DATA_START_ROW, CONFIG.DAY_COLUMN, CONFIG.MONTH_DAY_ROWS, 1)
      .setFormulaR1C1(getHebrewDayFormulaR1C1_());
  }

  applyDoctorValidation_(ss, sheet);
  applyPublishedValidation_(sheet);
  formatMonthlySheet_(sheet);
  protectMonthlySheetWarnings_(sheet);
}

function setupMonthlyExceptionsSheet_(ss, sheet, options) {
  options = options || {};
  setSheetRightToLeft_(sheet);
  sheet.getRange('A1').setValue('Month');
  sheet.getRange('C1').setValue('Year');
  sheet.getRange('F1').setValue('Purpose');
  sheet.getRange(CONFIG.PUBLISHED_CELL).setValue('Doctor exceptions');
  sheet.getRange('H1').setValue('Template v' + CONFIG.VERSION);
  ensureMonthYearCells_(ss, sheet);

  var headers = ['Date', 'Day'].concat(CONFIG.DEFAULT_ROLES.map(function(role) {
    return role[1];
  }));
  sheet.getRange(CONFIG.HEADER_ROW, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(CONFIG.HEADER_ROW);

  var maxRows = Math.max(sheet.getMaxRows(), CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS - 1);
  if (sheet.getMaxRows() < maxRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), maxRows - sheet.getMaxRows());
  }
  showOnlyMonthBoardRows_(sheet);

  if (options.populateDates || (options.populateDatesIfEmpty && !sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN).getValue())) {
    populateMonthDates_(ss, sheet);
  } else {
    sheet
      .getRange(CONFIG.DATA_START_ROW, CONFIG.DAY_COLUMN, CONFIG.MONTH_DAY_ROWS, 1)
      .setFormulaR1C1(getHebrewDayFormulaR1C1_());
  }

  formatMonthlySheet_(sheet);
  formatExceptionsSheet_(sheet);
  sheet.getRange(CONFIG.PUBLISHED_CELL).clearDataValidations();
  sheet
    .getRange(CONFIG.DATA_START_ROW, 3, CONFIG.MONTH_DAY_ROWS, 8)
    .clearDataValidations()
    .setWrap(true);
  protectMonthlySheetWarnings_(sheet);
}

function formatExceptionsSheet_(sheet) {
  sheet.getRange(CONFIG.PUBLISHED_CELL)
    .setBackground('#fdf0e4')
    .setFontColor('#7a4b00')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNote('גיליון חריגים: אינו מסתנכרן ליומן.');
  sheet.getRange('A2:B2').breakApart().merge()
    .setValue('הנחיות')
    .setFontFamily('Arial')
    .setFontSize(11)
    .setFontWeight('bold')
    .setFontColor('#7a4b00')
    .setBackground('#fff2cc')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, false, false, '#e6c766', SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange('C2:J2').breakApart().merge()
    .setValue('רופאים: הזינו רק שמות בתאי התפקיד/תאריך שבהם אינכם זמינים. אפשר להזין כמה שמות באותו תא, כל שם בשורה נפרדת. אין לערוך תאריכים, כותרות או נוסחאות.')
    .setWrap(true)
    .setFontFamily('Arial')
    .setFontSize(11)
    .setFontWeight('bold')
    .setFontColor('#7a4b00')
    .setBackground('#fff2cc')
    .setHorizontalAlignment('right')
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, false, false, '#e6c766', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(2, 62);
}

function migrateOldEnglishRoleColumns_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 10);
  var headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getValues()[0]
    .map(function(header) {
      return normalizeCellText_(header);
    });
  if (headers.indexOf('תורן') !== -1 || headers.indexOf('Conan A') === -1) {
    return;
  }

  var oldColumnByHeader = {};
  headers.forEach(function(header, index) {
    if (header) {
      oldColumnByHeader[header] = index + 1;
    }
  });

  var mappings = [
    { oldHeader: 'Toran', newColumn: 3 },
    { oldHeader: 'Conan A', newColumn: 4 },
    { oldHeader: 'Conan B', newColumn: 5 },
    { oldHeader: 'Conan Angio', newColumn: 6 },
    { oldHeader: 'Toran Hzi 1', newColumn: 7 },
    { oldHeader: 'Toran Hzi 2', newColumn: 8 }
  ];
  var rowsByNewColumn = {};

  mappings.forEach(function(mapping) {
    var oldColumn = oldColumnByHeader[mapping.oldHeader];
    if (!oldColumn) {
      return;
    }
    rowsByNewColumn[mapping.newColumn] = sheet
      .getRange(CONFIG.DATA_START_ROW, oldColumn, CONFIG.MONTH_DAY_ROWS, 1)
      .getValues();
  });

  Object.keys(rowsByNewColumn).forEach(function(column) {
    sheet
      .getRange(CONFIG.DATA_START_ROW, Number(column), CONFIG.MONTH_DAY_ROWS, 1)
      .setValues(rowsByNewColumn[column]);
  });

  sheet.getRange(CONFIG.DATA_START_ROW, 9, CONFIG.MONTH_DAY_ROWS, 2).clearContent();
}

function migrateSingleFridayMorningColumn_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 10);
  var headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getValues()[0]
    .map(function(header) {
      return normalizeCellText_(header);
    });

  var oldFridayColumn = headers.indexOf('שישי בוקר') + 1;
  var newResidentFridayColumn = headers.indexOf('שישי בוקר מתמחה') + 1;
  var newSeniorFridayColumn = headers.indexOf('שישי בוקר מומחה') + 1;
  if (!oldFridayColumn || newResidentFridayColumn || newSeniorFridayColumn) {
    return;
  }

  sheet
    .getRange(CONFIG.DATA_START_ROW, oldFridayColumn, CONFIG.MONTH_DAY_ROWS, 1)
    .copyTo(sheet.getRange(CONFIG.DATA_START_ROW, 10, CONFIG.MONTH_DAY_ROWS, 1), { contentsOnly: true });
  sheet.getRange(CONFIG.DATA_START_ROW, oldFridayColumn, CONFIG.MONTH_DAY_ROWS, 1).clearContent();
}

function formatMonthlySheet_(sheet) {
  var dataRows = CONFIG.MONTH_DAY_ROWS;
  var totalColumns = 10;
  var fullScheduleRange = sheet.getRange(1, 1, CONFIG.DATA_START_ROW + dataRows - 1, totalColumns);
  var topRange = sheet.getRange('A1:J1');
  var headerRange = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, totalColumns);
  var dataRange = sheet.getRange(CONFIG.DATA_START_ROW, 1, dataRows, totalColumns);
  var roleRange = sheet.getRange(CONFIG.DATA_START_ROW, 3, dataRows, 8);

  setSheetRightToLeft_(sheet);
  sheet.setFrozenRows(CONFIG.HEADER_ROW);
  sheet.setFrozenColumns(2);
  sheet.setHiddenGridlines(true);

  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidths(3, 8, 160);
  sheet.setRowHeight(1, 38);
  sheet.setRowHeight(2, 10);
  sheet.setRowHeight(CONFIG.HEADER_ROW, 42);
  sheet.setRowHeights(CONFIG.DATA_START_ROW, dataRows, 38);

  fullScheduleRange
    .setFontFamily('Arial')
    .setFontSize(10)
    .setVerticalAlignment('middle');

  topRange
    .setBackground('#f4f7fb')
    .setFontWeight('bold')
    .setFontColor('#24364b')
    .setHorizontalAlignment('center');

  sheet.getRange('A1').setBackground('#d9eaf7');
  sheet.getRange('C1').setBackground('#d9eaf7');
  sheet.getRange('F1').setBackground('#fdecc8');
  sheet.getRange(CONFIG.PUBLISHED_CELL)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  formatPublishStatusCell_(sheet);
  sheet.getRange('H1')
    .setBackground('#e8eef7')
    .setFontColor('#536176')
    .setFontStyle('italic')
    .setHorizontalAlignment('center');

  headerRange
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  sheet.getRange(CONFIG.HEADER_ROW, 1, 1, 2).setBackground('#5b677a');
  sheet.getRange(CONFIG.HEADER_ROW, 3).setBackground('#3f7cac');
  sheet.getRange(CONFIG.HEADER_ROW, 4).setBackground('#4f8f6f');
  sheet.getRange(CONFIG.HEADER_ROW, 5).setBackground('#b48b2c');
  sheet.getRange(CONFIG.HEADER_ROW, 6).setBackground('#c77d36');
  sheet.getRange(CONFIG.HEADER_ROW, 7).setBackground('#8a63a8');
  sheet.getRange(CONFIG.HEADER_ROW, 8).setBackground('#b84a4a');
  sheet.getRange(CONFIG.HEADER_ROW, 9).setBackground('#667085');
  sheet.getRange(CONFIG.HEADER_ROW, 10).setBackground('#475467');

  dataRange
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true, '#d9dee8', SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange(CONFIG.DATA_START_ROW, 1, dataRows, 1)
    .setNumberFormat('yyyy-mm-dd')
    .setBackground('#f8fafc')
    .setFontWeight('bold');

  sheet.getRange(CONFIG.DATA_START_ROW, 2, dataRows, 1)
    .setBackground('#f8fafc')
    .setFontColor('#536176');

  roleRange.setBackground('#ffffff');
  applyRoleColumnBackgrounds_(sheet, dataRows);
  formatPendingAssignments_(sheet);
  disableNonFridayMorningCells_(sheet);
  shadeUnusedMonthRows_(sheet);
}

function formatPublishStatusCell_(sheet) {
  var published = isPublished_(sheet);
  sheet.getRange(CONFIG.PUBLISHED_CELL)
    .setBackground(published ? '#d9ead3' : '#fff2cc')
    .setFontColor(published ? '#14532d' : '#7a4b00')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setNote(published ?
      'פורסם: החודש יסונכרן ליומן בהרצת סנכרון.' :
      'טיוטה: החודש לא יסונכרן ליומן.');
}

function formatPendingAssignments_(sheet) {
  var range = sheet.getRange(CONFIG.DATA_START_ROW, 3, CONFIG.MONTH_DAY_ROWS, 8);
  var values = range.getValues();
  values.forEach(function(row, rowIndex) {
    row.forEach(function(value, columnIndex) {
      if (!isPendingValue_(value)) {
        return;
      }
      sheet.getRange(CONFIG.DATA_START_ROW + rowIndex, 3 + columnIndex)
        .setBackground('#fff4ce')
        .setFontColor('#7a4b00')
        .setFontStyle('italic')
        .setFontWeight('bold')
        .setNote('שיבוץ ממתין: תא זה לא ייצור אירוע ביומן עד שיוזן שם רופא/ה.');
    });
  });
}

function ensureMonthYearCells_(ss, sheet) {
  var existingMonth = normalizeCellText_(sheet.getRange('B1').getValue());
  var existingYear = normalizeCellText_(sheet.getRange('D1').getValue());
  if (existingMonth && existingYear) {
    return;
  }

  var parsed = parseYearMonthInput_(sheet.getName()) || getCurrentYearMonth_(ss);
  if (!existingMonth) {
    sheet.getRange('B1').setValue(parsed.month);
  }
  if (!existingYear) {
    sheet.getRange('D1').setValue(parsed.year);
  }
}

function populateMonthDates_(ss, sheet) {
  var yearMonth = getSheetYearMonth_(ss, sheet);
  var daysInMonth = getDaysInMonth_(yearMonth.year, yearMonth.month);
  var dateRows = [];
  var dayFormulas = [];

  for (var day = 1; day <= CONFIG.MONTH_DAY_ROWS; day++) {
    dateRows.push([day <= daysInMonth ? new Date(yearMonth.year, yearMonth.month - 1, day) : '']);
    dayFormulas.push([day <= daysInMonth ? getHebrewDayFormulaA1_(CONFIG.DATA_START_ROW + day - 1) : '']);
  }

  sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN, CONFIG.MONTH_DAY_ROWS, 1).setValues(dateRows);
  sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DAY_COLUMN, CONFIG.MONTH_DAY_ROWS, 1).setFormulas(dayFormulas);
}

function shadeUnusedMonthRows_(sheet) {
  var yearMonth = getSheetYearMonth_(SpreadsheetApp.getActiveSpreadsheet(), sheet);
  var daysInMonth = getDaysInMonth_(yearMonth.year, yearMonth.month);
  if (daysInMonth >= CONFIG.MONTH_DAY_ROWS) {
    return;
  }

  var firstUnusedRow = CONFIG.DATA_START_ROW + daysInMonth;
  var unusedRows = CONFIG.MONTH_DAY_ROWS - daysInMonth;
  sheet.getRange(firstUnusedRow, 1, unusedRows, 10)
    .setBackground('#eef1f5')
    .setFontColor('#9aa3af')
    .setBorder(true, true, true, true, true, true, '#d9dee8', SpreadsheetApp.BorderStyle.SOLID);
}

function disableNonFridayMorningCells_(sheet) {
  var dateValues = sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN, CONFIG.MONTH_DAY_ROWS, 1).getValues();
  dateValues.forEach(function(row, index) {
    var date = parseScheduleDate_(row[0]);
    if (date && date.getDay() === 5) {
      return;
    }

    sheet.getRange(CONFIG.DATA_START_ROW + index, 9, 1, 2)
      .clearContent()
      .clearDataValidations()
      .setBackground('#eef1f5')
      .setFontColor('#98a2b3')
      .setFontWeight('normal')
      .setBorder(true, true, true, true, true, true, '#d9dee8', SpreadsheetApp.BorderStyle.SOLID);
  });
}

function showOnlyMonthBoardRows_(sheet) {
  var visibleRows = CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS - 1;
  sheet.showRows(1, Math.min(visibleRows, sheet.getMaxRows()));
  if (sheet.getMaxRows() > visibleRows) {
    sheet.hideRows(visibleRows + 1, sheet.getMaxRows() - visibleRows);
  }
}

function setSheetRightToLeft_(sheet) {
  if (typeof sheet.setRightToLeft === 'function') {
    sheet.setRightToLeft(true);
  }
}

function getHebrewDayFormulaR1C1_() {
  return '=IF(RC[-1]="","",CHOOSE(WEEKDAY(RC[-1]),"א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"))';
}

function getHebrewDayFormulaA1_(rowNumber) {
  return '=IF(A' + rowNumber + '="","",CHOOSE(WEEKDAY(A' + rowNumber + '),"א׳","ב׳","ג׳","ד׳","ה׳","ו׳","ש׳"))';
}

function applyRoleColumnBackgrounds_(sheet, dataRows) {
  var roleColors = [
    '#faeaea',
    '#eaf4fb',
    '#ecf6ef',
    '#fff7dd',
    '#fdf0e4',
    '#f2ebf8',
    '#eef1f5',
    '#e6e9ef'
  ];

  roleColors.forEach(function(color, index) {
    sheet.getRange(CONFIG.DATA_START_ROW, 3 + index, dataRows, 1).setBackground(color);
  });
}

function applyDoctorValidation_(ss, sheet) {
  if (!ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS)) {
    ensureSupportSheets_(ss);
  }
  refreshDoctorHelperColumns_(ss);
  var dropdownRanges = refreshScheduleDoctorDropdowns_(ss, sheet);

  for (var column = 3; column <= 10; column++) {
    var validations = [];
    for (var row = CONFIG.DATA_START_ROW; row < CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS; row++) {
      validations.push([buildDoctorValidation_(dropdownRanges[row + '|' + column])]);
    }
    sheet
      .getRange(CONFIG.DATA_START_ROW, column, CONFIG.MONTH_DAY_ROWS, 1)
      .setDataValidations(validations);
  }

  disableNonFridayMorningCells_(sheet);
}

function refreshScheduleDoctorDropdowns_(ss, scheduleSheet) {
  var helperSheet = ensureDoctorDropdownSheet_(ss, scheduleSheet);
  var doctorsSheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.DOCTORS);
  var doctorSets = getDoctorSets_(ss);
  var exceptions = readMatchingExceptions_(ss, scheduleSheet, doctorSets, { errors: [], warnings: [] }, false);
  var timeZone = ss.getSpreadsheetTimeZone();
  var ranges = {};
  var helperColumn = 1;

  helperSheet.showSheet();
  ensureDoctorDropdownSheetSize_(helperSheet, CONFIG.MONTH_DAY_ROWS * 8, Math.max(doctorsSheet.getMaxRows() + 2, 3));
  helperSheet.clear();
  helperSheet.setFrozenRows(1);

  for (var row = CONFIG.DATA_START_ROW; row < CONFIG.DATA_START_ROW + CONFIG.MONTH_DAY_ROWS; row++) {
    var date = parseScheduleDate_(scheduleSheet.getRange(row, CONFIG.DATE_COLUMN).getValue());
    var dateKey = date ? formatDateKey_(date, timeZone) : '';

    for (var column = 3; column <= 10; column++) {
      var sourceNames = getDoctorDropdownSourceNames_(doctorsSheet, column);
      var blockedNames = dateKey ? getBlockedDoctorNamesForDropdown_(exceptions, dateKey, column) : [];
      var blockedKeys = {};
      blockedNames.forEach(function(name) {
        blockedKeys[normalizeDoctorKey_(name)] = true;
      });
      var availableNames = sourceNames.filter(function(name) {
        return !blockedKeys[normalizeDoctorKey_(name)];
      });
      var dropdownNames = availableNames.slice();
      if (blockedNames.length) {
        dropdownNames.push(CONFIG.DROPDOWN_CONSTRAINTS_LABEL);
        dropdownNames = dropdownNames.concat(blockedNames);
      }
      if (!dropdownNames.length) {
        dropdownNames.push('');
      }

      helperSheet.getRange(1, helperColumn).setValue(columnToLetter_(column) + row);
      helperSheet.getRange(2, helperColumn, dropdownNames.length, 1).setValues(dropdownNames.map(function(name) {
        return [name];
      }));
      ranges[row + '|' + column] = helperSheet.getRange(2, helperColumn, dropdownNames.length, 1);
      helperColumn++;
    }
  }

  helperSheet.getRange(1, 1, 1, helperColumn - 1)
    .setFontWeight('bold')
    .setBackground('#e8eef7');
  helperSheet.hideSheet();
  return ranges;
}

function ensureDoctorDropdownSheet_(ss, scheduleSheet) {
  var name = CONFIG.DROPDOWN_HELPER_PREFIX + scheduleSheet.getName();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  setSheetRightToLeft_(sheet);
  return sheet;
}

function ensureDoctorDropdownSheetSize_(sheet, requiredColumns, requiredRows) {
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
}

function getDoctorDropdownSourceNames_(doctorsSheet, scheduleColumn) {
  var sourceColumnByScheduleColumn = {
    3: 1,
    4: 2,
    5: 2,
    6: 3,
    7: 5,
    8: 6,
    9: 1,
    10: 2
  };
  return readDoctorColumn_(doctorsSheet, sourceColumnByScheduleColumn[scheduleColumn]);
}

function getBlockedDoctorNamesForDropdown_(exceptions, dateKey, scheduleColumn) {
  var entry = exceptions.blocked[dateKey + '|' + scheduleColumn];
  if (!entry) {
    return [];
  }

  return Object.keys(entry.names).map(function(key) {
    return entry.names[key];
  });
}

function buildDoctorValidation_(range) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInRange(range, true)
    .setAllowInvalid(false)
    .build();
}

function applyPublishedValidation_(sheet) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([CONFIG.DRAFT_VALUE, CONFIG.PUBLISHED_VALUE, 'Draft', 'Published'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(CONFIG.PUBLISHED_CELL).setDataValidation(rule);
}

function protectSupportSheets_(ss) {
  Object.keys(CONFIG.SUPPORT_SHEETS).forEach(function(key) {
    var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS[key]);
    if (!sheet) {
      return;
    }
    removeProtectionsByPrefix_(sheet, 'Schedule Sync');
    var protection = sheet.protect();
    protection.setDescription('Schedule Sync helper sheet');
    protection.setWarningOnly(true);
  });
}

function protectMonthlySheetWarnings_(sheet) {
  removeProtectionsByPrefix_(sheet, 'Schedule Sync');
  [
    sheet.getRange('A1:J1'),
    sheet.getRange('A2:J2'),
    sheet.getRange(CONFIG.HEADER_ROW, 1, 1, sheet.getLastColumn()),
    sheet.getRange(CONFIG.DATA_START_ROW, CONFIG.DATE_COLUMN, CONFIG.MONTH_DAY_ROWS, 2)
  ].forEach(function(range) {
    var protection = range.protect();
    protection.setDescription('Schedule Sync protected layout');
    protection.setWarningOnly(true);
  });
}

function removeProtectionsByPrefix_(sheet, prefix) {
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function(protection) {
    if ((protection.getDescription() || '').indexOf(prefix) === 0) {
      protection.remove();
    }
  });
  sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(protection) {
    if ((protection.getDescription() || '').indexOf(prefix) === 0) {
      protection.remove();
    }
  });
}

function getRoleConfigs_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.ROLE_CONFIG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return CONFIG.DEFAULT_ROLES.map(function(row) {
      return {
        role: row[0],
        headerName: row[1],
        color: row[2]
      };
    });
  }

  return sheet.getRange(2, 1, lastRow - 1, 3).getValues()
    .filter(function(row) {
      return row[0] && row[1];
    })
    .map(function(row) {
      return {
        role: normalizeCellText_(row[0]),
        headerName: normalizeCellText_(row[1]),
        color: normalizeCellText_(row[2])
      };
    });
}

function getRoleColumns_(sheet, roleConfigs) {
  var lastColumn = Math.max(sheet.getLastColumn(), 8);
  var headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  var columnsByHeader = {};

  headers.forEach(function(header, index) {
    var normalized = normalizeCellText_(header);
    if (normalized) {
      columnsByHeader[normalized] = index + 1;
    }
  });

  var roleColumns = {};
  roleConfigs.forEach(function(roleConfig) {
    roleColumns[roleConfig.headerName] = columnsByHeader[roleConfig.headerName];
  });
  return roleColumns;
}

function readSyncState_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.SYNC_STATE);
  var state = {};
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return state;
  }

  sheet.getRange(2, 1, lastRow - 1, CONFIG.SYNC_STATE_HEADERS.length).getValues()
    .forEach(function(row) {
      var key = normalizeCellText_(row[0]);
      if (!key) {
        return;
      }
      state[key] = {
        key: key,
        sheetName: normalizeCellText_(row[1]),
        dateKey: normalizeCellText_(row[2]),
        role: normalizeCellText_(row[3]),
        doctor: normalizeCellText_(row[4]),
        eventId: normalizeCellText_(row[5]),
        lastHash: normalizeCellText_(row[6]),
        lastSyncedAt: row[7] || ''
      };
    });

  return state;
}

function writeSyncState_(ss, state) {
  var sheet = ss.getSheetByName(CONFIG.SUPPORT_SHEETS.SYNC_STATE);
  var rows = Object.keys(state).sort().map(function(key) {
    var record = state[key];
    return [
      record.key,
      record.sheetName,
      record.dateKey,
      record.role,
      record.doctor,
      record.eventId,
      record.lastHash,
      record.lastSyncedAt
    ];
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, CONFIG.SYNC_STATE_HEADERS.length)
    .setValues([CONFIG.SYNC_STATE_HEADERS]);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, CONFIG.SYNC_STATE_HEADERS.length)
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
}

function getCalendar_() {
  var calendarId = PropertiesService.getScriptProperties().getProperty(CONFIG.CALENDAR_ID_PROPERTY) ||
    CONFIG.CALENDAR_ID;

  if (!calendarId || calendarId === 'PUT_CALENDAR_ID_HERE') {
    throw new Error(
      'Calendar ID is not configured. Set CONFIG.CALENDAR_ID or Script Property ' +
      CONFIG.CALENDAR_ID_PROPERTY + '.'
    );
  }

  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('Calendar not found or not accessible: ' + calendarId);
  }

  return calendar;
}

function getCalendarEventById_(calendar, eventId) {
  try {
    return calendar.getEventById(eventId);
  } catch (error) {
    Logger.log('Could not read calendar event ' + eventId + ': ' + error);
    return null;
  }
}

function getCalendarEventColor_(colorName) {
  var normalized = normalizeCellText_(colorName).toUpperCase().replace(/\s+/g, '_');
  var colors = CalendarApp.EventColor;
  return colors[normalized] || null;
}

function isScheduleSheet_(sheet) {
  var name = sheet.getName();
  if (isExceptionsSheet_(sheet)) {
    return false;
  }
  if (name.indexOf(CONFIG.DROPDOWN_HELPER_PREFIX) === 0) {
    return false;
  }
  var isSupportSheet = !Object.keys(CONFIG.SUPPORT_SHEETS).every(function(key) {
    return CONFIG.SUPPORT_SHEETS[key] !== name;
  });
  if (isSupportSheet) {
    return false;
  }
  return !!parseYearMonthInput_(name);
}

function isExceptionsSheet_(sheet) {
  return !!sheet && sheet.getName().indexOf(CONFIG.EXCEPTIONS_PREFIX) === 0;
}

function isPublished_(sheet) {
  var value = normalizeCellText_(sheet.getRange(CONFIG.PUBLISHED_CELL).getValue()).toLowerCase();
  return CONFIG.PUBLISHED_VALUES.indexOf(value) !== -1;
}

function isPendingValue_(value) {
  return CONFIG.PENDING_VALUES.indexOf(normalizeCellText_(value).toLowerCase()) !== -1;
}

function buildSyncKey_(sheetName, dateKey, role) {
  return [sheetName, dateKey, role].join('|');
}

function parseScheduleDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  var text = normalizeCellText_(value);
  if (!text) {
    return null;
  }

  var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  var slash = text.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (slash) {
    return new Date(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1]));
  }

  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  return null;
}

function formatDateKey_(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
}

function normalizeCellText_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('סנכרון אחר כבר רץ. נסה/י שוב בעוד רגע.');
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function alertUser_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    Logger.log(message);
  }
}

function createSummary_() {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0
  };
}

function formatSummary_(summary) {
  return [
    'הסנכרון הושלם.',
    'נוצרו: ' + summary.created,
    'עודכנו: ' + summary.updated,
    'נמחקו: ' + summary.deleted,
    'ללא שינוי: ' + summary.unchanged
  ].join('\n');
}
