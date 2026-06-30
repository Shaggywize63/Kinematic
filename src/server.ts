import app from './app';
import { logger } from './lib/logger';
import { runScheduledAutomations } from './services/crm/automations.service';
import { runDueReportDigests } from './services/crm/reportSchedules.service';

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  logger.info(`🚀 Kinematic API running on port ${PORT}`);
  logger.info(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   Health      : http://localhost:${PORT}/health`);
  logger.info(`   API base    : http://localhost:${PORT}/api/v1`);
});

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
// Deploy Kick: Thu Apr  9 12:00:13 IST 2026
