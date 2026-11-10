import { db, fetchAll, HrmsScope, scoped } from './scope';
import { publicRow, Row } from './model';
import { getSettings } from './settings.service';
import { listEmployees } from './employees.service';

/** Everything the dashboard needs for the org in one call. Employees carry documents and history, masked. */
export async function bootstrap(s: HrmsScope) {
  const list = (table: string) => fetchAll<Row>((from, to) => scoped(db().from(table).select('*'), s).order('name', { ascending: true }).order('id', { ascending: true }).range(from, to));
  const [entities, locations, departments, designations, employees, settings] = await Promise.all([
    list('hrms_entities'), list('hrms_locations'), list('hrms_departments'), list('hrms_designations'), listEmployees(s), getSettings(s),
  ]);
  return {
    entities: entities.map(publicRow),
    locations: locations.map(publicRow),
    departments: departments.map(publicRow),
    designations: designations.map(publicRow),
    employees,
    settings,
    server_time: new Date().toISOString(),
  };
}
