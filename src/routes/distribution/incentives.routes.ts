import { Router } from 'express';
import * as ctrl from '../../controllers/distribution/incentives.controller';

const router = Router();

// A rep's own earnings and the leaderboard are open to every role with the module;
// the dashboard, the ledger and the rule are manager-only (enforced in the controller).
router.get('/me',          ctrl.mine);
router.get('/leaderboard', ctrl.leaderboard);
router.get('/dashboard',   ctrl.dashboard);
router.get('/entries',     ctrl.entries);
router.get('/rule',        ctrl.getRule);
router.put('/rule',        ctrl.putRule);

export default router;
