# Graph Report - C:\Users\maisa\OneDrive\Documents\New project  (2026-05-27)

## Corpus Check
- Corpus is ~20,531 words - fits in a single context window. You may not need a graph.

## Summary
- 301 nodes · 558 edges · 17 communities (15 shown, 2 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Roster UI Components|Roster UI Components]]
- [[_COMMUNITY_Auth Audit Requests|Auth Audit Requests]]
- [[_COMMUNITY_Calendar Validation Rules|Calendar Validation Rules]]
- [[_COMMUNITY_Deployment Architecture Docs|Deployment Architecture Docs]]
- [[_COMMUNITY_App Workflow Semantics|App Workflow Semantics]]
- [[_COMMUNITY_Package Build Dependencies|Package Build Dependencies]]
- [[_COMMUNITY_TypeScript Compiler Config|TypeScript Compiler Config]]
- [[_COMMUNITY_Drive Sync Persistence|Drive Sync Persistence]]
- [[_COMMUNITY_PWA Install Prompt|PWA Install Prompt]]
- [[_COMMUNITY_512 Icon Identity|512 Icon Identity]]
- [[_COMMUNITY_192 Icon Identity|192 Icon Identity]]
- [[_COMMUNITY_Service Worker Cache|Service Worker Cache]]
- [[_COMMUNITY_SVG Icon Identity|SVG Icon Identity]]
- [[_COMMUNITY_Schema Migration Tests|Schema Migration Tests]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 17 edges
2. `Workspace Schema Types` - 12 edges
3. `migrateWorkspace()` - 11 edges
4. `createId()` - 10 edges
5. `Doctor` - 9 edges
6. `cellKey()` - 8 edges
7. `WorkspaceData` - 8 edges
8. `scripts` - 7 edges
9. `App()` - 7 edges
10. `apiCall()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Role Eligibility Rules` --semantically_similar_to--> `Validation Rules`  [INFERRED] [semantically similar]
  webapp/tests/validation.test.ts → README.md
- `Friday-Saturday Senior Link` --semantically_similar_to--> `Validation Rules`  [INFERRED] [semantically similar]
  webapp/tests/validation.test.ts → README.md
- `GitHub Pages Deployment` --references--> `Senior Planner Bootstrap`  [EXTRACTED]
  DEPLOY_TO_GITHUB_PAGES.md → webapp/tests/roles-audit-requests.test.ts
- `Active Role Model` --conceptually_related_to--> `Planner-Only Permissions`  [INFERRED]
  README.md → webapp/tests/roles-audit-requests.test.ts
- `Main Workflows` --conceptually_related_to--> `Change Request Status Flow`  [INFERRED]
  README.md → webapp/tests/roles-audit-requests.test.ts

## Hyperedges (group relationships)
- **Workspace Persistence Flow** — App_workspace_state, storage_local_workspace_persistence, googleDrive_apps_script_client, migration_workspace_normalization, types_workspace_schema [EXTRACTED 1.00]
- **Audited Mutation Flow** — App_commit_change, audit_create_audit_entry, App_set_and_persist, types_workspace_schema [EXTRACTED 1.00]
- **Published Swap Request Flow** — App_published_swap_flow, requests_change_request_lifecycle, permissions_role_gate_policy, types_workspace_schema [EXTRACTED 1.00]
- **GitHub Pages Static Deployment Flow** — deploy_to_github_pages_github_pages_deployment, deploy_pages_github_actions_workflow, deploy_pages_build_job, deploy_pages_deploy_job, deploy_to_github_pages_static_chrome_pwa [EXTRACTED 1.00]
- **Role Request Audit Test Coverage** — roles_audit_requests_username_role_resolution, roles_audit_requests_senior_planner_bootstrap, roles_audit_requests_planner_only_permissions, roles_audit_requests_change_request_status_flow, roles_audit_requests_audit_metadata, roles_audit_requests_schema_v2_migration [EXTRACTED 1.00]
- **Visual Direction Option Set** — visual_directions_visual_facelift_directions, visual_directions_clean_clinical, visual_directions_command_center, visual_directions_soft_modern, visual_directions_roster_workflow, visual_directions_rtl_roster_board [EXTRACTED 1.00]

## Communities (17 total, 2 thin omitted)

### Community 0 - "Roster UI Components"
Cohesion: 0.06
Nodes (34): App(), CalendarPanel(), canSeeTab(), current, Exclusions(), formatScheduleMonth(), PublishedChangeMode, PublishedRoster() (+26 more)

### Community 1 - "Auth Audit Requests"
Cohesion: 0.07
Nodes (41): ActorContext, AuditInput, createAuditEntry(), createBootstrapPlanner(), normalizeUsername(), resolveSession(), SessionState, SessionUser (+33 more)

### Community 2 - "Calendar Validation Rules"
Cohesion: 0.09
Nodes (35): isDoctorBlockedForAssignment(), isDoctorExcluded(), linkedAssignmentKeys(), buildCalendarPreview(), sha1(), cellKey(), doctorSortForRole(), exclusionRoleCodesForAssignment() (+27 more)

### Community 3 - "Deployment Architecture Docs"
Cohesion: 0.06
Nodes (41): GitHub Pages SPA Redirect, Pages Build Job, Pages Deploy Job, GitHub Actions Deploy Pages Workflow, GitHub Pages Deployment, Google Drive JSON Workspace, Google OAuth Web Client ID, Static Chrome PWA (+33 more)

### Community 4 - "App Workflow Semantics"
Cohesion: 0.15
Nodes (27): App Component, Login And Bootstrap Flow, Calendar Dry Run And Mock Sync Flow, commitChange, Published Swap And Handoff Flow, Roster Edit And Publish Flow, Server Sync Flow, setAndPersist (+19 more)

### Community 5 - "Package Build Dependencies"
Cohesion: 0.08
Nodes (23): dependencies, lucide-react, react, react-dom, devDependencies, @types/node, @types/react, @types/react-dom (+15 more)

### Community 6 - "TypeScript Compiler Config"
Cohesion: 0.10
Nodes (20): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+12 more)

