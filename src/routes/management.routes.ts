// management.routes.ts
import { Router } from 'express';
import citiesRouter from './cities.routes';
import zonesRouter  from './zones.routes';
import storesRouter from './stores.routes';
import skusRouter   from './skus.routes';

const router = Router();

router.use('/cities', citiesRouter);
router.use('/zones',  zonesRouter);
router.use('/stores', storesRouter);
router.use('/skus',   skusRouter);

export default router;
