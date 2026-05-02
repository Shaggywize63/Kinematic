/**
 * Demo fixtures for distribution endpoints. Returned when isDemo(user) is true.
 * Keep deterministic and small.
 */

const DEMO_BRAND_ID = 'demo-brand-0001';
const DEMO_DIST_ID = 'demo-dist-0001';
const DEMO_OUTLET_ID = 'demo-outlet-0001';
const DEMO_SKU_1 = 'demo-sku-0001';
const DEMO_SKU_2 = 'demo-sku-0002';
const DEMO_PRICE_LIST_ID = 'demo-pl-0001';

export const getDemoBrands = () => ([
  { id: DEMO_BRAND_ID, name: 'Aurora Foods', code: 'AURORA', gstin: '27AAACA1234A1Z5', state_code: '27', is_active: true, created_at: new Date().toISOString() },
  { id: 'demo-brand-0002', name: 'Northwind Beverages', code: 'NORTHW', gstin: '07AAACN5678B1Z2', state_code: '07', is_active: true, created_at: new Date().toISOString() },
]);

export const getDemoDistributors = () => ([
  { id: DEMO_DIST_ID, name: 'Mumbai Central Distribution', code: 'MCD-001', gstin: '27AABCM1234M1ZQ', state_code: '27', place_of_supply: '27', credit_limit: 500000, payment_terms_days: 21, customer_class: 'distributor', region: 'West', is_active: true, current_outstanding: 235000 },
  { id: 'demo-dist-0002', name: 'Pune Suburb Stockist', code: 'PSS-002', gstin: '27AABCP9876P1ZK', state_code: '27', credit_limit: 250000, payment_terms_days: 15, customer_class: 'super_stockist', region: 'West', is_active: true, current_outstanding: 88000 },
]);

export const getDemoPriceLists = () => ([
  { id: DEMO_PRICE_LIST_ID, name: 'GT West April', customer_class: 'GT', region: 'West', version: 1, is_active: true, valid_from: '2026-04-01', valid_to: null, item_count: 42 },
]);

export const getDemoSchemes = () => ([
  { id: 'demo-scheme-0001', code: 'AURORA-MAY-QPS', name: 'Aurora May QPS', type: 'QPS', priority: 100, valid_from: '2026-05-01', valid_to: '2026-05-31', is_active: true, version: 1 },
]);

export const getDemoOrder = () => ({
  id: 'demo-order-0001',
  order_no: 'ORD-260502-00001',
  outlet_id: DEMO_OUTLET_ID,
  outlet_name: 'Sharma Kirana Store',
  distributor_id: DEMO_DIST_ID,
  salesman_id: 'demo-user-id',
  status: 'placed',
  placed_at: new Date().toISOString(),
  geofence_passed: true,
  subtotal: 4500,
  discount_total: 200,
  scheme_total: 0,
  taxable_value: 4300,
  cgst: 387,
  sgst: 387,
  igst: 0,
  cess: 0,
  grand_total: 5074,
  items: [
    { id: 'demo-oi-1', sku_id: DEMO_SKU_1, sku_name: 'Aurora Hazelnut Spread 350g', qty: 12, uom: 'PCS', unit_price: 250, mrp: 285, taxable_value: 3000, gst_rate: 18, cgst: 270, sgst: 270, total: 3540 },
    { id: 'demo-oi-2', sku_id: DEMO_SKU_2, sku_name: 'Aurora Wholewheat Cookies 200g', qty: 10, uom: 'PCS', unit_price: 130, mrp: 150, taxable_value: 1300, gst_rate: 18, cgst: 117, sgst: 117, total: 1534 },
  ],
});

export const getDemoOrderList = () => ([
  getDemoOrder(),
  { ...getDemoOrder(), id: 'demo-order-0002', order_no: 'ORD-260501-00007', status: 'invoiced', placed_at: new Date(Date.now() - 86400000).toISOString() },
  { ...getDemoOrder(), id: 'demo-order-0003', order_no: 'ORD-260501-00006', status: 'approved', placed_at: new Date(Date.now() - 90000000).toISOString() },
]);

export const getDemoCartSuggest = () => ({
  outlet: { id: DEMO_OUTLET_ID, name: 'Sharma Kirana Store', current_balance: 12500, credit_limit: 50000 },
  last_orders: getDemoOrderList().slice(0, 2),
  recommendations: [
    { sku_id: DEMO_SKU_1, sku_name: 'Aurora Hazelnut Spread 350g', mrp: 285, suggested_qty: 12, reason: 'Reorder' },
    { sku_id: DEMO_SKU_2, sku_name: 'Aurora Wholewheat Cookies 200g', mrp: 150, suggested_qty: 10, reason: 'Planogram gap' },
  ],
});

export const getDemoRouteToday = () => ({
  date: new Date().toISOString().slice(0, 10),
  outlets: [
    { id: DEMO_OUTLET_ID, name: 'Sharma Kirana Store', address: 'Andheri West, Mumbai', lat: 19.1364, lng: 72.8296, geofence_radius_m: 100, current_balance: 12500, credit_limit: 50000, last_order_at: new Date(Date.now() - 5 * 86400000).toISOString(), status: 'pending' },
    { id: 'demo-outlet-0002', name: 'Patel Provision Mart', address: 'Bandra East, Mumbai', lat: 19.0596, lng: 72.8400, geofence_radius_m: 100, current_balance: 0, credit_limit: 25000, last_order_at: null, status: 'pending' },
  ],
});

export const getDemoInvoice = () => ({
  id: 'demo-inv-0001',
  invoice_no: '020526-DIST-00012',
  order_id: 'demo-order-0002',
  outlet_id: DEMO_OUTLET_ID,
  distributor_id: DEMO_DIST_ID,
  irn: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  qr_code_url: null,
  eway_bill_no: null,
  status: 'issued',
  grand_total: 5074,
  issued_at: new Date(Date.now() - 86400000).toISOString(),
});

export const getDemoLedger = () => ({
  outlet_id: DEMO_OUTLET_ID,
  current_balance: 12500,
  credit_limit: 50000,
  ageing: { '0_30': 12500, '31_60': 0, '61_90': 0, '90_plus': 0 },
  entries: [
    { id: 'demo-le-1', entry_type: 'invoice', ref_id: 'demo-inv-0001', dr: 5074, cr: 0, running_balance: 12500, posted_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 'demo-le-2', entry_type: 'payment', ref_id: 'demo-pay-0001', dr: 0, cr: 3000, running_balance: 7426, posted_at: new Date(Date.now() - 43200000).toISOString() },
  ],
});

export const getDemoPayments = () => ([
  { id: 'demo-pay-0001', payment_no: 'PAY-260502-00003', outlet_id: DEMO_OUTLET_ID, mode: 'cash', amount: 3000, received_at: new Date().toISOString(), status: 'cleared' },
]);

export const getDemoReturns = () => ([
  { id: 'demo-ret-0001', return_no: 'RET-260502-00001', outlet_id: DEMO_OUTLET_ID, original_invoice_id: 'demo-inv-0001', status: 'requested', total_value: 540, reason_code: 'damaged', created_at: new Date().toISOString() },
]);

export const getDemoAgeingSummary = () => ({
  total_outstanding: 235000,
  buckets: { '0_30': 145000, '31_60': 60000, '61_90': 22000, '90_plus': 8000 },
  by_distributor: [
    { distributor_id: DEMO_DIST_ID, name: 'Mumbai Central Distribution', total: 235000 },
  ],
});
