/**
 * server.js — REST backend for ktb-atm-vault-dbms.html
 * Krungthai Bank (KTB) ATM Network Vault Logistics DBMS · KMITL / Ladkrabang
 * Academic DBMS prototype · fictional demo data · not affiliated with Krungthai Bank PCL
 *
 *   npm install express mysql2 cors
 *   node server.js            →  http://localhost:3000
 *
 * Put ktb-atm-vault-dbms.html in the same folder as this file.
 * Load database.sql into TiDB Cloud first (creates ktb_atm_vault + seed data).
 *
 * Auth: POST /api/login returns a token. Send it on every other /api call:
 *   Authorization: Bearer <token>
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

/* =====================================================================
 * 1. TiDB Cloud connection  ← FILL IN YOUR CLUSTER DETAILS
 *    (TiDB Cloud console → your cluster → "Connect" → "General")
 *    You can also set them as environment variables instead of editing here.
 * ===================================================================== */
const DB_CONFIG = {
  host: process.env.TIDB_HOST ||'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',         // e.g. gateway01.ap-southeast-1.prod.aws.tidbcloud.com
  port: Number(process.env.TIDB_PORT || 4000),
  user: process.env.TIDB_USER || '3j4SV8XmeVgiwXJ.root',         // e.g. 2aBcDeFgHiJkLmN.root
  password: process.env.TIDB_PASSWORD || 'FLE5m6vQLDiqL1oD',
  database: 'ktb_atm_vault',
};

const pool = mysql.createPool({
  ...DB_CONFIG,
  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    // Optional: path to a CA bundle if your OS trust store lacks the TiDB Cloud CA
    ...(process.env.TIDB_CA_PATH ? { ca: fs.readFileSync(process.env.TIDB_CA_PATH) } : {}),
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,     // DATE / DATETIME come back as 'YYYY-MM-DD' strings (no timezone shift)
  decimalNumbers: true,  // DECIMAL columns come back as JS numbers
});

/* =====================================================================
 * 2. App constants (same business rules as the HTML front end)
 * ===================================================================== */
const PORT = Number(process.env.PORT || 3000);
const HTML_FILE = path.join(__dirname, 'ktb-atm-vault-dbms.html');
const CIT_FLEET = 4;                                    // armored trucks at the Central Vault Hub
const TIME_SLOTS = ['09:00-12:00', '13:00-16:00'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;              // 8-hour shift

// REPLENISHMENT_ORDER.status is ENUM('pending','approve','reject','cancel','completed') in database.sql.
// The API reports APPROVED / REJECTED, but must store the schema's ENUM values (TiDB strict mode rejects others).
const ORDER_STATUS = { PENDING: 'pending', APPROVED: 'approve', REJECTED: 'reject', CANCELLED: 'cancel', COMPLETED: 'completed' };

// ATM status rule from ATM_Terminals.xlsx: ≤20% CRITICAL, ≤30% LOW WARNING, otherwise NORMAL
const atmStatus = (balance, max) => (balance / max <= 0.2 ? 'CRITICAL' : balance / max <= 0.3 ? 'LOW WARNING' : 'NORMAL');

const todayBangkok = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()); // YYYY-MM-DD

/* =====================================================================
 * 3. Default seed data (identical to database.sql) — used by POST /api/reset
 *    DEMO ONLY: plain-text passwords to match the front end; hash them in production.
 * ===================================================================== */
