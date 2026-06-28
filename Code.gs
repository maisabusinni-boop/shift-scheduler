/**
 * Shift Scheduler Web App API Proxy Backend
 * 
 * Host this script as a standalone Google Apps Script or bound to a spreadsheet.
 * Deploy it as a Web App:
 * - Execute as: Me (Admin account)
 * - Who has access: Anyone (anonymous)
 */

var API_VERSION = 2;
var MAX_MUTATIONS_PER_BATCH = 50;

function doPost(e) {
  var startedAt = Date.now();
  try {
    if (!e || !e.postData || !e.postData.contents) return errorResponse_("INVALID_COMMAND", "Missing request body.", false);
    var request = JSON.parse(e.postData.contents);
    var action = String(request.action || "");

    if (action === "status") {
      return makeResponse_({ success: true, apiVersion: API_VERSION, legacyWritesAllowed: legacyWritesAllowed_(), calendarTriggerInstalled: calendarTriggerInstalled_() });
    }
    if (action === "save" || action === "admin_save_users") {
      if (!legacyWritesAllowed_()) return errorResponse_("UPGRADE_REQUIRED", "Please refresh the app before saving.", false);
      return legacyDoPost(e);
    }
    if (action === "submit_registration_request") return submitRegistrationRequest_(request);
    if (action === "bootstrap") return bootstrapPlanner_(request);

    var workspace = readWorkspace_();
    var user = authenticate_(workspace, request.username, request.passwordHash);
    if (!user) return errorResponse_("AUTH_FAILED", "Invalid username or password.", false);

    if (action === "login") return makeResponse_({ success: true, apiVersion: API_VERSION, user: sanitizeUser_(user) });
    if (action === "load") return workspaceResponse_(workspace);
    if (action === "mutate") return mutateWorkspace_(request, user, startedAt);
    if (action === "save_snapshot") return saveSnapshot_(request);
    if (action === "kick_calendar_sync") {
      processCalendarSyncQueue();
      return makeResponse_({ success: true, apiVersion: API_VERSION });
    }
    return errorResponse_("INVALID_COMMAND", "Unknown action.", false);
  } catch (err) {
    Logger.log(JSON.stringify({ kind: "request-error", durationMs: Date.now() - startedAt, message: String(err) }));
    return errorResponse_("SERVER_ERROR", "Server request failed.", true);
  }
}

function mutateWorkspace_(request, authenticatedUser, startedAt) {
  var mutations = Array.isArray(request.mutations) ? request.mutations : [];
  if (!mutations.length || mutations.length > MAX_MUTATIONS_PER_BATCH) return errorResponse_("INVALID_COMMAND", "A batch must contain 1-50 commands.", false);
  var lock = LockService.getScriptLock();
  var waitStarted = Date.now();
  if (!lock.tryLock(5000)) return errorResponse_("BUSY", "The server is busy. The change remains queued.", true);
  var lockWaitMs = Date.now() - waitStarted;
  try {
    var workspace = readWorkspace_();
    var user = authenticate_(workspace, request.username, request.passwordHash);
    if (!user || user.id !== authenticatedUser.id) return errorResponse_("AUTH_FAILED", "The session is no longer valid.", false);
    var results = [];
    var changed = false;
    var calendarAffected = false;

    mutations.forEach(function(command) {
      var mutationStarted = Date.now();
      var id = String(command && command.id || "");
      var type = String(command && command.type || "");
      if (!id || !type) {
        results.push({ id: id, status: "rejected", errorCode: "INVALID_COMMAND", message: "Mutation id and type are required." });
        return;
      }
      if ((workspace.auditLog || []).some(function(entry) { return entry.mutationId === id; })) {
        results.push({ id: id, status: "duplicate" });
        return;
      }
      var snapshot = clone_(workspace);
      try {
        var applied = applyCommand_(workspace, user, command);
        workspace.revision = Number(workspace.revision || 0) + 1;
        workspace.updatedAt = new Date().toISOString();
        (applied.scheduleKeys || []).forEach(function(scheduleKey) {
          if (workspace.schedules[scheduleKey]) workspace.schedules[scheduleKey].revision = Number(workspace.schedules[scheduleKey].revision || 0) + 1;
        });
        if (applied.calendarAffected) {
          calendarAffected = true;
          workspace.calendar.syncPending = true;
          workspace.calendar.requestedRevision = workspace.revision;
          workspace.calendar.lastSyncError = null;
        }
        workspace.auditLog = workspace.auditLog || [];
        workspace.auditLog.unshift(buildAuditEntry_(workspace, user, command, request.deviceId, applied));
        results.push({ id: id, status: "applied" });
        changed = true;
        Logger.log(JSON.stringify({ kind: "mutation", mutationId: id, type: type, userId: user.id, status: "applied", lockWaitMs: lockWaitMs, durationMs: Date.now() - mutationStarted, revision: workspace.revision }));
      } catch (err) {
        workspace = snapshot;
        var code = err && err.code ? err.code : "INVALID_COMMAND";
        results.push({ id: id, status: code === "CONFLICT" ? "conflict" : "rejected", errorCode: code, message: err && err.message ? err.message : String(err) });
        Logger.log(JSON.stringify({ kind: "mutation", mutationId: id, type: type, userId: user.id, status: code, lockWaitMs: lockWaitMs, durationMs: Date.now() - mutationStarted, revision: workspace.revision }));
      }
    });

    if (changed) writeWorkspace_(workspace);
    var response = sanitizedWorkspace_(workspace);
    return makeResponse_({ success: true, apiVersion: API_VERSION, revision: workspace.revision, data: response, calendarSyncPending: Boolean(calendarAffected || workspace.calendar.syncPending), results: results, durationMs: Date.now() - startedAt });
  } finally {
    lock.releaseLock();
  }
}

