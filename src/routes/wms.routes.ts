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

// !! Static routes MUST come before param routes (:id) to avoid shadowing !!

// Summary — static, must be first
router.get('/summary',                             getWmsSummary);

// Movements — static sub-path pattern, register before /:id
router.get('/:warehouseId/movements',              listMovements);
router.post('/:warehouseId/movements',             createMovement);

// Warehouses CRUD — param routes last
router.get('/',                                    listWarehouses);
router.post('/',                                   createWarehouse);
router.get('/:id',                                 getWarehouse);
router.patch('/:id',                               updateWarehouse);
router.delete('/:id',                              deleteWarehouse);

export default router;
