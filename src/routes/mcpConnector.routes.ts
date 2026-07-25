import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { listMcpConnector, setMcpConnector } from '../controllers/mcpConnector.controller';

// Platform-level entitlement management for the AI-assistant / MCP connector.
// Mounted under /api/v1/admin/mcp-connector behind requireAuth; super-admin only.
const router = Router();

router.get('/', requireRole('super_admin'), listMcpConnector);
router.put('/:orgId', requireRole('super_admin'), setMcpConnector);

export default router;