const SEED = {
  VAULT_ADMIN: {
    columns: ['admin_id', 'admin_code', 'username', 'password', 'email', 'firstname', 'lastname', 'role_title', 'created_at'],
    rows: [
      [1, 'VAULT-MGR-01', 'vault_admin', 'ktbAdmin@2026', 'admin@ktb-vault.co.th', 'Kittipong', 'Rattanakorn', 'Central Vault Admin · Ladkrabang Hub', '2026-01-02 08:00:00'],
    ],
  },
  OFFICER_PROFILE: {
    columns: ['officer_id', 'employee_code', 'username', 'password', 'email', 'firstname', 'lastname', 'assigned_zone', 'created_at'],
    rows: [
      [1, 'KTB-LKB-101', 'officer_zoneA', 'ktbZoneA@2026', 'somchai.c@ktb-demo.co.th', 'Somchai', 'Chaiyaporn', 'Zone A', '2026-01-05 08:30:00'],
      [2, 'KTB-LKB-102', 'officer_zoneB', 'ktbZoneB@2026', 'nattapong.w@ktb-demo.co.th', 'Nattapong', 'Wongsuwan', 'Zone B', '2026-01-05 08:35:00'],
      [3, 'KTB-LKB-103', 'officer_zoneC', 'ktbZoneC@2026', 'waraporn.s@ktb-demo.co.th', 'Waraporn', 'Srisuk', 'Zone C', '2026-01-05 08:40:00'],
    ],
  },
  ATM_TERMINAL: {
    columns: ['atm_id', 'terminal_code', 'location_name', 'zone', 'zone_type', 'max_capacity_thb', 'current_balance_thb', 'safety_stock_thb', 'avg_daily_withdrawal_thb', 'lead_time_days', 'reorder_point_thb', 'status', 'latitude', 'longitude'],
    rows: [
      [2001, 'KTB-KMITL-01', 'Krungthai Bank KMITL Branch (สาขาพระจอมเกล้าฯ ลาดกระบัง)', 'Zone A', 'Bank Branch', 4000000, 640000, 800000, 650000, 0.5, 1125000, 'CRITICAL', 13.7277487, 100.7733317],
      [2002, 'KTB-KMITL-02', 'Faculty of Engineering, KMITL (คณะวิศวกรรมศาสตร์)', 'Zone A', 'Academic', 3000000, 2100000, 600000, 420000, 0.5, 810000, 'NORMAL', 13.727671, 100.7734606],
      [2003, 'KTB-KMITL-03', 'Faculty of Science, KMITL (คณะวิทยาศาสตร์)', 'Zone A', 'Academic', 3000000, 1950000, 600000, 380000, 0.5, 790000, 'NORMAL', 13.729412, 100.775824],
      [2004, 'KTB-KMITL-04', 'KMITL Central Library / Convention Hall (สำนักหอสมุดกลาง)', 'Zone A', 'Academic', 3000000, 750000, 600000, 400000, 0.5, 800000, 'LOW WARNING', 13.72855, 100.77791],
      [2005, 'KTB-KMITL-05', 'Faculty of IT & Architecture Zone (โซนคณะไอทีและสถาปัตย์)', 'Zone B', 'Academic', 3000000, 2250000, 600000, 350000, 0.5, 775000, 'NORMAL', 13.73084, 100.78123],
      [2006, 'KTB-KMITL-06', 'King Mongkut Chaokhun Thahan Hospital (โรงพยาบาลพระจอมเกล้าฯ)', 'Zone B', 'Medical', 3500000, 525000, 700000, 580000, 0.5, 990000, 'CRITICAL', 13.72998, 100.77215],
      [2007, 'KTB-KMITL-07', 'Soi Chalong Krung 1 Dormitory Zone (ซอยฉลองกรุง 1)', 'Zone C', 'Residential', 3500000, 560000, 700000, 600000, 0.5, 1000000, 'CRITICAL', 13.72689, 100.77124],
      [2008, 'KTB-KMITL-08', 'Krungthai Bank Hua Takhe Branch / Market (สาขาหัวตะเข้)', 'Zone C', 'Market', 4000000, 1040000, 800000, 620000, 0.5, 1110000, 'LOW WARNING', 13.72195, 100.78462],
      [2009, 'KTB-KMITL-09', 'RNP Place / V-Market Ladkrabang (โซนหอพัก RNP)', 'Zone C', 'Commercial', 3500000, 2450000, 700000, 480000, 0.5, 940000, 'NORMAL', 13.72542, 100.77985],
      [2010, 'KTB-KMITL-10', 'FBT Sports Complex / Chalong Krung Junction (แยกฉลองกรุง)', 'Zone B', 'Commercial', 3000000, 2400000, 600000, 390000, 0.5, 795000, 'NORMAL', 13.73215, 100.77318],
    ],
  },
  VAULT_INVENTORY: {
    columns: ['cassette_id', 'cassette_code', 'cassette_name', 'denomination_thb', 'notes_per_cassette', 'value_per_cassette_thb', 'vault_stock_units', 'min_vault_buffer_units'],
    rows: [
      [1001, 'CST-1000', 'Sealed Cassette 1,000 THB', 1000, 2000, 2000000, 40, 10],
      [1002, 'CST-500', 'Sealed Cassette 500 THB', 500, 2000, 1000000, 35, 10],
      [1003, 'CST-100', 'Sealed Cassette 100 THB', 100, 2000, 200000, 50, 15],
    ],
  },
  REPLENISHMENT_ORDER: {
    columns: ['order_id', 'officer_id', 'admin_id', 'atm_id', 'cassette_id', 'cassette_qty', 'total_value_thb', 'dispatch_date', 'time_slot', 'status', 'short_month'],
    rows: [
      [1, 1, 1, 2001, 1001, 1, 2000000, '2026-01-14', '09:00-12:00', 'completed', 'Jan'],
      [2, 2, 1, 2006, 1002, 2, 2000000, '2026-02-10', '13:00-16:00', 'completed', 'Feb'],
      [3, 3, 1, 2007, 1002, 2, 2000000, '2026-03-09', '09:00-12:00', 'completed', 'Mar'],
      [4, 1, 1, 2001, 1002, 3, 3000000, '2026-04-21', '09:00-12:00', 'completed', 'Apr'],
      [5, 2, 1, 2006, 1001, 1, 2000000, '2026-06-03', '13:00-16:00', 'completed', 'Jun'],
      [6, 3, 1, 2007, 1003, 10, 2000000, '2026-08-18', '09:00-12:00', 'completed', 'Aug'],
      [7, 1, 1, 2001, 1001, 1, 2000000, '2026-10-07', '13:00-16:00', 'completed', 'Oct'],
      [8, 1, null, 2001, 1002, 3, 3000000, '2026-11-18', '09:00-12:00', 'pending', 'Nov'],
      [9, 2, null, 2006, 1002, 2, 2000000, '2026-11-19', '13:00-16:00', 'pending', 'Nov'],
      [10, 3, 1, 2007, 1001, 1, 2000000, '2026-11-17', '09:00-12:00', 'approve', 'Nov'],
      [11, 2, 1, 2006, 1003, 5, 1000000, '2026-11-12', '13:00-16:00', 'reject', 'Nov'],
      [12, 3, null, 2007, 1002, 2, 2000000, '2026-11-10', '09:00-12:00', 'cancel', 'Nov'],
    ],
  },
};