function applyCommand_(workspace, user, command) {
  var payload = command.payload || {};
  var action = String(command.type || "");
  var scheduleKey = payload.scheduleKey;
  var schedule = scheduleKey ? workspace.schedules[scheduleKey] : null;
  var planner = isPlannerLike_(user);
  var draftEditor = planner || user.role === "chief-resident";
  var scheduleKeys = [];
  var calendarAffected = false;

  if (action === "schedule-create") {
    require_(draftEditor, "FORBIDDEN", "This user cannot create schedules.");
    require_(payload.schedule && !workspace.schedules[payload.schedule.key], "CONFLICT", "The schedule already exists.");
    workspace.schedules[payload.schedule.key] = payload.schedule;
    workspace.schedules[payload.schedule.key].revision = 0;
    scheduleKeys.push(payload.schedule.key);
  } else if (action === "assignment-update") {
    require_(draftEditor && schedule && schedule.status === "draft", "FORBIDDEN", "This schedule cannot be edited by this user.");
    var afterAssignments = payload.after || {};
    var expectedAssignments = command.expected || {};
    Object.keys(afterAssignments).forEach(function(key) {
      require_(deepEqual_(schedule.assignments[key] || null, expectedAssignments[key] || null), "CONFLICT", "That assignment was changed by another user.");
    });
    Object.keys(afterAssignments).forEach(function(key) { schedule.assignments[key] = afterAssignments[key]; });
    schedule.validation.stale = true;
    scheduleKeys.push(scheduleKey);
  } else if (action === "schedule-generate-auto") {
    require_(draftEditor && schedule && schedule.status === "draft", "FORBIDDEN", "This schedule cannot be generated by this user.");
    require_(deepEqual_(schedule.assignments, command.expected || {}), "CONFLICT", "The schedule changed before generation completed.");
    schedule.assignments = payload.after || {};
    schedule.validation.stale = true;
    scheduleKeys.push(scheduleKey);
  } else if (action === "schedule-validate" || action === "publish-blocked") {
    require_(draftEditor && schedule, "FORBIDDEN", "This schedule cannot be validated by this user.");
    schedule.validation = payload.after;
    scheduleKeys.push(scheduleKey);
  } else if (action === "schedule-publish" || action === "schedule-unpublish") {
    require_(planner && schedule, "FORBIDDEN", "Only a senior planner can publish schedules.");
    require_(payload.schedule && Number(payload.expectedScheduleRevision || 0) === Number(schedule.revision || 0), "CONFLICT", "The schedule changed before publication.");
    if (action === "schedule-publish") {
      var serverIssues = validateScheduleForPublish_(schedule, workspace.roles || [], workspace.doctors || []);
      require_(!serverIssues.some(function(issue) { return issue.severity === "error"; }), "VALIDATION_FAILED", "The schedule contains blocking validation errors.");
      payload.schedule.validation = { checkedAt: new Date().toISOString(), stale: false, issues: serverIssues };
    }
    schedule.status = payload.schedule.status;
    schedule.validation = payload.schedule.validation;
    schedule.publishSnapshots = payload.schedule.publishSnapshots || schedule.publishSnapshots;
    scheduleKeys.push(scheduleKey);
    calendarAffected = true;
  } else if (action === "exclusion-create") {
    require_(schedule, "INVALID_COMMAND", "Schedule not found.");
    var additions = Array.isArray(payload.after) ? payload.after : [];
    additions.forEach(function(item) {
      require_(planner || (user.doctorId && item.doctorId === user.doctorId), "FORBIDDEN", "Users may edit only their own exclusions.");
      if (!schedule.exclusions.some(function(existing) { return existing.id === item.id; })) schedule.exclusions.push(item);
    });
    schedule.validation.stale = true;
    scheduleKeys.push(scheduleKey);
  } else if (action === "exclusion-delete") {
    require_(schedule, "INVALID_COMMAND", "Schedule not found.");
    var exclusion = schedule.exclusions.find(function(item) { return item.id === payload.entityId; });
    require_(exclusion, "CONFLICT", "The exclusion no longer exists.");
    require_(planner || (user.doctorId && exclusion.doctorId === user.doctorId), "FORBIDDEN", "Users may delete only their own exclusions.");
    schedule.exclusions = schedule.exclusions.filter(function(item) { return item.id !== payload.entityId; });
    schedule.validation.stale = true;
    scheduleKeys.push(scheduleKey);
  } else if (action === "doctor-create" || action === "doctor-update" || action === "doctor-toggle-active" || action === "doctor-user-update") {
    require_(planner, "FORBIDDEN", "Only a senior planner can manage doctors.");
    var doctorAfter = action === "doctor-user-update" ? payload.after.doctor : payload.after;
    var currentDoctor = workspace.doctors.find(function(item) { return item.id === payload.entityId; });
    if (action === "doctor-create") {
      require_(!currentDoctor, "CONFLICT", "The doctor already exists.");
      workspace.doctors.push(doctorAfter);
    } else {
      var expectedDoctor = action === "doctor-user-update" && command.expected ? command.expected.doctor : command.expected;
      require_(currentDoctor && deepEqual_(currentDoctor, expectedDoctor), "CONFLICT", "The doctor was changed by another user.");
      workspace.doctors = workspace.doctors.map(function(item) { return item.id === payload.entityId ? doctorAfter : item; });
    }
    if (action === "doctor-user-update" && payload.after.user) upsertUserPreservingPassword_(workspace, payload.after.user);
    calendarAffected = true;
  } else if (action === "doctor-remove") {
    require_(planner, "FORBIDDEN", "Only a senior planner can remove doctors.");
    var doctorToRemove = workspace.doctors.find(function(item) { return item.id === payload.entityId; });
    require_(doctorToRemove && deepEqual_(doctorToRemove, command.expected), "CONFLICT", "The doctor was changed before removal.");
    removeDoctor_(workspace, payload.entityId);
    scheduleKeys = Object.keys(workspace.schedules);
    calendarAffected = true;
  } else if (action === "registration-approve-new" || action === "registration-approve-merge" || action === "registration-reject") {
    require_(planner, "FORBIDDEN", "Only a senior planner can decide registration requests.");
    var registration = workspace.registrationRequests.find(function(item) { return item.id === payload.entityId; });
    require_(registration && registration.status === "pending", "CONFLICT", "The registration request was already resolved.");
    var registrationAfter = payload.after || {};
    workspace.doctors = registrationAfter.doctors || workspace.doctors;
    if (action !== "registration-reject") {
      (registrationAfter.users || []).forEach(function(candidate) {
        if ((!candidate.passwordHash) && candidate.username === registration.username) candidate.passwordHash = registration.passwordHash;
        upsertUserPreservingPassword_(workspace, candidate);
      });
    }
    workspace.registrationRequests = (registrationAfter.registrationRequests || workspace.registrationRequests).map(function(item) {
      if (item.id !== registration.id) return item;
      var resolved = clone_(item);
      resolved.passwordHash = registration.passwordHash;
      return resolved;
    });
    calendarAffected = action !== "registration-reject";
  } else if (action === "request-create" || action === "request-create-published-swap") {
    require_(user.doctorId, "FORBIDDEN", "A linked doctor account is required.");
    var created = payload.after && payload.after.request ? payload.after.request : payload.after;
    created.requesterUserId = user.id;
    created.requesterDoctorId = user.doctorId;
    created.requesterRole = user.role;
    created.status = user.role === "senior" ? "senior-confirmed" : "submitted";
    created.decidedAt = null;
    created.decidedByUserId = null;
    created.appliedAt = null;
    created.appliedByUserId = null;
    var requestSchedule = workspace.schedules[created.scheduleKey];
    require_(requestSchedule, "INVALID_COMMAND", "Schedule not found.");
    var requestAssignment = requestSchedule.assignments[created.date + "|" + created.roleCode];
    created.currentDoctorId = requestAssignment ? requestAssignment.doctorId : null;
    if (!workspace.changeRequests.some(function(item) { return item.id === created.id; })) workspace.changeRequests.unshift(created);
  } else if (action === "request-approve" || action === "request-reject" || action === "published-swap-rejected") {
    require_(planner || user.role === "chief-resident", "FORBIDDEN", "This user cannot review requests.");
    var requestAfter = clone_(payload.after);
    var currentRequest = workspace.changeRequests.find(function(item) { return item.id === payload.entityId; });
    require_(currentRequest, "CONFLICT", "The request no longer exists.");
    require_(deepEqual_(currentRequest, command.expected), "CONFLICT", "The request was already changed.");
    requestAfter.status = action === "request-approve" ? "approved" : "rejected";
    requestAfter.decidedAt = new Date().toISOString();
    requestAfter.decidedByUserId = user.id;
    requestAfter.updatedAt = requestAfter.decidedAt;
    workspace.changeRequests = workspace.changeRequests.map(function(item) { return item.id === payload.entityId ? requestAfter : item; });
  } else if (action === "request-apply-to-schedule" || action === "published-swap-approved" || action === "published-swap-direct") {
    require_(planner || user.role === "chief-resident" || user.role === "senior", "FORBIDDEN", "This user cannot apply the published change.");
    require_(schedule, "INVALID_COMMAND", "Schedule not found.");
    var after = payload.after || {};
    var targetKey = payload.date + "|" + payload.roleCode;
    var expected = command.expected || {};
    if (expected.assignment !== undefined) require_(deepEqual_(schedule.assignments[targetKey] || null, expected.assignment), "CONFLICT", "The target assignment changed.");
    if (after.assignment) schedule.assignments[targetKey] = after.assignment;
    var details = payload.changeDetails;
    if (action === "published-swap-direct" && user.role === "senior") {
      var sourceDoctor = details && details.source ? workspace.doctors.find(function(item) { return item.id === details.source.doctorId; }) : null;
      require_(sourceDoctor && sourceDoctor.group === "senior", "FORBIDDEN", "Senior users may directly change only senior assignments.");
    }
    if (details && details.source && after.sourceAssignment !== undefined) {
      var sourceKey = details.source.date + "|" + details.source.roleCode;
      if (expected.sourceAssignment !== undefined) require_(deepEqual_(schedule.assignments[sourceKey] || null, expected.sourceAssignment), "CONFLICT", "The source assignment changed.");
      schedule.assignments[sourceKey] = after.sourceAssignment;
    }
    var changedRequest = after.request || payload.request;
    if (changedRequest) {
      var currentChangedRequest = workspace.changeRequests.find(function(item) { return item.id === changedRequest.id; });
      require_(currentChangedRequest, "CONFLICT", "The request no longer exists.");
      require_(planner || (user.role === "chief-resident" && (currentChangedRequest.status === "approved" || currentChangedRequest.status === "senior-confirmed")), "FORBIDDEN", "This request is not ready to apply.");
      changedRequest.status = "applied";
      changedRequest.appliedAt = new Date().toISOString();
      changedRequest.appliedByUserId = user.id;
      changedRequest.updatedAt = changedRequest.appliedAt;
      workspace.changeRequests = workspace.changeRequests.map(function(item) { return item.id === changedRequest.id ? changedRequest : item; });
    }
    schedule.validation.stale = true;
    scheduleKeys.push(scheduleKey);
    calendarAffected = true;
  } else if (action === "calendar-dry-run" || action === "calendar-mock-sync" || action === "calendar-settings-save") {
    require_(planner, "FORBIDDEN", "Only a senior planner can configure Calendar.");
    if (action === "calendar-settings-save" && command.expected) {
      require_(workspace.calendar.calendarInput === command.expected.calendarInput && workspace.calendar.calendarId === command.expected.calendarId, "CONFLICT", "Calendar settings were changed by another user.");
    }
    if (payload.calendar) workspace.calendar = mergeCalendarState_(workspace.calendar, payload.calendar);
    calendarAffected = true;
  } else if (action === "test-data-load") {
    require_(planner && String(PropertiesService.getScriptProperties().getProperty("ALLOW_TEST_DATA") || "false") === "true", "FORBIDDEN", "Test data loading is disabled.");
    workspace.doctors = payload.doctors || workspace.doctors;
    (payload.users || []).forEach(function(item) { upsertUserPreservingPassword_(workspace, item); });
  } else if (action === "workspace-import") {
    require_(planner, "FORBIDDEN", "Only a senior planner can import a workspace.");
    require_(Number(command.expected) === Number(workspace.revision), "CONFLICT", "The workspace changed before import.");
    var imported = migrateWorkspace_(payload.workspace);
    imported.revision = workspace.revision;
    imported._server = workspace._server;
    Object.keys(workspace).forEach(function(key) { delete workspace[key]; });
    Object.keys(imported).forEach(function(key) { workspace[key] = imported[key]; });
  } else {
    fail_("INVALID_COMMAND", "Unsupported mutation type: " + action);
  }
  return { scheduleKeys: scheduleKeys, calendarAffected: calendarAffected, entityType: payload.entityType, entityId: payload.entityId, scheduleKey: scheduleKey, date: payload.date, roleCode: payload.roleCode, before: command.expected, after: payload.after, changeCode: payload.changeCode, changeKind: payload.changeKind, changeDetails: payload.changeDetails };
}

