import type { HrmsScope } from '../scope';
import { listProjects } from './projects.service';
import { listSheets } from './sheets.service';
import { loadConfig } from './config.service';
import { configOut, projectOut, sheetOut } from './mapping';
import { todayIst } from './engine';

// Everything Timesheets needs for the org in one call: the settings (limits + who tracks time; the defaults for an org that
// has never saved them), the project list and every week on record. `today` is the server's date in India, which the
// dashboard uses in Live mode for the current week and the "has not happened yet" check, so both sides agree.

export async function timesheetsBootstrap(s: HrmsScope) {
  const [config, projects, sheets] = await Promise.all([loadConfig(s), listProjects(s), listSheets(s)]);
  const c = configOut(config);
  return {
    policy: c.policy,
    tracked_ids: c.tracked_ids,
    projects: projects.map(projectOut),
    sheets: sheets.map(sheetOut),
    today: todayIst(),
    server_time: new Date().toISOString(),
  };
}