// Parents first for INSERT, children first for DELETE
const INSERT_ORDER = ['VAULT_ADMIN', 'OFFICER_PROFILE', 'ATM_TERMINAL', 'VAULT_INVENTORY', 'REPLENISHMENT_ORDER'];
const DELETE_ORDER = [...INSERT_ORDER].reverse();

/* =====================================================================
 * 4. Sessions (in-memory bearer tokens; cleared when the server restarts)
 * ===================================================================== */
const sessions = new Map(); // token -> { role: 'officer' | 'admin', id, zone, expires }

function createSession(role, id, zone = null) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, id, zone, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireAuth(req, res, next) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const s = m && sessions.get(m[1]);
  if (!s || s.expires < Date.now()) {
    if (m) sessions.delete(m[1]);
    return res.status(401).json({ error: 'Not logged in or session expired. Please log in again.' });
  }
  req.session = s;
  next();
}

const requireRole = (role) => (req, res, next) =>
  req.session.role === role ? next() : res.status(403).json({ error: `Only the ${role === 'admin' ? 'Central Vault Admin' : 'CIT Field Officer'} can do this.` });

// Wraps async route handlers so thrown errors reach the error handler
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Constant-time password comparison (column collation is case-insensitive, so compare in JS, not SQL)
function passwordMatches(input, stored) {
  const a = Buffer.from(String(input)), b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const toId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id.');
  return n;
};

/* =====================================================================
 * 5. Express app
 * ===================================================================== */
const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN || `http://localhost:${PORT},http://127.0.0.1:${PORT}`).split(',') }));
app.use(express.json({ limit: '100kb' }));

// Serve ONLY the HTML file (no express.static on this folder — it would expose server.js and database.sql)
app.get('/', (req, res) => res.sendFile(HTML_FILE));
app.get('/ktb-atm-vault-dbms.html', (req, res) => res.sendFile(HTML_FILE));

// Health check — confirms the TiDB connection works
app.get('/api/health', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db');
  res.json({ ok: true, ...rows[0] });
}));

/* ---------------------------------------------------------------------
 * POST /api/login   { username, password }
 * Checks OFFICER_PROFILE, then VAULT_ADMIN. Username is case-insensitive,
 * password must match exactly. Never returns the password.
 * ------------------------------------------------------------------- */
