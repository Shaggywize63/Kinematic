import { db, fetchAll, HrmsScope, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { assetOut, eventOut } from './mapping';

// Everything the Asset register needs for the org in one call: the catalogue and ALL of its events (the dashboard replays
// the events, so none may be dropped). Events come back oldest-first by insertion order (created_at, id), so an asset's
// own history is in order and the dashboard's replayAsset lands on the right current state.

export async function assetsBootstrap(s: HrmsScope) {
  const list = (table: string, orders: string[]) =>
    fetchAll<Row>((from, to) => {
      let q = scoped(db().from(table).select('*'), s);
      for (const o of orders) q = q.order(o, { ascending: true });
      return q.range(from, to);
    });
  const [assets, events] = await Promise.all([
    list('hrms_assets', ['created_at', 'id']),
    list('hrms_asset_events', ['created_at', 'id']),
  ]);
  return {
    assets: assets.map(assetOut),
    events: events.map(eventOut),
    server_time: new Date().toISOString(),
  };
}
