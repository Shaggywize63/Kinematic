/**
 * KINI agentic v2 routes. Mounted at /api/v1/kini in app.ts under requireAuth.
 * The per-tenant feature flag (`kini_agentic_v2`) is enforced inside each
 * controller via the `gate()` helper, so disabled tenants get a clean 403.
 */
import { Router } from 'express';
import * as v2 from '../controllers/crm/ai.v2.controller';

const router: Router = Router();

// Agentic chat
router.post('/v2/chat', v2.chat);

// Threads
router.get('/v2/threads', v2.threadsList);
router.post('/v2/threads', v2.threadCreate);
router.get('/v2/threads/:id', v2.threadGet);
router.patch('/v2/threads/:id', v2.threadRename);
router.delete('/v2/threads/:id', v2.threadDelete);

// Memory
router.get('/v2/memory', v2.memoryList);
router.put('/v2/memory/:key', v2.memorySet);
router.delete('/v2/memory/:key', v2.memoryDelete);

export default router;
