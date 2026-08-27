// This standalone audit server intentionally runs as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");

const mockPort = Number(process.env.MOCK_PORT || 4173);
const vitePort = Number(process.env.VITE_PORT || 5173);
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${mockPort}`;

const bookings = new Map();
let nextBookingId = 1;
let nextAttendeeId = 1;

const now = () => new Date().toISOString();

function calculatePricing(body = {}) {
  const quantity = Number(body.quantity || 1);
  const passType = body.passType || "single";
  const pricePerHead = passType === "business" ? 599 : 199;
  const thresholds =
    passType === "business"
      ? [
          [5, 15],
          [2, 10],
        ]
      : [
          [12, 20],
          [8, 15],
          [4, 10],
        ];
  const groupDiscountPercent = thresholds.find(([minimum]) => quantity >= minimum)?.[1] || 0;
  const baseSubtotal = pricePerHead * quantity;
  const groupDiscountAmount = (baseSubtotal * groupDiscountPercent) / 100;
  const promoDiscountAmount =
    body.promoCode === "FREEPASS" ? baseSubtotal - groupDiscountAmount : 0;
  const subtotalAfterDiscounts = Math.max(
    0,
    baseSubtotal - groupDiscountAmount - promoDiscountAmount,
  );
  const vatAmount = subtotalAfterDiscounts * 0.2;

  return {
    passType,
    quantity,
    pricePerHead,
    baseSubtotal,
    groupDiscountPercent,
    groupDiscountAmount,
    promoDiscountAmount,
    subtotalAfterDiscounts,
    vatRate: 20,
    vatAmount,
    total: subtotalAfterDiscounts + vatAmount,
    originalPrice: (passType === "business" ? 999 : 429) * quantity,
    savedAmount: groupDiscountAmount + promoDiscountAmount,
    promoDiscountType: body.promoCode === "FREEPASS" ? "complimentary" : null,
    promoRemainingSeats: body.promoCode === "FREEPASS" ? 20 : null,
  };
}

function decorateBooking(booking) {
  return {
    ...booking,
    invoiceBadgeStatus: booking.status === "invoiced" ? "sent" : "pending",
    confirmationEmailSent: true,
    welcomeEmailsSent: true,
    organiserNotified: true,
    sheetsSynced: true,
    needsAttention: false,
  };
}

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function findBookingById(id) {
  return [...bookings.values()].find((booking) => booking.id === Number(id));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost:4173");
  const path = url.pathname;
  const method = request.method;

  if (path.startsWith("/api/")) {
    const body = await readJson(request);

    if (method === "GET" && path.startsWith("/api/bookings/by-session/")) {
      const token = decodeURIComponent(path.split("/").pop());
      let booking = bookings.get(token);
      if (!booking && request.headers.host?.startsWith("127.0.0.1")) {
        const bookingId = nextBookingId++;
        booking = {
          id: bookingId,
          sessionToken: token,
          status: "partial",
          passType: "business",
          attendeeType: "consultant_vendor",
          quantity: 1,
          promoCode: null,
          promoDiscountAmount: null,
          groupDiscountAmount: null,
          subtotalAmount: 599,
          vatAmount: 119.8,
          totalAmount: 718.8,
          paymentMethod: null,
          currentStep: 3,
          billingName: null,
          billingCompany: null,
          billingEmail: null,
          billingAddressLine1: null,
          billingAddressLine2: null,
          billingTown: null,
          billingRegion: null,
          billingPostcode: null,
          billingCountry: "United Kingdom",
          billingPhone: null,
          billingVatNumber: null,
          poNumber: null,
          managementToken: "mock-manage-token",
          orderReference: null,
          stripeInvoicePaymentUrl: null,
          stripeInvoicePdfUrl: null,
          attendees: [
            {
              id: nextAttendeeId++,
              bookingId,
              isLead: true,
              isTbc: false,
              firstName: "Taylor",
              lastName: "Reed",
              jobTitle: "Managing Partner",
              company: "Strategic People Ltd",
              workEmail: "taylor.reed@example.com",
              phone: "+44 7700 900456",
              gdprConsent: true,
              seatIndex: 0,
              createdAt: now(),
              updatedAt: now(),
            },
          ],
          createdAt: now(),
          updatedAt: now(),
        };
        bookings.set(token, booking);
      }
      sendJson(response, 200, booking ? decorateBooking(booking) : null);
      return;
    }

    if (method === "POST" && path === "/api/bookings/start") {
      const pricing = calculatePricing(body);
      const bookingId = nextBookingId++;
      const lead = {
        id: nextAttendeeId++,
        bookingId,
        isLead: true,
        isTbc: false,
        firstName: body.firstName,
        lastName: body.lastName,
        jobTitle: body.jobTitle,
        company: body.company,
        workEmail: body.workEmail,
        phone: body.phone || null,
        gdprConsent: true,
        seatIndex: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      const booking = {
        id: bookingId,
        sessionToken: body.sessionToken,
        status: "partial",
        passType: "single",
        attendeeType: body.attendeeType,
        quantity: 1,
        promoCode: null,
        promoDiscountAmount: null,
        groupDiscountAmount: null,
        subtotalAmount: pricing.subtotalAfterDiscounts,
        vatAmount: pricing.vatAmount,
        totalAmount: pricing.total,
        paymentMethod: null,
        currentStep: body.currentStep || 2,
        billingName: null,
        billingCompany: null,
        billingEmail: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingTown: null,
        billingRegion: null,
        billingPostcode: null,
        billingCountry: "United Kingdom",
        billingPhone: null,
        billingVatNumber: null,
        poNumber: null,
        managementToken: "mock-manage-token",
        orderReference: null,
        stripeInvoicePaymentUrl: null,
        stripeInvoicePdfUrl: null,
        attendees: [lead],
        createdAt: now(),
        updatedAt: now(),
      };
      bookings.set(body.sessionToken, booking);
      sendJson(response, 201, decorateBooking(booking));
      return;
    }

    const bookingMatch = path.match(/^\/api\/bookings\/(\d+)$/);
    if (bookingMatch && method === "PATCH") {
      const booking = findBookingById(bookingMatch[1]);
      Object.assign(booking, body, { updatedAt: now() });
      const pricing = calculatePricing(booking);
      Object.assign(booking, {
        subtotalAmount: pricing.subtotalAfterDiscounts,
        vatAmount: pricing.vatAmount,
        totalAmount: pricing.total,
        groupDiscountAmount: pricing.groupDiscountAmount || null,
        promoDiscountAmount: pricing.promoDiscountAmount || null,
      });
      sendJson(response, 200, decorateBooking(booking));
      return;
    }

    const attendeeCollectionMatch = path.match(/^\/api\/bookings\/(\d+)\/attendees$/);
    if (attendeeCollectionMatch && method === "POST") {
      const booking = findBookingById(attendeeCollectionMatch[1]);
      const attendee = {
        id: nextAttendeeId++,
        bookingId: booking.id,
        isLead: false,
        isTbc: false,
        ...body,
        createdAt: now(),
        updatedAt: now(),
      };
      const existingIndex = booking.attendees.findIndex(
        (item) => item.seatIndex === attendee.seatIndex && !item.isLead,
      );
      if (existingIndex >= 0) {
        booking.attendees[existingIndex] = attendee;
      } else {
        booking.attendees.push(attendee);
      }
      sendJson(response, 201, attendee);
      return;
    }

    const attendeeMatch = path.match(/^\/api\/bookings\/(\d+)\/attendees\/(\d+)$/);
    if (attendeeMatch && method === "PATCH") {
      const booking = findBookingById(attendeeMatch[1]);
      const attendee = booking.attendees.find((item) => item.id === Number(attendeeMatch[2]));
      Object.assign(attendee, body, { updatedAt: now() });
      sendJson(response, 200, attendee);
      return;
    }

    if (method === "POST" && path === "/api/pricing/calculate") {
      sendJson(response, 200, calculatePricing(body));
      return;
    }

    if (method === "GET" && path === "/api/discount-tiers") {
      sendJson(response, 200, [
        {
          id: 1,
          passType: "single",
          minQuantity: 4,
          discountPercent: 10,
          label: "Group",
        },
        {
          id: 2,
          passType: "single",
          minQuantity: 8,
          discountPercent: 15,
          label: "Group Plus",
        },
        {
          id: 3,
          passType: "business",
          minQuantity: 2,
          discountPercent: 10,
          label: "Team",
        },
      ]);
      return;
    }

    if (method === "GET" && path === "/api/passes/inventory") {
      sendJson(response, 200, { single: 84, business: 18 });
      return;
    }

    if (method === "GET" && path === "/api/passes/config") {
      sendJson(response, 200, {
        single: {
          passType: "single",
          currentPrice: "199",
          originalPrice: "429",
          pricingPeriodName: "Early Bird",
          benefits: [
            "Full-day summit access",
            "Practical breakout sessions",
            "Networking lunch",
            "Post-event content",
          ],
          extraBenefits: [],
        },
        business: {
          passType: "business",
          currentPrice: "599",
          originalPrice: "999",
          pricingPeriodName: "Early Bird",
          benefits: [
            "Full-day summit access",
            "Practical breakout sessions",
            "Networking lunch",
            "Post-event content",
          ],
          extraBenefits: ["Exclusive attendee report", "Company branding at the summit"],
        },
      });
      return;
    }

    if (method === "GET" && path === "/api/hear-about-us-options") {
      sendJson(response, 200, [
        { id: 1, label: "LinkedIn" },
        { id: 2, label: "Email newsletter" },
        { id: 3, label: "Colleague recommendation" },
      ]);
      return;
    }

    if (method === "POST" && path === "/api/promo-codes/validate") {
      sendJson(
        response,
        200,
        body.code === "FREEPASS"
          ? { valid: true, code: "FREEPASS", remainingSeats: 20 }
          : { valid: false, error: "Invalid promo code" },
      );
      return;
    }

    if (method === "GET" && path === "/api/event-settings/public") {
      sendJson(response, 200, {
        invoiceHelpContent:
          "Invoices are issued immediately and include bank transfer details. Purchase order numbers can be added later through the secure billing link.",
      });
      return;
    }

    if (method === "POST" && path === "/api/stripe/create-checkout-session") {
      sendJson(response, 200, {
        url: `${publicOrigin}/?session_id=mock_card&step=5`,
        sessionId: "mock_card",
      });
      return;
    }

    if (method === "POST" && path === "/api/stripe/confirm-card-payment") {
      const booking = findBookingById(body.bookingId);
      Object.assign(booking, {
        status: "paid",
        paymentMethod: "card",
        currentStep: 5,
        orderReference: "SWP27-7001",
        paidAt: now(),
      });
      sendJson(response, 200, { confirmed: true, status: "paid" });
      return;
    }

    if (method === "POST" && path === "/api/stripe/create-invoice") {
      const booking = findBookingById(body.bookingId);
      Object.assign(booking, {
        status: "invoiced",
        paymentMethod: "invoice",
        currentStep: 5,
        orderReference: "SWP27-7002",
        stripeInvoicePaymentUrl: "https://example.com/mock-invoice",
        stripeInvoicePdfUrl: "https://example.com/mock.pdf",
      });
      sendJson(response, 200, { invoiceId: "in_mock", status: "open" });
      return;
    }

    if (method === "POST" && path.endsWith("/incomplete-ping")) {
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "Mock route not found", path });
    return;
  }

  const proxyRequest = http.request(
    {
      hostname: "127.0.0.1",
      port: vitePort,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 500, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );
  proxyRequest.on("error", (error) => {
    response.writeHead(502);
    response.end(String(error));
  });
  request.pipe(proxyRequest);
});

server.listen(mockPort, "127.0.0.1");