app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '').trim();
  if (!username || !password) throw new HttpError(400, 'Please enter both your username and password.');

  const [officers] = await pool.execute(
    `SELECT officer_id, employee_code, username, password, email, firstname, lastname, assigned_zone, created_at
       FROM OFFICER_PROFILE WHERE LOWER(username) = ?`, [username]);
  const off = officers.find((o) => passwordMatches(password, o.password));
  if (off) {
    const { password: _omit, ...account } = off;
    const token = createSession('officer', off.officer_id, off.assigned_zone);
    return res.json({ token, role: 'officer', account });
  }

  const [admins] = await pool.execute(
    `SELECT admin_id, admin_code, username, password, email, firstname, lastname, role_title, created_at
       FROM VAULT_ADMIN WHERE LOWER(username) = ?`, [username]);
  const adm = admins.find((a) => passwordMatches(password, a.password));
  if (adm) {
    const { password: _omit, ...account } = adm;
    const token = createSession('admin', adm.admin_id);
    return res.json({ token, role: 'admin', account });
  }

  throw new HttpError(401, 'Invalid username or password.');
}));

app.post('/api/logout', requireAuth, (req, res) => {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization)[1];
  sessions.delete(token);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
 * GET /api/data
 * Returns all five tables. Account tables come back WITHOUT username/password
 * (no cross-role credential access). Officers get only their zone's ATMs and
 * orders; the admin gets every row.
 * ------------------------------------------------------------------- */
app.get('/api/data', requireAuth, wrap(async (req, res) => {
  const isOfficer = req.session.role === 'officer';
  const zoneFilter = isOfficer ? ' WHERE zone = ?' : '';
  const zoneParams = isOfficer ? [req.session.zone] : [];

  const [[atms], [inventory], [orders], [officers], [admins]] = await Promise.all([
    pool.execute(`SELECT * FROM ATM_TERMINAL${zoneFilter} ORDER BY atm_id`, zoneParams),
    pool.query('SELECT * FROM VAULT_INVENTORY ORDER BY cassette_id'),
    isOfficer
      ? pool.execute(
          `SELECT o.* FROM REPLENISHMENT_ORDER o JOIN ATM_TERMINAL a ON a.atm_id = o.atm_id
            WHERE a.zone = ? OR o.officer_id = ? ORDER BY o.order_id`, [req.session.zone, req.session.id])
      : pool.query('SELECT * FROM REPLENISHMENT_ORDER ORDER BY order_id'),
    pool.query('SELECT officer_id, employee_code, email, firstname, lastname, assigned_zone, created_at FROM OFFICER_PROFILE ORDER BY officer_id'),
    pool.query('SELECT admin_id, admin_code, email, firstname, lastname, role_title, created_at FROM VAULT_ADMIN ORDER BY admin_id'),
  ]);

  res.json({
    ATM_TERMINAL: atms,
    VAULT_INVENTORY: inventory,
    REPLENISHMENT_ORDER: orders,
    OFFICER_PROFILE: officers,
    VAULT_ADMIN: admins,
  });
}));

/* ---------------------------------------------------------------------
 * POST /api/orders   (CIT Field Officer)
 * { atm_id, cassette_id, cassette_qty, dispatch_date: 'YYYY-MM-DD', time_slot }
 * officer_id comes from the session, total_value_thb is computed server-side,
 * and the ATM must be in the officer's own zone.
 * ------------------------------------------------------------------- */
app.post('/api/orders', requireAuth, requireRole('officer'), wrap(async (req, res) => {
  const atmId = toId(req.body?.atm_id);
  const cassetteId = toId(req.body?.cassette_id);
  const qty = Number(req.body?.cassette_qty);
  const date = String(req.body?.dispatch_date ?? '');
  const slot = String(req.body?.time_slot ?? '');

  if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new HttpError(400, 'cassette_qty must be a whole number from 1 to 100.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'dispatch_date must be YYYY-MM-DD.');
  if (date < todayBangkok()) throw new HttpError(400, 'dispatch_date cannot be in the past.');
  if (!TIME_SLOTS.includes(slot)) throw new HttpError(400, `time_slot must be one of: ${TIME_SLOTS.join(', ')}.`);

  const [[atm]] = await pool.execute('SELECT atm_id, zone, terminal_code FROM ATM_TERMINAL WHERE atm_id = ?', [atmId]);
  if (!atm) throw new HttpError(404, `ATM ${atmId} not found.`);
  if (atm.zone !== req.session.zone) throw new HttpError(403, `Access denied: ${atm.terminal_code} is outside your assigned zone (${req.session.zone}).`);

  const [[cassette]] = await pool.execute('SELECT cassette_id, value_per_cassette_thb FROM VAULT_INVENTORY WHERE cassette_id = ?', [cassetteId]);
  if (!cassette) throw new HttpError(404, `Cassette type ${cassetteId} not found.`);

  const total = qty * cassette.value_per_cassette_thb;
  const shortMonth = MONTHS[Number(date.slice(5, 7)) - 1];
  const [result] = await pool.execute(
    `INSERT INTO REPLENISHMENT_ORDER
       (officer_id, admin_id, atm_id, cassette_id, cassette_qty, total_value_thb, dispatch_date, time_slot, status, short_month)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.session.id, atmId, cassetteId, qty, total, date, slot, ORDER_STATUS.PENDING, shortMonth]);

  const [[order]] = await pool.execute('SELECT * FROM REPLENISHMENT_ORDER WHERE order_id = ?', [result.insertId]);
  res.status(201).json({ message: `Order #${order.order_id} submitted (pending).`, order });
}));

/* ---------------------------------------------------------------------
 * POST /api/orders/:id/approve   (Central Vault Admin) — ACID transaction
 *  1. lock the order (must be pending)          SELECT … FOR UPDATE
 *  2. check a CIT van is free (max 4 on the road)
 *  3. deduct cassettes from VAULT_INVENTORY     (fails if stock is short)
 *  4. add the cash to ATM_TERMINAL.current_balance_thb (capped at max capacity)
 *     and recompute ATM_TERMINAL.status (CRITICAL / LOW WARNING / NORMAL)
 *  5. set the order to APPROVED ('approve') and record admin_id
 *  Any failure → ROLLBACK, so nothing is half-applied.
 * ------------------------------------------------------------------- */
app.post('/api/orders/:id/approve', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const orderId = toId(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.execute('SELECT * FROM REPLENISHMENT_ORDER WHERE order_id = ? FOR UPDATE', [orderId]);
    if (!order) throw new HttpError(404, `Order #${orderId} not found.`);
    if (order.status !== ORDER_STATUS.PENDING) throw new HttpError(409, `Order #${orderId} is '${order.status}', only pending orders can be approved.`);

    const [[{ vans }]] = await conn.execute('SELECT COUNT(*) AS vans FROM REPLENISHMENT_ORDER WHERE status = ?', [ORDER_STATUS.APPROVED]);
    if (Number(vans) >= CIT_FLEET) throw new HttpError(409, `All ${CIT_FLEET} armored vans are already on dispatch.`);

    const [[cassette]] = await conn.execute('SELECT * FROM VAULT_INVENTORY WHERE cassette_id = ? FOR UPDATE', [order.cassette_id]);
    if (cassette.vault_stock_units < order.cassette_qty) {
      throw new HttpError(409, `Insufficient vault stock: ${cassette.vault_stock_units} × ${cassette.cassette_code} available, ${order.cassette_qty} needed.`);
    }
    await conn.execute(
      'UPDATE VAULT_INVENTORY SET vault_stock_units = vault_stock_units - ? WHERE cassette_id = ?',
      [order.cassette_qty, order.cassette_id]);

    const [[atm]] = await conn.execute('SELECT * FROM ATM_TERMINAL WHERE atm_id = ? FOR UPDATE', [order.atm_id]);
    const newBalance = Math.min(atm.max_capacity_thb, atm.current_balance_thb + order.total_value_thb);
    const newStatus = atmStatus(newBalance, atm.max_capacity_thb);
    await conn.execute(
      'UPDATE ATM_TERMINAL SET current_balance_thb = ?, status = ? WHERE atm_id = ?',
      [newBalance, newStatus, order.atm_id]);

    await conn.execute(
      'UPDATE REPLENISHMENT_ORDER SET status = ?, admin_id = ? WHERE order_id = ?',
      [ORDER_STATUS.APPROVED, req.session.id, orderId]);

    await conn.commit();
    res.json({
      message: `Order #${orderId} APPROVED.`,
      order_id: orderId,
      status: 'APPROVED',
      cassettes_deducted: order.cassette_qty,
      vault_stock_units_left: cassette.vault_stock_units - order.cassette_qty,
      atm: {
        atm_id: atm.atm_id,
        terminal_code: atm.terminal_code,
        previous_balance_thb: atm.current_balance_thb,
        current_balance_thb: newBalance,
        cash_added_thb: newBalance - atm.current_balance_thb,
        capped_at_capacity: atm.current_balance_thb + order.total_value_thb > atm.max_capacity_thb,
        status: newStatus,
      },
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}));

/* ---------------------------------------------------------------------
 * POST /api/orders/:id/reject   (Central Vault Admin)
 * ------------------------------------------------------------------- */
app.post('/api/orders/:id/reject', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const orderId = toId(req.params.id);
  const [result] = await pool.execute(
    'UPDATE REPLENISHMENT_ORDER SET status = ?, admin_id = ? WHERE order_id = ? AND status = ?',
    [ORDER_STATUS.REJECTED, req.session.id, orderId, ORDER_STATUS.PENDING]);
  if (result.affectedRows === 0) {
    const [[order]] = await pool.execute('SELECT status FROM REPLENISHMENT_ORDER WHERE order_id = ?', [orderId]);
    if (!order) throw new HttpError(404, `Order #${orderId} not found.`);
    throw new HttpError(409, `Order #${orderId} is '${order.status}', only pending orders can be rejected.`);
  }
  res.json({ message: `Order #${orderId} REJECTED.`, order_id: orderId, status: 'REJECTED' });
}));

/* ---------------------------------------------------------------------
 * POST /api/orders/:id/return   (Central Vault Admin) — "Confirm Return"
 * Closes an approved run: order → completed, emptied cassettes go back into
 * VAULT_INVENTORY, and the armored van becomes free again.
 * ------------------------------------------------------------------- */
app.post('/api/orders/:id/return', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const orderId = toId(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[order]] = await conn.execute('SELECT * FROM REPLENISHMENT_ORDER WHERE order_id = ? FOR UPDATE', [orderId]);
    if (!order) throw new HttpError(404, `Order #${orderId} not found.`);
    if (order.status !== ORDER_STATUS.APPROVED) throw new HttpError(409, `Order #${orderId} is '${order.status}', only approved orders can be returned.`);
    await conn.execute('UPDATE REPLENISHMENT_ORDER SET status = ? WHERE order_id = ?', [ORDER_STATUS.COMPLETED, orderId]);
    await conn.execute('UPDATE VAULT_INVENTORY SET vault_stock_units = vault_stock_units + ? WHERE cassette_id = ?', [order.cassette_qty, order.cassette_id]);
    await conn.commit();
    res.json({ message: `Order #${orderId} completed; ${order.cassette_qty} empty cassette(s) returned to the vault.`, order_id: orderId, status: 'COMPLETED' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}));

/* ---------------------------------------------------------------------
 * POST /api/reset   (Central Vault Admin) — restore all 5 tables to seed data
 * Runs in one transaction. Account tables are reset too, so any changed
 * usernames/passwords go back to the defaults and every session is logged out.
 * ------------------------------------------------------------------- */
app.post('/api/reset', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const table of DELETE_ORDER) await conn.query(`DELETE FROM ${table}`);
    const counts = {};
    for (const table of INSERT_ORDER) {
      const { columns, rows } = SEED[table];
      await conn.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ?`, [rows]);
      counts[table] = rows.length;
    }
    await conn.commit();
    sessions.clear();
    res.json({ message: 'All tables reset to the default seed data. Please log in again.', rows: counts });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}));

/* =====================================================================
 * 6. Errors
 * ===================================================================== */
app.use('/api', (req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate value violates a UNIQUE constraint.' });
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ error: 'Foreign key constraint failed.' });
  console.error('[error]', err.code || '', err.message);
  res.status(500).json({ error: 'Database or server error. Check the server console.', code: err.code });
});

/* =====================================================================
 * 7. Start
 * ===================================================================== */
if (require.main === module) {
  if (Object.values(DB_CONFIG).some((v) => String(v).startsWith('<'))) {
    console.warn('⚠  TiDB connection placeholders are not filled in — edit DB_CONFIG in server.js or set TIDB_HOST / TIDB_USER / TIDB_PASSWORD.');
  }
  app.listen(PORT, () => {
    console.log(`KTB ATM Vault DBMS backend → http://localhost:${PORT}`);
    pool.query('SELECT 1')
      .then(() => console.log(`✓ Connected to TiDB Cloud (${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database})`))
      .catch((e) => console.error(`✗ TiDB connection failed: ${e.code || ''} ${e.message}`));
  });
}

module.exports = { app, pool };