function buildAuditEntry_(workspace, user, command, deviceId, applied) {
  var now = new Date();
  return {
    id: "audit-" + Utilities.getUuid(), mutationId: command.id, timestamp: now.toISOString(),
    displayTime: Utilities.formatDate(now, "Asia/Jerusalem", "dd/MM/yyyy HH:mm:ss"),
    actorEmail: user.email || user.username || "", actorName: user.name || user.username || "", actorUserId: user.id,
    actorRole: user.role, action: command.type, entityType: applied.entityType || "settings", entityId: applied.entityId || command.id,
    scheduleKey: applied.scheduleKey, date: applied.date, roleCode: applied.roleCode, before: applied.before, after: applied.after,
    deviceId: String(deviceId || "unknown"), changeCode: applied.changeCode, changeKind: applied.changeKind, changeDetails: applied.changeDetails,
    driveVersion: String(workspace.revision)
  };
}

function workspaceResponse_(workspace) {
  return makeResponse_({ success: true, apiVersion: API_VERSION, revision: workspace.revision, data: sanitizedWorkspace_(workspace), calendarSyncPending: Boolean(workspace.calendar.syncPending) });
}

function sanitizedWorkspace_(workspace) {
  var result = clone_(workspace);
  delete result._server;
  (result.users || []).forEach(function(user) { delete user.passwordHash; });
  (result.registrationRequests || []).forEach(function(request) { delete request.passwordHash; });
  return result;
}

