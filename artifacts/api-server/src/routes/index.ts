import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bookingsRouter from "./bookings";
import attendeesRouter from "./attendees";
import pricingRouter from "./pricing";
import promoCodesRouter from "./promo-codes";
import discountTiersRouter from "./discount-tiers";
import stripeRouter from "./stripe";
import emailRouter from "./email";
import adminRouter from "./admin";
import calendarRouter from "./calendar";
import hearAboutUsRouter from "./hear-about-us";
import companyInfoRouter from "./company-info";
import adminSponsorsRouter from "./admin-sponsors";
import sponsorWorkspaceRouter from "./sponsor-workspace";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bookingsRouter);
router.use(attendeesRouter);
router.use(pricingRouter);
router.use(promoCodesRouter);
router.use(discountTiersRouter);
router.use(stripeRouter);
router.use(emailRouter);
router.use(adminRouter);
router.use(calendarRouter);
router.use(hearAboutUsRouter);
router.use(companyInfoRouter);
router.use(adminSponsorsRouter);
router.use(sponsorWorkspaceRouter);

export default router;
