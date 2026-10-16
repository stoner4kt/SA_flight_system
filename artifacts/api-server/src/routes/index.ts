import { Router, type IRouter } from "express";
import aviationRouter from "./aviation";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aviationRouter);

export default router;
