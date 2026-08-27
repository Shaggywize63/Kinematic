import { Router } from 'express';
import { perRouteLimit } from '../../middleware/security';
import { withCaptureProject } from '../../middleware/withProject';
import { publicGet, publicSubmit } from '../../controllers/distribution/capture.controller';

// Public consumer self-registration capture (NO auth). The `:token` in the path
// is the outlet's capture secret; withCaptureProject resolves which Supabase
// project owns it and runs the handler in that project's context. perRouteLimit
// throttles per IP (keyGenerator degrades to `<ip>:anon` without a JWT).
const router = Router();
const limit = perRouteLimit({ windowMs: 60_000, max: 30 });

router.get('/:token', limit, withCaptureProject, publicGet);
router.post('/:token', limit, withCaptureProject, publicSubmit);

export default router;