function sanitizeUser_(user) { var result = clone_(user); delete result.passwordHash; return result; }
function clone_(value) { return JSON.parse(JSON.stringify(value)); }
function deepEqual_(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
function fail_(code, message) { var error = new Error(message); error.code = code; throw error; }
function require_(condition, code, message) { if (!condition) fail_(code, message); }
function errorResponse_(code, message, retryable, details) { return makeResponse_({ success: false, apiVersion: API_VERSION, error: message, errorCode: code, retryable: Boolean(retryable), details: details || null }); }
function legacyWritesAllowed_() { return String(PropertiesService.getScriptProperties().getProperty("ALLOW_LEGACY_WRITES") || "false") === "true"; }
function calendarTriggerInstalled_() { return ScriptApp.getProjectTriggers().some(function(trigger) { return trigger.getHandlerFunction() === "processCalendarSyncQueue"; }); }

function readWorkspace_() {
  var file = getDatabaseFile_();
  var workspace = JSON.parse(file.getAs("application/json").getDataAsString());
  return migrateWorkspace_(workspace);
}

function writeWorkspace_(workspace) { getDatabaseFile_().setContent(JSON.stringify(workspace, null, 2)); }

function migrateWorkspace_(workspace) {
  workspace = workspace || {};
  workspace.schemaVersion = 3;
  workspace.revision = Number(workspace.revision || 0);
  workspace.users = (workspace.users || []).filter(function(user) { return user.id !== "user-admin" && String(user.username || "").toLowerCase() !== "admin"; });
  workspace.registrationRequests = workspace.registrationRequests || [];
  workspace.changeRequests = workspace.changeRequests || [];
  workspace.auditLog = workspace.auditLog || [];
  workspace.schedules = workspace.schedules || {};
  Object.keys(workspace.schedules).forEach(function(key) { workspace.schedules[key].revision = Number(workspace.schedules[key].revision || 0); });
  workspace.calendar = mergeCalendarState_({ syncRecords: {}, lastDryRun: [] }, workspace.calendar || {});
  workspace._server = workspace._server || { calendarLease: null, calendarAttempt: 0, nextCalendarAttemptAt: null };
  return workspace;
}

function mergeCalendarState_(current, incoming) {
  var result = {};
  Object.keys(current || {}).forEach(function(key) { result[key] = current[key]; });
  Object.keys(incoming || {}).forEach(function(key) { result[key] = incoming[key]; });
  result.syncRecords = result.syncRecords || {};
  result.lastDryRun = result.lastDryRun || [];
  result.syncPending = Boolean(result.syncPending);
  result.requestedRevision = result.requestedRevision == null ? null : Number(result.requestedRevision);
  result.lastCompletedRevision = result.lastCompletedRevision == null ? null : Number(result.lastCompletedRevision);
  result.lastSyncAt = result.lastSyncAt || null;
  result.lastSyncError = result.lastSyncError || null;
  return result;
}

function authenticate_(workspace, username, passwordHash) {
  var normalized = String(username || "").trim().toLowerCase();
  return (workspace.users || []).find(function(user) {
    var candidate = String(user.username || (user.email ? user.email.split("@")[0] : "")).toLowerCase();
    return user.active && candidate === normalized && user.passwordHash === passwordHash;
  }) || null;
}

function upsertUserPreservingPassword_(workspace, incoming) {
  var index = workspace.users.findIndex(function(user) { return user.id === incoming.id || (incoming.doctorId && user.doctorId === incoming.doctorId); });
  if (index < 0) { workspace.users.push(incoming); return; }
  var current = workspace.users[index];
  var next = clone_(incoming);
  if (!next.passwordHash) next.passwordHash = current.passwordHash;
  workspace.users[index] = next;
}

function removeDoctor_(workspace, doctorId) {
  workspace.doctors = workspace.doctors.filter(function(item) { return item.id !== doctorId; });
  workspace.users = workspace.users.filter(function(item) { return item.doctorId !== doctorId; });
  Object.keys(workspace.schedules).forEach(function(key) {
    var schedule = workspace.schedules[key];
    Object.keys(schedule.assignments || {}).forEach(function(assignmentKey) { if (schedule.assignments[assignmentKey].doctorId === doctorId) schedule.assignments[assignmentKey] = { doctorId: null, pending: false }; });
    schedule.exclusions = (schedule.exclusions || []).filter(function(item) { return item.doctorId !== doctorId; });
    schedule.validation.stale = true;
  });
  workspace.changeRequests = workspace.changeRequests.filter(function(item) { return item.requesterDoctorId !== doctorId && item.currentDoctorId !== doctorId && item.proposedDoctorId !== doctorId && item.sourceDoctorId !== doctorId; });
}

function validateScheduleForPublish_(schedule, roles, doctors) {
  var issues = [];
  var roleMap = {}; roles.forEach(function(role) { roleMap[role.code] = role; });
  var doctorMap = {}; doctors.forEach(function(doctor) { doctorMap[doctor.id] = doctor; });
  var exclusions = {};
  (schedule.exclusions || []).forEach(function(item) { exclusions[item.date + "|" + (item.roleCode || "*") + "|" + item.doctorId] = true; });
  var perDay = {};
  Object.keys(schedule.assignments || {}).forEach(function(key) {
    var assignment = schedule.assignments[key];
    if (!assignment || !assignment.doctorId || assignment.pending) return;
    var parts = key.split("|"); var date = parts[0]; var roleCode = parts[1];
    var role = roleMap[roleCode]; var doctor = doctorMap[assignment.doctorId];
    if (!role || !doctor || !doctor.active) { issues.push(validationIssue_("Assigned doctor or role is unavailable.", date, roleCode)); return; }
    var eligible = role.eligibilityRule === "resident-only" ? doctor.group === "resident" :
      role.eligibilityRule === "senior-only" ? doctor.group === "senior" :
      role.eligibilityRule === "angio-only" ? Boolean(doctor.canAngio) : true;
    if (!eligible) issues.push(validationIssue_("Doctor is not eligible for this role.", date, roleCode));
    if ((roleCode === "friday-morning-resident" || roleCode === "friday-morning-senior") && new Date(date + "T00:00:00.000Z").getUTCDay() !== 5) issues.push(validationIssue_("Friday-only role is assigned on another day.", date, roleCode));
    if (exclusions[date + "|*|" + doctor.id] || exclusions[date + "|" + roleCode + "|" + doctor.id]) issues.push(validationIssue_("Doctor is excluded on this date.", date, roleCode));
    perDay[date] = perDay[date] || [];
    perDay[date].push({ doctorId: doctor.id, roleCode: roleCode });
  });
  Object.keys(perDay).forEach(function(date) {
    var rows = perDay[date];
    for (var i = 0; i < rows.length; i++) for (var j = i + 1; j < rows.length; j++) {
      if (rows[i].doctorId !== rows[j].doctorId) continue;
      var fridaySeniorPair = new Date(date + "T00:00:00.000Z").getUTCDay() === 5 &&
        ((rows[i].roleCode === "senior-a" && rows[j].roleCode === "friday-morning-senior") || (rows[j].roleCode === "senior-a" && rows[i].roleCode === "friday-morning-senior"));
      if (!fridaySeniorPair) issues.push(validationIssue_("Doctor is assigned more than once on the same day.", date, rows[j].roleCode));
    }
  });
  return issues;
}

function validationIssue_(message, date, roleCode) {
  return { id: "error-" + date + "-" + roleCode + "-" + message, severity: "error", message: message, date: date, roleCode: roleCode, cellKey: date + "|" + roleCode };
}

function saveSnapshot_(request) {
  if (!request.imageName || !request.imageDataUri) return errorResponse_("INVALID_COMMAND", "Snapshot data is required.", false);
  var folders = DriveApp.getFoldersByName("shift-scheduler-snapshots");
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder("shift-scheduler-snapshots");
  var bytes = Utilities.base64Decode(String(request.imageDataUri).split(",")[1]);
  var file = folder.createFile(Utilities.newBlob(bytes, "image/png", request.imageName));
  return makeResponse_({ success: true, apiVersion: API_VERSION, fileId: file.getId(), url: file.getUrl() });
}

function submitRegistrationRequest_(request) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return errorResponse_("BUSY", "The server is busy.", true);
  try {
    var workspace = readWorkspace_();
    var requestId = String(request.requestId || "reg-" + Utilities.getUuid());
    var duplicateById = workspace.registrationRequests.find(function(item) { return item.id === requestId; });
    if (duplicateById) return makeResponse_({ success: true, apiVersion: API_VERSION, request: sanitizedRegistration_(duplicateById) });
    var username = String(request.username || "").trim().toLowerCase();
    require_(username && request.doctorName && request.passwordHash, "INVALID_COMMAND", "Registration fields are required.");
    require_(!workspace.registrationRequests.some(function(item) { return item.status === "pending" && item.username === username; }), "CONFLICT", "A pending request already exists for this username.");
    var item = { id: requestId, doctorName: String(request.doctorName).trim(), gmail: String(request.gmail || "").trim().toLowerCase(), username: username, passwordHash: request.passwordHash, status: "pending", createdAt: new Date().toISOString(), decidedAt: null, decidedByUserId: null, resolutionNote: "" };
    workspace.registrationRequests.push(item); workspace.revision += 1; workspace.updatedAt = new Date().toISOString(); writeWorkspace_(workspace);
    return makeResponse_({ success: true, apiVersion: API_VERSION, request: sanitizedRegistration_(item) });
  } catch (err) { return errorResponse_(err.code || "INVALID_COMMAND", err.message || String(err), false); }
  finally { lock.releaseLock(); }
}

