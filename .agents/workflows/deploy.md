---
description: Unified Deployment and Migration Workflow
---

This workflow stages, commits, and helps you push changes for both repositories, including automated database migrations.

// turbo
1. **Kinematic Backend**:
   Run: `npm run deploy`
   Cwd: `/Users/sagbharg/Documents/Kinematic/Kinematic`

// turbo
2. **Dashboard Frontend**:
   Run: `git add . && git commit -m "deploy: automated update" && echo '🚀 Ready to push dashboard. Run: git push origin main'`
   Cwd: `/Users/sagbharg/Documents/Kinematic/kinematic-dashboard`

3. **Database Migration (Automatic)**:
   If you have a SQL migration file (e.g. `src/scripts/migration.sql`), run:
   `npm run db:migrate src/scripts/migration.sql`
   *Note: Requires one-time setup of `exec_sql` in Supabase.*

