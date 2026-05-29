// `./generated/api` exports zod schema *values* (consts) used for runtime
// validation, while `./generated/types` exports the corresponding TypeScript
// *types*. A handful of names (e.g. `CreateBookingBody`) appear in both, which
// makes a naive `export *` from both produce TS2308 ambiguity errors.
//
// To keep a single barrel without behaviour changes for consumers, we wildcard
// re-export the zod schemas, then explicitly re-export every name from
// `./generated/types` that does NOT collide with a zod schema. Names that
// collide are intentionally not re-exported as types here; consumers needing
// the inferred type should derive it from the zod schema via
// `z.infer<typeof Schema>` (which is what the api.ts schemas already power).
export * from "./generated/api";

export type {
  AdminStats,
  AdminStatsPassCounts,
  AdminStatsPaymentMethodCounts,
  Attendee,
  Booking,
  BookingWithAttendees,
  BulkRemindBody,
  BulkRemindResult,
  BulkRemindResultFailuresItem,
  CreateInvoiceBody,
  CreateStripeSessionBody,
  DiscountTier,
  EmailLog,
  EmailLogList,
  EmailTemplate,
  ErrorResponse,
  EventSettings,
  EventSettingsUpdate,
  ExportRegistrationsParams,
  HealthStatus,
  InvoiceResponse,
  ListEmailLogsParams,
  ListRegistrationsParams,
  ListUnpaidInvoicesParams,
  PricingBreakdown,
  PricingRequest,
  PromoCode,
  PromoCodeValidationResult,
  PublicEventSettings,
  RegistrationList,
  RegistrationRedeliveryResult,
  RegistrationRedeliveryResultRedelivery,
  RegistrationSummary,
  StripeSessionResponse,
  SuccessResponse,
  TestEmailBody,
  UnpaidInvoiceBucket,
  UnpaidInvoiceList,
  UnpaidInvoiceRow,
  UnpaidInvoicesSummary,
  UnpaidInvoicesSummaryBuckets,
  UpdateDiscountTiersBodyTiersItem,
  UpdateEmailTemplateBody,
} from "./generated/types";

// const-enum-like exports from `./generated/types` carry both a value and a
// type declaration of the same name; re-export them as values so consumers
// can use them at runtime AND in type positions.
export {
  BookingAttendeeType,
  BookingInvoiceBadgeStatus,
  BookingPassType,
  BookingPaymentMethod,
  BookingStatus,
  BulkRemindBodyBucket,
  CreateBookingBodyAttendeeType,
  CreateBookingBodyPassType,
  CreatePromoCodeBodyApplicablePassTypesItem,
  CreatePromoCodeBodyDiscountType,
  DiscountTierPassType,
  EmailLogStatus,
  EmailLogType,
  ListRegistrationsNeedsAttention,
  ListUnpaidInvoicesBucket,
  ListUnpaidInvoicesOrder,
  ListUnpaidInvoicesSort,
  PricingBreakdownPromoDiscountType,
  PricingRequestPassType,
  PromoCodeApplicablePassTypesItem,
  PromoCodeDiscountType,
  PromoCodeValidationResultDiscountType,
  RegistrationSummaryInvoiceBadgeStatus,
  UnpaidInvoiceRowBucket,
  UnpaidInvoiceRowInvoiceBadgeStatus,
  UpdateBookingBodyAttendeeType,
  UpdateBookingBodyPassType,
  UpdateBookingBodyPaymentMethod,
  UpdateBookingBodyStatus,
  UpdateDiscountTiersBodyPassType,
  UpdatePromoCodeBodyApplicablePassTypesItem,
  UpdatePromoCodeBodyDiscountType,
  ValidatePromoCodeBodyPassType,
} from "./generated/types";