function sanitizedRegistration_(item) { var result = clone_(item); delete result.passwordHash; return result; }

function bootstrapPlanner_(request) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return errorResponse_("BUSY", "The server is busy.", true);
  try {
    var workspace = readWorkspace_();
    var hasManager = workspace.users.some(function(user) { return user.active && (user.role === "senior-planner" || user.role === "admin"); });
    require_(!hasManager, "FORBIDDEN", "A senior planner already exists.");
    var user = { id: "user-" + Utilities.getUuid(), username: String(request.username || "").trim().toLowerCase(), email: String(request.username || "").indexOf("@") >= 0 ? String(request.username).toLowerCase() : String(request.username).toLowerCase() + "@local", name: request.name || request.username, role: "senior-planner", doctorId: null, active: true, createdAt: new Date().toISOString(), passwordHash: request.passwordHash };
    workspace.users.push(user); workspace.revision += 1; workspace.updatedAt = new Date().toISOString(); writeWorkspace_(workspace);
    return makeResponse_({ success: true, apiVersion: API_VERSION, user: sanitizeUser_(user), data: sanitizedWorkspace_(workspace) });
  } catch (err) { return errorResponse_(err.code || "INVALID_COMMAND", err.message || String(err), false); }
  finally { lock.releaseLock(); }
}

