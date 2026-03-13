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
  updateMovement,
  deleteMovement,
  getWmsSummary,
} from '../controllers/wms.controller';

const router = Router();
router.use(requireAuth);

// !! Static routes MUST come before param routes (:id) !!

// Summary — static, must be first
router.get('/summary', getWmsSummary);

// Movement CRUD — static sub-path, before /:id
router.get('/:warehouseId/movements',                   listMovements);
router.post('/:warehouseId/movements',                  createMovement);
router.patch('/:warehouseId/movements/:movementId',     updateMovement);
router.delete('/:warehouseId/movements/:movementId',    deleteMovement);

// Warehouse CRUD — param routes last
router.get('/',     listWarehouses);
router.post('/',    createWarehouse);
router.get('/:id',  getWarehouse);
router.patch('/:id', updateWarehouse);
router.delete('/:id', deleteWarehouse);

export default router;
