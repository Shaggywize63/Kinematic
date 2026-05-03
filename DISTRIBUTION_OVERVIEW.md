# Distribution Module — Overview

> **Order to outlet, one trail.**
> Brand → Distributor → Field Salesman → Outlet → Consumer

## What it is

A complete digital backbone for FMCG distribution. From the brand setting
prices to the consumer picking the product off the shelf, every step is
captured, priced correctly, paid for, and audited — on one platform.

Today, distribution leaks happen at every handoff: a salesman writes a wrong
price, a scheme gets misapplied, a cheque goes missing, returns get fudged,
ledgers don't tie. This module closes those gaps end-to-end.

---

## The five steps

### 1 · Brand
**Plan, targets, prices.**
The brand team sets up products with GST details, defines who can buy at
what price (modern trade vs general trade vs wholesale), and rolls out
trade schemes — buy-one-get-one, slab discounts, value offers, free goods.

Every price list and scheme is **versioned** — change it tomorrow and old
orders still show what they were sold at, forever.

### 2 · Distributor
**Stock, billing, schemes.**
Distributors see their open orders, dispatched goods, paid invoices, and
ageing receivables (0–30, 31–60, 61–90, 90+ days) at a glance. The
billing summary tells them exactly which outlets are healthy and which
are slipping into late payment.

### 3 · Field Salesman
**Order capture, payment, returns.**
The salesman opens the app, taps an outlet from today's beat plan, and
captures an order in **three taps** — the cart is pre-populated with the
last few orders and shelf-gap recommendations. Schemes and taxes are
calculated automatically. Payment can be collected on the spot — cash,
UPI QR, cheque (with mandatory photo), or against credit. Returns
require a photo and a reason; large returns escalate to a supervisor.

**Works offline.** A salesman in a basement market with no signal can
still book the order; it syncs the moment connectivity returns, with no
risk of double-booking.

### 4 · Outlet
**Delivered, billed, audited.**
Approved orders convert to a tax-correct invoice (GSTIN, HSN, CGST/SGST/
IGST, IRN-ready). Goods are grouped onto a vehicle dispatch — anything
above ₹50,000 automatically requires an e-way bill before it can leave.
On delivery, the driver captures a Proof-of-Delivery photo and the
shopkeeper's signature; the invoice is then closed against the outlet's
ledger.

### 5 · Consumer
**On-shelf, in-hand.**
Even after the goods reach the outlet, the loop closes. Salesmen capture
shelf compliance via the existing planogram module, and outlet-level
"off-take" (how many units actually sold to consumers) gets reported per
SKU, per period. Brands finally see **what's selling** versus **what's
sitting on the shelf**.

---

## What each persona gets

### Brands
- One source of truth for prices, schemes, and targets across all distributors
- Visibility into actual consumer off-take, not just what was billed to distributors
- Confidence that schemes are applied exactly as designed — no manual error, no manipulation

### Distributors
- Faster invoicing, fewer disputes, automatic e-way bills above the legal threshold
- Real-time view of outstanding receivables and ageing
- Cheque tracking with mandatory photo capture — no more "where did that cheque go?"

### Field Salesmen
- Three-tap order capture, even in a no-signal market
- Smart recommendations based on the outlet's last orders and shelf gaps
- Automatic tax + scheme calculation — no mental math, no errors
- Same screen for collecting payment and recording returns

### Outlets
- Tax-correct invoices that match what they ordered
- Clear running balance against their credit limit
- Photo + signature delivery proof — no "I never got that" disputes

### Operations & Finance
- Complete audit trail of every action — who did what, when, from where
- Double-entry ledger that physically cannot go negative (without an admin override that's itself logged)
- Ageing reports, GMV dashboards, scheme-spend visibility — all in one place

---

## Loopholes this closes

Every fraud pattern we've seen in distribution has a specific guard:

| Risk | What stops it |
|---|---|
| Salesman quotes wrong price to favour a friendly outlet | Server always re-calculates the price; the salesman's number is rejected if it differs by more than 1 paisa |
| Same order entered twice (network glitch, duplicate tap) | Every confirmation gets a unique key — replays return the original order, never a duplicate |
| Cheque collected and never deposited | Cheque payment is rejected unless a photo of the cheque is attached, taken via the app's camera |
| Ghost orders booked from outside the outlet | Every order is GPS-stamped; orders captured outside the outlet's geofence are flagged for supervisor review |
| Salesman books beyond their authority | Daily caps and per-order caps stop oversize orders before they hit the system |
| Outlet returns inflated to wipe out a debt | Returns require a photo of the goods and a reason code; large returns escalate to a supervisor |
| Selling on credit beyond the agreed limit | The ledger physically refuses to push past the credit limit unless an admin explicitly overrides — and that override is itself logged |
| Scheme rules quietly changed mid-cycle | Schemes are versioned; old orders stay priced under the version they were booked with, and every application is logged for audit |
| e-way bill skipped on a large dispatch | Above ₹50,000, the system blocks dispatch from leaving until an e-way bill is attached |
| Delivery never actually happened | Delivery requires a photo + signature on file; both are captured at the outlet |

---

## What's running today

The module is built and tested across four parts of the platform:

- **Backend API** — handles all the rules, math, and storage
- **Web Dashboard** — for brand, distributor, and operations teams
- **Android app** — for field salesmen
- **iOS app** — for field salesmen

A working demo dataset is already loaded in staging (one brand, one
distributor, three SKUs, two outlets, one salesman) and a complete
order-to-invoice-to-payment cycle has been smoke-tested end-to-end.

---

## What's next

A few business decisions are still open before we go live with real
customers:

1. **GST e-invoice provider** — we need to pick a registered partner
   (NIC sandbox, ClearTax, or Cygnet) to generate live IRN numbers
   instead of the test placeholder we have today.
2. **e-way bill provider** — same decision; same options.
3. **UPI gateway** — Razorpay and PhonePe both work; we just need to
   pick one for production.
4. **Scheme rules** — confirm with the brand team how stacking should
   work when multiple schemes target the same SKU.
5. **Returns window** — the default is 30 days; some brands may want
   shorter or longer.

Once those five decisions land, we can flip live with the first pilot
distributor.

---

## In one sentence

This module turns distribution from a handful of WhatsApp groups, paper
chits, and Excel sheets into a single, accountable digital trail —
designed so that a salesman, a distributor, and a brand owner all see
the same numbers, on the same day, with no room for them to disagree.
