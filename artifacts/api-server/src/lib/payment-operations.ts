import { createHash, randomUUID } from "node:crypto";
import { createDbConnection, pool, type DbConnection, type Booking } from "@workspace/db";
import type Stripe from "stripe";

export const PAYMENT_JOURNAL_TYPE = "_stripe_payment_attempt";
const LOCK_NAMESPACE = 1398231079;
const SAFE_RETRY_MS = 23 * 60 * 60 * 1000;

export class PaymentOperationError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export class PaymentReviewRequired extends PaymentOperationError {}
export class PaymentOperationBusy extends PaymentOperationError {}

export function paymentFingerprint(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, ordered(v)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}

export interface PaymentStep {
  requestedAt: string;
  requestHash: string;
  resultId?: string;
  rejected?: boolean;
}

export interface PaymentAttempt<Plan = Record<string, unknown>> {
  id: string;
  bookingId: number;
  route: "card" | "invoice";
  fingerprint: string;
  createdAt: string;
  status: "pending" | "ready" | "superseded" | "expired" | "review";
  plan: Plan;
  steps: Record<string, PaymentStep>;
  reviewReason?: string;
}

type JournalClient = Parameters<typeof createDbConnection>[0];

export class PaymentOperations {
  readonly db: DbConnection;
  constructor(
    readonly client: JournalClient,
    readonly bookingId: number,
  ) {
    this.db = createDbConnection(client);
  }

  async attempts<Plan>(route?: "card" | "invoice"): Promise<PaymentAttempt<Plan>[]> {
    const result = await this.client.query<{ data: PaymentAttempt<Plan> }>(
      `SELECT data FROM activity_log WHERE type = $1 AND data->>'bookingId' = $2
       AND ($3::text IS NULL OR data->>'route' = $3) ORDER BY id DESC`,
      [PAYMENT_JOURNAL_TYPE, String(this.bookingId), route || null],
    );
    return result.rows.map((row) => row.data);
  }

  async start<Plan>(
    route: "card" | "invoice",
    plan: Plan,
    fingerprint = paymentFingerprint(plan),
  ): Promise<PaymentAttempt<Plan>> {
    const attempt: PaymentAttempt<Plan> = {
      id: randomUUID(),
      bookingId: this.bookingId,
      route,
      plan,
      fingerprint,
      createdAt: new Date().toISOString(),
      status: "pending",
      steps: {},
    };
    // No booking FK: the private history must survive deletion of a booking.
    // This is critical state, so write failures propagate instead of being swallowed by audit logging.
    await this.client.query(
      "INSERT INTO activity_log (type, actor, booking_id, data) VALUES ($1, 'stripe', NULL, $2::jsonb)",
      [PAYMENT_JOURNAL_TYPE, JSON.stringify(attempt)],
    );
    return attempt;
  }

  async record(
    attempt: PaymentAttempt<unknown>,
    name: string,
    params: unknown,
    resultId: string,
  ): Promise<void> {
    attempt.steps[name] = {
      requestedAt: attempt.steps[name]?.requestedAt || new Date().toISOString(),
      requestHash: paymentFingerprint(params),
      resultId,
    };
    await this.save(attempt);
  }

  async save(attempt: PaymentAttempt<unknown>): Promise<void> {
    const result = await this.client.query(
      `UPDATE activity_log SET data = $1::jsonb WHERE type = $2
       AND data->>'bookingId' = $3 AND data->>'id' = $4`,
      [JSON.stringify(attempt), PAYMENT_JOURNAL_TYPE, String(this.bookingId), attempt.id],
    );
    if (result.rowCount !== 1) throw new Error("Could not persist Stripe payment attempt");
  }

  async step<Plan>(
    attempt: PaymentAttempt<Plan>,
    name: string,
    params: unknown,
    run: (options: Stripe.RequestOptions) => Promise<{ id: string }>,
  ): Promise<string> {
    const previous = attempt.steps[name];
    if (previous?.resultId) return previous.resultId;
    const requestHash = paymentFingerprint(params);
    if (previous && previous.requestHash !== requestHash) {
      return this.review(attempt, "Payment details changed during an unfinished Stripe request");
    }
    if (
      previous &&
      !previous.rejected &&
      Date.now() - Date.parse(previous.requestedAt) >= SAFE_RETRY_MS
    ) {
      return this.review(
        attempt,
        "An old Stripe request has an uncertain result; review it before retrying",
      );
    }
    attempt.steps[name] ||= { requestedAt: new Date().toISOString(), requestHash };
    await this.save(attempt);
    try {
      const result = await run({ idempotencyKey: `swp-${attempt.id}-${name}` });
      attempt.steps[name].resultId = result.id;
      delete attempt.steps[name].rejected;
      await this.save(attempt);
      return result.id;
    } catch (err) {
      const error = err as { type?: string; code?: string };
      // Parameter validation failures do not create a Stripe object. Connection
      // errors and conflicting/idempotency requests retain their uncertain state.
      if (error.type === "StripeInvalidRequestError" && error.code !== "idempotency_key_in_use") {
        attempt.steps[name].rejected = true;
        await this.save(attempt);
      }
      throw err;
    }
  }

  async review(attempt: PaymentAttempt<unknown>, reason: string): Promise<never> {
    attempt.status = "review";
    attempt.reviewReason = reason;
    await this.save(attempt);
    await this.alert(reason, { attemptId: attempt.id });
    throw new PaymentReviewRequired(
      "This payment needs organiser review before another attempt can be started.",
    );
  }

  async alert(reason: string, references: Record<string, string>): Promise<void> {
    const key = paymentFingerprint({ reason, references });
    await this.client.query(
      `INSERT INTO activity_log (type, actor, booking_id, data)
       SELECT 'payment_reconciliation_required', 'stripe', $1, $2::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE type = 'payment_reconciliation_required'
       AND data->>'key' = $3)`,
      [this.bookingId, JSON.stringify({ summary: reason, key, ...references }), key],
    );
  }
}

export async function withPaymentOperation<T>(
  bookingId: number,
  work: (operations: PaymentOperations) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    connectionError = error;
  };
  client.on("error", onError);
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [LOCK_NAMESPACE, bookingId],
    );
    acquired = result.rows[0]?.locked === true;
    if (!acquired)
      throw new PaymentOperationBusy(
        "Payment setup is already in progress. Please wait a moment and retry.",
      );
    return await work(new PaymentOperations(client, bookingId));
  } finally {
    if (acquired && !connectionError) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, bookingId]);
      } catch (err) {
        connectionError = err instanceof Error ? err : new Error("Payment lock connection failed");
      }
    }
    client.removeListener("error", onError);
    client.release(connectionError);
  }
}

export function assertPaymentCanStart(booking: Booking): void {
  if (!["partial", "pending_payment"].includes(booking.status)) {
    throw new PaymentOperationError(
      "This booking is already confirmed or closed. Please use its existing payment or booking link.",
    );
  }
}