function installCalendarSyncTrigger() {
  ScriptApp.getProjectTriggers().filter(function(trigger) { return trigger.getHandlerFunction() === "processCalendarSyncQueue"; }).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger("processCalendarSyncQueue").timeBased().everyMinutes(1).create();
}

function processCalendarSyncQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var snapshot;
  var jobId = Utilities.getUuid();
  try {
    var workspace = readWorkspace_();
    if (!workspace.calendar.syncPending) return;
    if (workspace._server.nextCalendarAttemptAt && new Date(workspace._server.nextCalendarAttemptAt).getTime() > Date.now()) return;
    var lease = workspace._server.calendarLease;
    if (lease && new Date(lease.expiresAt).getTime() > Date.now()) return;
    workspace._server.calendarLease = { id: jobId, revision: workspace.calendar.requestedRevision, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    writeWorkspace_(workspace);
    snapshot = clone_(workspace);
  } finally { lock.releaseLock(); }
  if (!snapshot) return;

  var syncError = null;
  try { syncCalendar_(snapshot); } catch (err) { syncError = String(err); }

  if (!lock.tryLock(5000)) return;
  try {
    var latest = readWorkspace_();
    if (!latest._server.calendarLease || latest._server.calendarLease.id !== jobId) return;
    latest._server.calendarLease = null;
    if (syncError) {
      latest.calendar.lastSyncError = syncError;
      latest.calendar.syncPending = true;
      latest._server.calendarAttempt = Number(latest._server.calendarAttempt || 0) + 1;
      var retryMinutes = [1, 5, 15, 60][Math.min(latest._server.calendarAttempt - 1, 3)];
      latest._server.nextCalendarAttemptAt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString();
    } else {
      latest.calendar.syncRecords = snapshot.calendar.syncRecords;
      latest.calendar.lastSyncAt = new Date().toISOString();
      latest.calendar.lastSyncError = null;
      latest.calendar.lastCompletedRevision = snapshot.calendar.requestedRevision;
      latest.calendar.syncPending = Number(latest.calendar.requestedRevision || 0) > Number(snapshot.calendar.requestedRevision || 0);
      latest._server.calendarAttempt = 0;
      latest._server.nextCalendarAttemptAt = null;
    }
    writeWorkspace_(latest);
  } finally { lock.releaseLock(); }
}

