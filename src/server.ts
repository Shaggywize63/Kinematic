import app from './app';
import { logger } from './lib/logger';
import { loadDynamicProjects } from './lib/platformProjects';
import { runScheduledAutomations } from './services/crm/automations.service';
import { resumeWaitingFlowRuns } from './services/crm/flows.service';
import { runDueReportDigests } from './services/crm/reportSchedules.service';
import { runDailyBriefings } from './services/crm/ai/dailyBriefing.service';
import { processDueBroadcastsAllProjects } from './services/crm/broadcast.service';
import { processDueEmailCampaignsAllProjects } from './services/crm/emailCampaign.service';

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  logger.info(`🚀 Kinematic API running on port ${PORT}`);
  logger.info(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   Health      : http://localhost:${PORT}/health`);
  logger.info(`   API base    : http://localhost:${PORT}/api/v1`);
});

// Hydrate the dynamic project registry with any client projects created by the
// onboarding provisioner. Non-fatal: a failure just means those tenants aren't
// reachable until the next successful load (env-configured projects are unaffected).
loadDynamicProjects()
  .then((n) => { if (n) logger.info(`[startup] hydrated ${n} runtime project(s)`); })
  .catch((e) => logger.warn(`[startup] dynamic project load failed: ${e?.message ?? e}`));

// Slowloris / hung-connection protection. headersTimeout slightly exceeds
// keepAliveTimeout per Node's recommendation; requestTimeout caps any single
// request including its body.
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 70_000;
server.requestTimeout   = 30_000;
server.timeout          = 30_000;

// Time-based automation scheduler. In-process interval — the dedup ledger
// (crm_automation_event_log) makes it safe even if several instances tick at
// once. Toggle with CRM_AUTOMATION_SCHEDULER_ENABLED=false; tune the cadence
// with CRM_AUTOMATION_SCHEDULER_INTERVAL_SEC (default 900s).
if (String(process.env.CRM_AUTOMATION_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false') {
  const everyMs = Math.max(60, Number(process.env.CRM_AUTOMATION_SCHEDULER_INTERVAL_SEC ?? 900)) * 1000;
  setInterval(() => {
    runScheduledAutomations()
      .then((r) => { if (r.fired) logger.info(`[automations] scheduled run fired ${r.fired}/${r.checked}`); })
      .catch((e) => logger.warn(`[automations] scheduled run failed: ${e?.message ?? e}`));
    // Phase-2 flow delays: resume any waiting flow-run whose timer is up.
    // Default-project scoped in-process (Tata has no flow tables yet → no-op);
    // per-tenant resume is driven via POST /crm/flow-runs/resume with the
    // project header until a project-aware scheduler lands.
    resumeWaitingFlowRuns()
      .then((r) => { if (r.resumed) logger.info(`[flows] resumed ${r.resumed} waiting run(s)`); })
      .catch((e) => logger.warn(`[flows] resume run failed: ${e?.message ?? e}`));
  }, everyMs).unref();
  logger.info(`[automations] time-based scheduler enabled (every ${everyMs / 1000}s)`);
}

// Scheduled report digests. Hourly in-process tick — schedules are hour-grained
// (send_hour, UTC) so an hourly scan is sufficient. Each run rolls next_run_at
// forward, so overlapping ticks across instances at worst re-send one digest,
// never loop. Toggle with CRM_REPORT_DIGEST_SCHEDULER_ENABLED=false; tune with
// CRM_REPORT_DIGEST_INTERVAL_SEC (default 3600s).
if (String(process.env.CRM_REPORT_DIGEST_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false') {
  const everyMs = Math.max(60, Number(process.env.CRM_REPORT_DIGEST_INTERVAL_SEC ?? 3600)) * 1000;
  setInterval(() => {
    runDueReportDigests(25)
      .then((r) => { if (r.sent) logger.info(`[report-digests] sent ${r.sent}/${r.checked} due digests`); })
      .catch((e) => logger.warn(`[report-digests] scheduled run failed: ${e?.message ?? e}`));
  }, everyMs).unref();
  logger.info(`[report-digests] scheduler enabled (every ${everyMs / 1000}s)`);
}

// Daily AI briefing. Hourly tick that only fires at the configured UTC hour
// (default 03:00 UTC ≈ 08:30 IST); the crm_daily_briefing_log dedup makes a
// rep's briefing once-per-day regardless of how many ticks hit that hour or
// how many instances run. Toggle with CRM_DAILY_BRIEFING_ENABLED=false; set the
// send hour with CRM_DAILY_BRIEFING_HOUR_UTC (0-23, default 3).
if (String(process.env.CRM_DAILY_BRIEFING_ENABLED ?? 'true').toLowerCase() !== 'false') {
  const briefingHour = Math.min(23, Math.max(0, Number(process.env.CRM_DAILY_BRIEFING_HOUR_UTC ?? 3)));
  setInterval(() => {
    if (new Date().getUTCHours() !== briefingHour) return;
    runDailyBriefings(100)
      .then((r) => { if (r.sent) logger.info(`[daily-briefing] pushed ${r.sent}/${r.checked} briefings`); })
      .catch((e) => logger.warn(`[daily-briefing] run failed: ${e?.message ?? e}`));
  }, 3600 * 1000).unref();
  logger.info(`[daily-briefing] scheduler enabled (fires at ${briefingHour}:00 UTC)`);
}

// WhatsApp broadcast pacing. Short in-process tick that advances every in-flight
// / due campaign one throttled batch per project. The token bucket (anchored on
// last_batch_at) makes throughput converge to each campaign's throttle_per_min
// regardless of tick frequency or overlapping instances; the dashboard also
// polls /process while a campaign is open for smoother, live pacing. Toggle with
// CRM_BROADCAST_SCHEDULER_ENABLED=false; tune with CRM_BROADCAST_INTERVAL_SEC
// (default 60s).
if (String(process.env.CRM_BROADCAST_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false') {
  const everyMs = Math.max(15, Number(process.env.CRM_BROADCAST_INTERVAL_SEC ?? 60)) * 1000;
  setInterval(() => {
    processDueBroadcastsAllProjects()
      .then((r) => { if (r.sent) logger.info(`[broadcast] paced ${r.sent} message(s) across ${r.processed} campaign(s)`); })
      .catch((e) => logger.warn(`[broadcast] scheduler run failed: ${e?.message ?? e}`));
  }, everyMs).unref();
  logger.info(`[broadcast] pacing scheduler enabled (every ${everyMs / 1000}s)`);
}

// Email campaign pacing. Same shape as WhatsApp broadcasts — one throttled batch
// per in-flight campaign per tick (throttle_per_min emails/batch). Toggle with
// CRM_EMAIL_CAMPAIGN_SCHEDULER_ENABLED=false; tune with CRM_EMAIL_CAMPAIGN_INTERVAL_SEC.
if (String(process.env.CRM_EMAIL_CAMPAIGN_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false') {
  const everyMs = Math.max(15, Number(process.env.CRM_EMAIL_CAMPAIGN_INTERVAL_SEC ?? 60)) * 1000;
  setInterval(() => {
    processDueEmailCampaignsAllProjects()
      .then((r) => { if (r.sent) logger.info(`[email-campaign] paced ${r.sent} email(s) across ${r.processed} campaign(s)`); })
      .catch((e) => logger.warn(`[email-campaign] scheduler run failed: ${e?.message ?? e}`));
  }, everyMs).unref();
  logger.info(`[email-campaign] pacing scheduler enabled (every ${everyMs / 1000}s)`);
}

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

export default server;
// Deploy Kick: 2026-07-22 — force redeploy + boot marker for OAuth token debug
