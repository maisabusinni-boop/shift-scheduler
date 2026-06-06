/**
 * Shift Scheduler Web App API Proxy Backend
 * 
 * Host this script as a standalone Google Apps Script or bound to a spreadsheet.
 * Deploy it as a Web App:
 * - Execute as: Me (Admin account)
 * - Who has access: Anyone (anonymous)
 */

var ADMIN_USERNAME = "admin";
var ADMIN_PASSWORD_HASH = "d9ba7b80630bd458c838b4845c325015939a38fc40e1567e1c543eda05c9a096";

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
    var workspace = ensureAdminAccount_(JSON.parse(fileContent));
    if (!workspace.registrationRequests) workspace.registrationRequests = [];

    // Public request flow: creates a pending registration/password-reset request only.
    if (action === 'submit_registration_request') {
      var doctorName = String(request.doctorName || "").trim();
      var gmail = String(request.gmail || "").trim().toLowerCase();
      var requestedUsername = String(request.username || "").trim().toLowerCase();
      var requestedPasswordHash = String(request.passwordHash || "");
      if (!doctorName) return makeResponse_({ error: "Doctor name is required." });
      if (!requestedUsername) return makeResponse_({ error: "Username is required." });
      if (!requestedPasswordHash) return makeResponse_({ error: "Password is required." });
      if (gmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail)) {
        return makeResponse_({ error: "Invalid Gmail address." });
      }
      var duplicatePending = workspace.registrationRequests.some(function(item) {
        return item.status === 'pending' && String(item.username || "").toLowerCase() === requestedUsername;
      });
      if (duplicatePending) {
        return makeResponse_({ error: "A pending request already exists for this username." });
      }
      var registrationRequest = {
        id: "reg-" + Utilities.getUuid(),
        doctorName: doctorName,
        gmail: gmail,
        username: requestedUsername,
        passwordHash: requestedPasswordHash,
        status: "pending",
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedByUserId: null,
        resolutionNote: ""
      };
      workspace.registrationRequests.push(registrationRequest);
      workspace.updatedAt = new Date().toISOString();
      file.setContent(JSON.stringify(workspace, null, 2));
      return makeResponse_({ success: true, request: registrationRequest });
    }
    
    // Bootstrap mode: If there are no users in the database, register the first user as a senior-planner
    var hasManagers = workspace.users && workspace.users.some(function(u) { return u.active && (u.role === 'senior-planner' || u.role === 'admin'); });
    if (!hasManagers && action === 'bootstrap') {
      var newUser = {
        id: "user-" + Utilities.getUuid(),
        username: username.toLowerCase(),
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
      clientWorkspace.registrationRequests = workspace.registrationRequests || [];
      clientWorkspace.updatedAt = new Date().toISOString();
      
      // Trigger Google Calendar Server-Side Sync (only for planners/chiefs)
      if (isPlannerLike_(user) || user.role === 'chief-resident') {
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
      if (!isPlannerLike_(user)) {
        return makeResponse_({ error: "רק מתכנן בכיר רשאי לנהל משתמשים וסיסמאות." });
      }
      var newUsersList = request.users;
      var newDoctorsList = request.doctors;
      var newRegistrationRequestsList = request.registrationRequests;
      if (!newUsersList && !newDoctorsList && !newRegistrationRequestsList) {
        return makeResponse_({ error: "לא נשלחו נתונים לעדכון משתמשים או רופאים." });
      }
      if (newDoctorsList) {
        workspace.doctors = newDoctorsList;
      }
      if (newUsersList) {
        workspace.users = reconcileUsersWithDoctors_(newUsersList, workspace.doctors);
      } else if (newDoctorsList) {
        workspace.users = reconcileUsersWithDoctors_(workspace.users || [], workspace.doctors);
      }
      if (newRegistrationRequestsList) {
        workspace.registrationRequests = newRegistrationRequestsList;
      }
      workspace = ensureAdminAccount_(workspace);
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

function reconcileUsersWithDoctors_(users, doctors) {
  var doctorIds = {};
  (doctors || []).forEach(function(doctor) {
    if (doctor && doctor.id) doctorIds[doctor.id] = true;
  });
  return (users || []).filter(function(user) {
    return user && (!user.doctorId || doctorIds[user.doctorId]);
  });
}

function isPlannerLike_(user) {
  return user && (user.role === 'senior-planner' || user.role === 'admin');
}

function ensureAdminAccount_(workspace) {
  if (!workspace.users) workspace.users = [];
  var adminIndex = -1;
  for (var i = 0; i < workspace.users.length; i++) {
    var user = workspace.users[i] || {};
    var username = String(user.username || (user.email ? String(user.email).split('@')[0] : user.id) || "").trim().toLowerCase();
    if (username === ADMIN_USERNAME || user.id === "user-admin") {
      adminIndex = i;
      break;
    }
  }

  var existing = adminIndex >= 0 ? workspace.users[adminIndex] || {} : {};
  var adminUser = {
    id: "user-admin",
    username: ADMIN_USERNAME,
    email: "admin@local",
    name: "admin",
    role: "admin",
    doctorId: null,
    active: true,
    createdAt: existing.createdAt || "2026-01-01T00:00:00.000Z",
    passwordHash: ADMIN_PASSWORD_HASH
  };

  if (adminIndex >= 0) {
    workspace.users[adminIndex] = adminUser;
  } else {
    workspace.users.unshift(adminUser);
  }
  return workspace;
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
      { code: "resident-on-call", name: "תורן", color: "#dc2626", eligibilityRule: "resident-only", order: 1 },
      { code: "senior-a", name: "כונן א", color: "#2563eb", eligibilityRule: "senior-only", order: 2 },
      { code: "senior-b", name: "כונן ב", color: "#16a34a", eligibilityRule: "senior-only", order: 3 },
      { code: "angio", name: "כונן אנגיו", color: "#ca8a04", eligibilityRule: "angio-only", order: 4 },
      { code: "half-resident", name: "תורן חצי מתמחה", color: "#ea580c", eligibilityRule: "resident-then-senior", order: 5 },
      { code: "half-senior", name: "תורן חצי מומחה", color: "#9333ea", eligibilityRule: "senior-then-resident", order: 6 },
      { code: "friday-morning-resident", name: "שישי בוקר מתמחה", color: "#64748b", eligibilityRule: "resident-only", order: 7 },
      { code: "friday-morning-senior", name: "שישי בוקר מומחה", color: "#475569", eligibilityRule: "senior-only", order: 8 }
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
  
  defaultWorkspace = ensureAdminAccount_(defaultWorkspace);
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

  var userEmailsByDoctorId = {};
  if (workspace.users) {
    workspace.users.forEach(function(u) {
      if (!u || !u.active || !u.doctorId) return;
      var email = normalizeCalendarRecipientEmail_(u.email);
      if (!email) return;
      if (!userEmailsByDoctorId[u.doctorId]) userEmailsByDoctorId[u.doctorId] = [];
      if (userEmailsByDoctorId[u.doctorId].indexOf(email) === -1) {
        userEmailsByDoctorId[u.doctorId].push(email);
      }
    });
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
      var attendeeEmails = (userEmailsByDoctorId[doctor.id] || []).slice().sort();
      if (!attendeeEmails.length) {
        if (record && record.eventId) {
          try {
            var emptyEvent = calendar.getEventById(record.eventId);
            if (emptyEvent) emptyEvent.deleteEvent();
          } catch (e) {}
          delete syncRecords[assignmentKey];
        }
        return;
      }
      var hashDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, title + "|" + dateStr + "|" + attendeeEmails.join(","));
      var hash = Utilities.base64Encode(hashDigest);
      
      if (record && record.eventId) {
        if (record.hash === hash) {
          return; // No updates needed
        }
        
        try {
          var event = calendar.getEventById(record.eventId);
          if (event) {
            event.setTitle(title);
            syncEventGuests_(event, attendeeEmails);
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
            record.attendeeEmails = attendeeEmails;
          } else {
            // Re-create event if manually deleted in the Calendar UI
            event = calendar.createAllDayEvent(title, eventDate);
            syncEventGuests_(event, attendeeEmails);
            record.eventId = event.getId();
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
            record.attendeeEmails = attendeeEmails;
          }
        } catch(e) {
          // Re-create on error
          var event = calendar.createAllDayEvent(title, eventDate);
          syncEventGuests_(event, attendeeEmails);
          record.eventId = event.getId();
          record.hash = hash;
          record.lastSyncedAt = new Date().toISOString();
          record.attendeeEmails = attendeeEmails;
        }
      } else {
        // Create new event
        try {
          var event = calendar.createAllDayEvent(title, eventDate);
          syncEventGuests_(event, attendeeEmails);
          syncRecords[assignmentKey] = {
            assignmentKey: assignmentKey,
            eventId: event.getId(),
            hash: hash,
            lastSyncedAt: new Date().toISOString(),
            attendeeEmails: attendeeEmails
          };
        } catch(e) {
          Logger.log("Error creating calendar event: " + e.toString());
        }
      }
    });
  });
}

function normalizeCalendarRecipientEmail_(email) {
  if (!email) return "";
  var normalized = String(email).trim().toLowerCase();
  if (!normalized || /@local$/.test(normalized)) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function syncEventGuests_(event, attendeeEmails) {
  var guestMap = {};
  event.getGuestList().forEach(function(guest) {
    guestMap[String(guest.getEmail()).trim().toLowerCase()] = guest;
  });

  var desiredMap = {};
  attendeeEmails.forEach(function(email) {
    desiredMap[email] = true;
    if (!guestMap[email]) {
      event.addGuest(email);
    }
  });

  Object.keys(guestMap).forEach(function(email) {
    if (!desiredMap[email]) {
      try {
        event.removeGuest(email);
      } catch (err) {
        Logger.log("Failed removing guest " + email + ": " + err.toString());
      }
    }
  });
}
