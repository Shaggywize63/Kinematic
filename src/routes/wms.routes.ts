// src/routes/wms.routes.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  listMovements,
  createMovement,
  getWmsSummary,
} from '../controllers/wms.controller';

const router = Router();
router.use(requireAuth);

// Summary
router.get('/summary',                             getWmsSummary);

// Warehouses CRUD
router.get('/',                                    listWarehouses);
router.get('/:id',                                 getWarehouse);
router.post('/',                                   createWarehouse);
router.patch('/:id',                               updateWarehouse);
router.delete('/:id',                              deleteWarehouse);

// Movements (scoped to a warehouse)
router.get('/:warehouseId/movements',              listMovements);
router.post('/:warehouseId/movements',             createMovement);

export default router;