### Community 7 - "Drive Sync Persistence"
Cohesion: 0.19
Nodes (18): DrivePanel(), adminSaveUsers(), apiCall(), bootstrapPlanner(), clearLocalCredentials(), getLocalCredentials(), getWebAppUrl(), hashPassword() (+10 more)

### Community 9 - "512 Icon Identity"
Cohesion: 0.60
Nodes (5): Calendar Checklist Visual Identity, Colored Shift Status List, Department Shift Scheduler App Icon, Department Shift Scheduler Web App, PWA Installable Icon Asset

### Community 10 - "192 Icon Identity"
Cohesion: 0.67
Nodes (4): Calendar Checklist Motif, Department Shift Scheduler Visual Identity, PWA Install Icon Asset, 192x192 Scheduler App Icon

### Community 11 - "Service Worker Cache"
Cohesion: 0.50
Nodes (3): APP_SHELL, copy, url

### Community 12 - "SVG Icon Identity"
Cohesion: 1.00
Nodes (3): Calendar Checklist App Icon, Department Shift Scheduler PWA Icon, Scheduling And Completion Visual Motif

## Knowledge Gaps
- **91 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+86 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What connects `name`, `private`, `version` to the rest of the system?**
  _91 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Roster UI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.06219426974143955 - nodes in this community are weakly interconnected._
- **Should `Auth Audit Requests` be split into smaller, more focused modules?**
  _Cohesion score 0.07246376811594203 - nodes in this community are weakly interconnected._
- **Should `Calendar Validation Rules` be split into smaller, more focused modules?**
  _Cohesion score 0.09059233449477352 - nodes in this community are weakly interconnected._
- **Should `Deployment Architecture Docs` be split into smaller, more focused modules?**
  _Cohesion score 0.05731707317073171 - nodes in this community are weakly interconnected._
- **Should `App Workflow Semantics` be split into smaller, more focused modules?**
  _Cohesion score 0.1452991452991453 - nodes in this community are weakly interconnected._
- **Should `Package Build Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._