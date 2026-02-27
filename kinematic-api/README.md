# Kinematic API

Field Force Management REST API — Node.js + Express + TypeScript + Supabase

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Supabase credentials

# 3. Run in development
npm run dev

# 4. Build for production
npm run build
npm start
```

## API Routes

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/v1/auth/login | Public | Login with mobile + password |
| POST | /api/v1/auth/refresh | Public | Refresh access token |
| POST | /api/v1/auth/logout | Auth | Logout |
| GET  | /api/v1/auth/me | Auth | Current user profile |
| POST | /api/v1/attendance/checkin | Auth | Geo-fence check-in with selfie |
| POST | /api/v1/attendance/checkout | Auth | Check-out |
| POST | /api/v1/attendance/break/start | Auth | Start break |
| POST | /api/v1/attendance/break/end | Auth | End break |
| GET  | /api/v1/attendance/today | Auth | Today's attendance record |
| GET  | /api/v1/attendance/history | Auth | Attendance history |
| GET  | /api/v1/attendance/team | Supervisor+ | Team attendance today |
| GET  | /api/v1/forms/templates | Auth | List form templates |
| GET  | /api/v1/forms/templates/:id | Auth | Get template with fields |
| POST | /api/v1/forms/templates | Admin+ | Create template |
| POST | /api/v1/forms/templates/:id/fields | Admin+ | Add field to template |
| POST | /api/v1/forms/submit | Auth | Submit consumer contact form |
| GET  | /api/v1/forms/submissions | Auth | My submissions |
| GET  | /api/v1/forms/admin/submissions | Supervisor+ | All org submissions |
| GET  | /api/v1/stock/my | Auth | My stock allocation today |
| POST | /api/v1/stock/allocate | Admin+ | Allocate stock to exec |
| PATCH| /api/v1/stock/items/:id | Auth | Accept/reject stock item |
| GET  | /api/v1/stock/team | Supervisor+ | Team allocations |
| GET  | /api/v1/broadcast | Auth | Active questions |
| POST | /api/v1/broadcast | Admin+ | Post question |
| POST | /api/v1/broadcast/:id/answer | Auth | Submit answer |
| GET  | /api/v1/broadcast/:id/results | Admin+ | View results |
| POST | /api/v1/sos/trigger | Auth | Trigger SOS alert |
| GET  | /api/v1/sos | Supervisor+ | All SOS alerts |
| PATCH| /api/v1/sos/:id/acknowledge | Supervisor+ | Acknowledge alert |
| PATCH| /api/v1/sos/:id/resolve | Supervisor+ | Resolve alert |
| GET  | /api/v1/leaderboard | Auth | Leaderboard (weekly/monthly) |
| GET  | /api/v1/leaderboard/me | Auth | My current score |
| GET  | /api/v1/notifications | Auth | My notifications |
| PATCH| /api/v1/notifications/read-all | Auth | Mark all read |
| PATCH| /api/v1/notifications/fcm-token | Auth | Update push token |
| GET  | /api/v1/learning | Auth | Learning materials |
| POST | /api/v1/learning | Admin+ | Upload material |
| POST | /api/v1/learning/:id/progress | Auth | Update progress |
| POST | /api/v1/grievances | Auth | Submit grievance |
| GET  | /api/v1/grievances/mine | Auth | My grievances |
| GET  | /api/v1/grievances/admin | Admin+ | All grievances (HR) |
| PATCH| /api/v1/grievances/admin/:id | Admin+ | Update status |
| GET  | /api/v1/analytics/summary | Supervisor+ | Dashboard KPIs |
| GET  | /api/v1/analytics/activity-feed | Supervisor+ | Live activity feed |
| GET  | /api/v1/analytics/hourly | Supervisor+ | Hourly chart data |
| POST | /api/v1/visits | Auth | Log supervisor visit |
| GET  | /api/v1/visits/mine | Auth | My visit log |
| GET  | /api/v1/visits/team | Supervisor+ | Team visits today |
| POST | /api/v1/upload/:type | Auth | Upload photo/file |

## Upload Types
- `selfie` — check-in/check-out selfies
- `form_photo` — form submission photos
- `material` — learning materials (admin only)
- `avatar` — user profile photos

## Roles (hierarchy)
`super_admin` > `admin` > `city_manager` > `supervisor` > `executive`

## Docker

```bash
docker-compose up -d
```

## Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```
