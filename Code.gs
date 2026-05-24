/**
 * Shift Scheduler Web App API Proxy Backend
 * 
 * Host this script as a standalone Google Apps Script or bound to a spreadsheet.
 * Deploy it as a Web App:
 * - Execute as: Me (Admin account)
 * - Who has access: Anyone (anonymous)
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return makeResponse_({ error: "נכשל לרכוש מנעול לביצוע הפעולה. נסה שוב." });
  }
  
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return makeResponse_({ error: "בקשה ריקה." });
    }
    
    var request = JSON.parse(e.postData.contents);
    var action = request.action;
    var username = request.username;
    var passwordHash = request.passwordHash;
    
    // Load database JSON file from Google Drive
    var file = getDatabaseFile_();
    var fileContent = file.getAs('application/json').getDataAsString();
    var workspace = JSON.parse(fileContent);
    
    // Bootstrap mode: If there are no users in the database, register the first user as a senior-planner
    var hasPlanners = workspace.users && workspace.users.some(function(u) { return u.active && u.role === 'senior-planner'; });
    if (!hasPlanners && action === 'bootstrap') {
      var newUser = {
        id: "user-" + Utilities.getUuid(),
        email: (username.indexOf('@') !== -1 ? username : username + "@local").toLowerCase(),
        name: request.name || username,
        role: "senior-planner",
        doctorId: null,
        active: true,
        createdAt: new Date().toISOString(),
        passwordHash: passwordHash
      };
      if (!workspace.users) workspace.users = [];
      workspace.users.push(newUser);
      file.setContent(JSON.stringify(workspace, null, 2));
      return makeResponse_({ success: true, user: newUser, data: workspace });
    }
    
    // Standard credential verification
    var user = null;
    if (workspace.users) {
      for (var i = 0; i < workspace.users.length; i++) {
        var u = workspace.users[i];
        var uName = u.username || (u.email && u.email.split('@')[0]) || "";
        if (u.active && uName.toLowerCase() === username.toLowerCase()) {
          if (u.passwordHash === passwordHash) {
            user = u;
            break;
          }
        }
      }
    }
    
    if (!user) {
      return makeResponse_({ error: "שם משתמש או סיסמה שגויים." });
    }
    
    // User login verification
    if (action === 'login') {
      return makeResponse_({ success: true, user: user });
    }
    
    // Fetch schedule
    if (action === 'load') {
      return makeResponse_({ success: true, data: workspace });
    }
    
    // Save schedule modifications
    if (action === 'save') {
      var clientWorkspace = request.data;
      if (!clientWorkspace) {
        return makeResponse_({ error: "לא נשלחו נתונים לשמירה." });
      }
      
      // Preserve critical server-side structures to prevent clients from overriding user credentials
      clientWorkspace.users = workspace.users;
      clientWorkspace.updatedAt = new Date().toISOString();
      
      // Trigger Google Calendar Server-Side Sync (only for planners/chiefs)
      if (user.role === 'senior-planner' || user.role === 'chief-resident') {
        try {
          syncCalendar_(clientWorkspace);
        } catch (calErr) {
          Logger.log("Calendar sync failed: " + calErr.toString());
        }
      }
      
      file.setContent(JSON.stringify(clientWorkspace, null, 2));
      return makeResponse_({ success: true, data: clientWorkspace });
    }
    
    // Save updated users and doctors list (Admin only)
    if (action === 'admin_save_users') {
      if (user.role !== 'senior-planner') {
        return makeResponse_({ error: "רק מתכנן בכיר רשאי לנהל משתמשים וסיסמאות." });
      }
      var newUsersList = request.users;
      var newDoctorsList = request.doctors;
      if (!newUsersList && !newDoctorsList) {
        return makeResponse_({ error: "לא נשלחו נתונים לעדכון משתמשים או רופאים." });
      }
      if (newUsersList) {
        workspace.users = newUsersList;
      }
      if (newDoctorsList) {
        workspace.doctors = newDoctorsList;
      }
      workspace.updatedAt = new Date().toISOString();
      file.setContent(JSON.stringify(workspace, null, 2));
      return makeResponse_({ success: true, data: workspace });
    }
    
    // Save a snapshot image to Drive (Planner/Chief or any logged-in user making a swap)
    if (action === 'save_snapshot') {
      var imageName = request.imageName;
      var imageDataUri = request.imageDataUri;
      if (!imageName || !imageDataUri) {
        return makeResponse_({ error: "שם קובץ או תמונת Snapshot חסרים." });
      }
      
      var folderName = "shift-scheduler-snapshots";
      var folders = DriveApp.getFoldersByName(folderName);
      var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
      
      var base64Data = imageDataUri.split(',')[1];
      var decodedBytes = Utilities.base64Decode(base64Data);
      var blob = Utilities.newBlob(decodedBytes, 'image/png', imageName);
      
      var newFile = folder.createFile(blob);
      return makeResponse_({ success: true, fileId: newFile.getId(), url: newFile.getUrl() });
    }
    
    return makeResponse_({ error: "פעולה לא מוכרת." });
    
  } catch (err) {
    return makeResponse_({ error: "שגיאת שרת: " + err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function makeResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getDatabaseFile_() {
  var prop = PropertiesService.getScriptProperties();
  var fileId = prop.getProperty('DRIVE_FILE_ID');
  
  if (fileId) {
    try {
      return DriveApp.getFileById(fileId);
    } catch (e) {
      // File has been deleted or ID expired
    }
  }
  
  var fileName = "department-shift-scheduler.json";
  var files = DriveApp.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    prop.setProperty('DRIVE_FILE_ID', file.getId());
    return file;
  }
  
  // Default workspace structure
  var defaultWorkspace = {
    schemaVersion: 2,
    workspace: {
      name: "סידור תורנויות מחלקתי",
      timezone: "Asia/Jerusalem",
      locale: "he-IL"
    },
    roles: [
      { code: "resident-on-call", name: "תורן", color: "Red", eligibilityRule: "resident-only", order: 1 },
      { code: "senior-a", name: "כונן א", color: "Blue", eligibilityRule: "senior-only", order: 2 },
      { code: "senior-b", name: "כונן ב", color: "Green", eligibilityRule: "senior-only", order: 3 },
      { code: "angio", name: "כונן אנגיו", color: "Yellow", eligibilityRule: "angio-only", order: 4 },
      { code: "half-resident", name: "תורן חצי מתמחה", color: "Orange", eligibilityRule: "resident-then-senior", order: 5 },
      { code: "half-senior", name: "תורן חצי מומחה", color: "Purple", eligibilityRule: "senior-then-resident", order: 6 },
      { code: "friday-morning-resident", name: "שישי בוקר מתמחה", color: "Gray", eligibilityRule: "resident-only", order: 7 },
      { code: "friday-morning-senior", name: "שישי בוקר מומחה", color: "Gray", eligibilityRule: "senior-only", order: 8 }
    ],
    doctors: [],
    users: [],
    schedules: {},
    changeRequests: [],
    auditLog: [],
    calendar: {
      calendarInput: "",
      calendarId: "",
      syncRecords: {},
      lastDryRun: []
    },
    driveSync: {
      fileId: null,
      fileName: fileName,
      fileUrl: null,
      lastLoadedModifiedTime: null,
      lastSavedModifiedTime: null
    },
    updatedAt: new Date().toISOString()
  };
  
  var newFile = DriveApp.createFile(fileName, JSON.stringify(defaultWorkspace, null, 2), "application/json");
  prop.setProperty('DRIVE_FILE_ID', newFile.getId());
  return newFile;
}

function syncCalendar_(workspace) {
  var calendarId = workspace.calendar.calendarId;
  if (!calendarId) return;
  
  var calendar = null;
  try {
    calendar = CalendarApp.getCalendarById(calendarId);
  } catch (err) {
    Logger.log("Failed to load Google Calendar " + calendarId + ": " + err.toString());
    return;
  }
  
  if (!calendar) return;
  
  var schedules = workspace.schedules || {};
  var syncRecords = workspace.calendar.syncRecords || {};
  workspace.calendar.syncRecords = syncRecords;
  
  var doctorMap = {};
  if (workspace.doctors) {
    workspace.doctors.forEach(function(d) { doctorMap[d.id] = d; });
  }
  
  var roleMap = {};
  if (workspace.roles) {
    workspace.roles.forEach(function(r) { roleMap[r.code] = r; });
  }
  
  Object.keys(schedules).forEach(function(scheduleKey) {
    var schedule = schedules[scheduleKey];
    var assignments = schedule.assignments || {};
    var isPublished = schedule.status === 'published';
    
    Object.keys(assignments).forEach(function(assignmentKey) {
      var parts = assignmentKey.split('|');
      var dateStr = parts[0];
      var roleCode = parts[1];
      
      var record = syncRecords[assignmentKey];
      
      // If schedule is in draft, wipe calendar events we created for it
      if (!isPublished) {
        if (record && record.eventId) {
          try {
            var event = calendar.getEventById(record.eventId);
            if (event) event.deleteEvent();
          } catch(e) {}
          delete syncRecords[assignmentKey];
        }
        return;
      }
      
      var assignment = assignments[assignmentKey];
      var doctor = assignment.doctorId ? doctorMap[assignment.doctorId] : null;
      var role = roleMap[roleCode];
      
      // If assignment is cleared/pending, delete event if it exists
      if (!doctor || !role || assignment.pending) {
        if (record && record.eventId) {
          try {
            var event = calendar.getEventById(record.eventId);
            if (event) event.deleteEvent();
          } catch(e) {}
          delete syncRecords[assignmentKey];
        }
        return;
      }
      
      // Compute details for calendar sync
      var title = role.name + " | " + doctor.name;
      var eventDate = new Date(dateStr);
      var hashDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, title + "|" + dateStr);
      var hash = Utilities.base64Encode(hashDigest);
      
      if (record && record.eventId) {
        if (record.hash === hash) {
          return; // No updates needed
        }
        
        try {
          var event = calendar.getEventById(record.eventId);
          if (event) {
            event.setTitle(title);
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
          } else {
            // Re-create event if manually deleted in the Calendar UI
            event = calendar.createAllDayEvent(title, eventDate);
            record.eventId = event.getId();
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
          }
        } catch(e) {
          // Re-create on error
          var event = calendar.createAllDayEvent(title, eventDate);
          record.eventId = event.getId();
          record.hash = hash;
          record.lastSyncedAt = new Date().toISOString();
        }
      } else {
        // Create new event
        try {
          var event = calendar.createAllDayEvent(title, eventDate);
          syncRecords[assignmentKey] = {
            assignmentKey: assignmentKey,
            eventId: event.getId(),
            hash: hash,
            lastSyncedAt: new Date().toISOString()
          };
        } catch(e) {
          Logger.log("Error creating calendar event: " + e.toString());
        }
      }
    });
  });
}