function recoverSeniorPlannerPassword() {
  var properties = PropertiesService.getScriptProperties();
  var username = String(properties.getProperty("RECOVERY_USERNAME") || "").trim().toLowerCase();
  var hash = String(properties.getProperty("RECOVERY_PASSWORD_HASH") || "");
  if (!username || !hash) throw new Error("Set RECOVERY_USERNAME and RECOVERY_PASSWORD_HASH first.");
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var workspace = readWorkspace_();
    var user = workspace.users.find(function(item) { return String(item.username || "").toLowerCase() === username && item.role === "senior-planner"; });
    if (!user) throw new Error("Senior planner not found.");
    user.passwordHash = hash; writeWorkspace_(workspace);
    properties.deleteProperty("RECOVERY_USERNAME"); properties.deleteProperty("RECOVERY_PASSWORD_HASH");
  } finally { lock.releaseLock(); }
}

function createDatabaseBackup() {
  var file = getDatabaseFile_();
  var stamp = Utilities.formatDate(new Date(), "Asia/Jerusalem", "yyyyMMdd-HHmmss");
  var backup = file.makeCopy("department-shift-scheduler-backup-" + stamp + ".json");
  PropertiesService.getScriptProperties().setProperty("LAST_DATABASE_BACKUP_ID", backup.getId());
  return backup.getId();
}

