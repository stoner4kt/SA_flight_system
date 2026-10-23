import { Router, type IRouter } from "express";
import aviationRouter from "./aviation";
import healthRouter from "./health";
import popiaRouter from "./popia";
import travelAgencyRouter from "./travel-agency";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aviationRouter);
router.use(travelAgencyRouter);
router.use(popiaRouter);

export default router;
