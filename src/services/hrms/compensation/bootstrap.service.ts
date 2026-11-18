import type { HrmsScope } from '../scope';
import { listBands } from './bands.service';
import { loadPerf } from './perf.service';
import { loadCycleOrDefault } from './cycle.service';
import { bandOut, cycleOut, perfMapOut, perfNotesOut } from './mapping';

// Everything Compensation needs for the org in one call: the grade pay bands, the two performance maps (band per person;
// the manager's note + the employee's reply), and the merit-cycle singleton (guidelines, proposals, applied). A brand-new
// org that has never written a cycle gets the default draft cycle (today's effective date, the standard guidelines, empty
// proposals) so Live mode can render the Compensation page from empty, exactly as benefits renders from its default window.

export async function compensationBootstrap(s: HrmsScope) {
  const [bands, perfRows, cycle] = await Promise.all([listBands(s), loadPerf(s), loadCycleOrDefault(s)]);
  return {
    bands: bands.map(bandOut),
    perf: perfMapOut(perfRows),
    perf_notes: perfNotesOut(perfRows),
    cycle: cycleOut(cycle),
    server_time: new Date().toISOString(),
  };
}
