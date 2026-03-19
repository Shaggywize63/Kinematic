import { Router } from 'express';
import citiesRouter   from './cities.routes';
import zonesRouter    from './zones.routes';
import storesRouter   from './stores.routes';
import skusRouter     from './skus.routes';
// ... other imports

const router = Router();

router.use('/cities',     citiesRouter);   // ← THIS must exist
router.use('/zones',      zonesRouter);
router.use('/stores',     storesRouter);
router.use('/skus',       skusRouter);
// ...

export default router;