function legacyDoPost(e) {
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
    var workspace = migrateWorkspace_(JSON.parse(fileContent));
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
      workspace = migrateWorkspace_(workspace);
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
    schemaVersion: 3,
    revision: 0,
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
      lastDryRun: [],
      syncPending: false,
      requestedRevision: null,
      lastCompletedRevision: null,
      lastSyncAt: null,
      lastSyncError: null
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
      var eventMarker = "shift-scheduler:" + scheduleKey + ":" + assignmentKey;
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
            event.setDescription(eventMarker);
            syncEventGuests_(event, attendeeEmails);
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
            record.attendeeEmails = attendeeEmails;
          } else {
            // Re-create event if manually deleted in the Calendar UI
            event = findMarkedCalendarEvent_(calendar, eventDate, eventMarker) || calendar.createAllDayEvent(title, eventDate);
            event.setDescription(eventMarker);
            syncEventGuests_(event, attendeeEmails);
            record.eventId = event.getId();
            record.hash = hash;
            record.lastSyncedAt = new Date().toISOString();
            record.attendeeEmails = attendeeEmails;
          }
        } catch(e) {
          // Re-create on error
          var event = findMarkedCalendarEvent_(calendar, eventDate, eventMarker) || calendar.createAllDayEvent(title, eventDate);
          event.setDescription(eventMarker);
          syncEventGuests_(event, attendeeEmails);
          record.eventId = event.getId();
          record.hash = hash;
          record.lastSyncedAt = new Date().toISOString();
          record.attendeeEmails = attendeeEmails;
        }
      } else {
        // Create new event
        try {
          var event = findMarkedCalendarEvent_(calendar, eventDate, eventMarker) || calendar.createAllDayEvent(title, eventDate);
          event.setDescription(eventMarker);
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

function findMarkedCalendarEvent_(calendar, eventDate, marker) {
  var events = calendar.getEventsForDay(eventDate);
  for (var i = 0; i < events.length; i++) {
    if (String(events[i].getDescription() || "").indexOf(marker) !== -1) return events[i];
  }
  return null;
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
