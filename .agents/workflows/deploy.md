---
description: Commit and Push all changes for Kinematic Backend and Dashboard
---

This workflow stages, commits, and attempts to push changes for both repositories.

// turbo
1. **Kinematic Backend**:
   Run: `git add . && git commit -m "deploy: automated update" && git push origin main`
   Cwd: `/Users/sagbharg/Documents/Kinematic/Kinematic`

// turbo
2. **Dashboard Frontend**:
   Run: `git add . && git commit -m "deploy: automated update" && git push origin main`
   Cwd: `/Users/sagbharg/Documents/Kinematic/kinematic-dashboard`

3. **Database Migration**:
   If you updated SQL files, remember to execute them in the Supabase SQL editor.
