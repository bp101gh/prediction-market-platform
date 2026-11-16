const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 60000;
const MAX_MATCH_LOOPS = 1000;
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{3,20}$/;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function derivePbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  const parts = stored.split('$');

  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    const iterations = Number.parseInt(parts[1], 10);
    const salt = hexToBytes(parts[2]);
    if (!Number.isInteger(iterations) || iterations < 1 || !salt.length) return false;
    return toHex(await derivePbkdf2(password, salt, iterations)) === parts[3];
  }

  const hash = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(password)
  );
  return toHex(new Uint8Array(hash)) === stored;
}

function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function corsHeaders(request, env) {
  const allowed = (env.FRONTEND_ORIGIN || '').trim();
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin':
      allowed ? (origin === allowed ? origin : allowed) : '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    Vary: 'Origin'
  };
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env)
    }
  });
}

async function parseBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function normalizePrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return round2(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

async function getAuthUser(env, request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';
  if (!token) return null;

  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.username, u.balance, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).bind(token).first();

  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return session;
}

async function createSession(env, userId) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')'),
    env.DB.prepare(
      `INSERT INTO sessions (token, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`
    ).bind(token, userId)
  ]);
  return token;
}

function isAdmin(env, user) {
  if (!user) return false;
  if (Number(user.is_admin) === 1) return true;

  const names = String(env.ADMIN_USERNAMES || '')
    .split(',').map(v => v.trim()).filter(Boolean);
  const ids = String(env.ADMIN_USER_IDS || '')
    .split(',').map(v => Number.parseInt(v.trim(), 10)).filter(Number.isInteger);

  return names.includes(user.username) || ids.includes(Number(user.user_id || user.id));
}

function addPosition(stmts, env, contractId, userId, yesDelta, noDelta) {
  stmts.push(
    env.DB.prepare(
      `INSERT INTO positions (contract_id, user_id, long_amount, short_amount)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(contract_id, user_id) DO UPDATE SET
         long_amount = long_amount + excluded.long_amount,
         short_amount = short_amount + excluded.short_amount`
    ).bind(contractId, userId, yesDelta, noDelta)
  );
}

function appendOrderSettlement(stmts, env, order, yesPrice, quantity, maxPrice) {
  const isYes = order.target_asset === 'yes';
  const actualAssetPrice = isYes ? yesPrice : round2(maxPrice - yesPrice);

  if (Number(order.is_close) === 1) {
    const proceeds = round2(actualAssetPrice * quantity);
    if (proceeds > 0) {
      stmts.push(
        env.DB.prepare(
          'UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?'
        ).bind(proceeds, order.user_id)
      );
    }
    return;
  }

  if (isYes) {
    addPosition(stmts, env, order.contract_id, order.user_id, quantity, 0);
  } else {
    addPosition(stmts, env, order.contract_id, order.user_id, 0, quantity);
  }

  const limitAssetPrice = isYes
    ? Number(order.price)
    : round2(maxPrice - Number(order.price));
  const refund = round2((limitAssetPrice - actualAssetPrice) * quantity);

  if (refund > 0) {
    stmts.push(
      env.DB.prepare(
        'UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?'
      ).bind(refund, order.user_id)
    );
  }
}

function restoreOrderAmount(env, orderId, quantity) {
  return env.DB.prepare(
    `UPDATE orders
     SET amount = MIN(amount + ?, original_amount),
         status = CASE
           WHEN MIN(amount + ?, original_amount) >= original_amount THEN 'pending'
           ELSE 'partial'
         END
     WHERE id = ? AND status IN ('partial', 'filled')`
  ).bind(quantity, quantity, orderId).run();
}

function claimOrder(env, orderId, quantity) {
  return env.DB.prepare(
    `UPDATE orders
     SET amount = amount - ?,
         status = CASE WHEN amount - ? <= 0 THEN 'filled' ELSE 'partial' END
     WHERE id = ? AND amount >= ? AND status IN ('pending', 'partial')`
  ).bind(quantity, quantity, orderId, quantity).run();
}

async function matchOrder(env, input) {
  const {
    contract_id, user_id, side, price, amount,
    isClose, targetAsset, max_price, takerOrderId
  } = input;

  let remaining = amount;
  let loops = 0;

  const taker = {
    id: takerOrderId,
    contract_id,
    user_id,
    side,
    price,
    target_asset: targetAsset,
    is_close: isClose ? 1 : 0
  };

  while (remaining > 0 && loops++ < MAX_MATCH_LOOPS) {
    const contract = await env.DB.prepare(
      'SELECT status FROM contracts WHERE id = ?'
    ).bind(contract_id).first();

    if (!contract || contract.status !== 'active') break;

    const opposite = side === 'buy' ? 'sell' : 'buy';
    const comparison = side === 'buy' ? 'price <= ?' : 'price >= ?';
    const ordering = side === 'buy' ? 'price ASC' : 'price DESC';

    const maker = await env.DB.prepare(
      `SELECT * FROM orders
       WHERE contract_id = ?
         AND side = '${opposite}'
         AND status IN ('pending', 'partial')
         AND ${comparison}
         AND user_id != ?
       ORDER BY ${ordering}, created_at ASC, id ASC
       LIMIT 1`
    ).bind(contract_id, price, user_id).first();

    if (!maker) break;

    const quantity = Math.min(remaining, Number(maker.amount));
    const yesPrice = Number(maker.price);

    if (!positiveInteger(quantity) || !Number.isFinite(yesPrice)) break;

    const makerClaim = await claimOrder(env, maker.id, quantity);
    if (makerClaim.meta.changes === 0) continue;

    const takerClaim = await claimOrder(env, takerOrderId, quantity);
    if (takerClaim.meta.changes === 0) {
      await restoreOrderAmount(env, maker.id, quantity);
      break;
    }

    const bookBuyer = side === 'buy' ? taker : maker;
    const bookSeller = side === 'buy' ? maker : taker;

    const statements = [
      env.DB.prepare(
        `INSERT INTO trades
          (contract_id, buyer_id, seller_id, buy_order_id, sell_order_id,
           buy_order_asset, buy_order_is_close,
           sell_order_asset, sell_order_is_close, price, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        contract_id,
        bookBuyer.user_id,
        bookSeller.user_id,
        bookBuyer.id,
        bookSeller.id,
        bookBuyer.target_asset,
        Number(bookBuyer.is_close) || 0,
        bookSeller.target_asset,
        Number(bookSeller.is_close) || 0,
        yesPrice,
        quantity
      )
    ];

    appendOrderSettlement(statements, env, bookBuyer, yesPrice, quantity, Number(max_price));
    appendOrderSettlement(statements, env, bookSeller, yesPrice, quantity, Number(max_price));

    try {
      await env.DB.batch(statements);
    } catch (error) {
      await Promise.all([
        restoreOrderAmount(env, maker.id, quantity),
        restoreOrderAmount(env, takerOrderId, quantity)
      ]);
      throw error;
    }

    remaining -= quantity;
  }

  return { filled: amount - remaining, remaining };
}

async function finalizeTakerOrder(env, orderId, originalAmount, remaining) {
  if (remaining <= 0) {
    await env.DB.prepare(
      `UPDATE orders SET amount = 0, status = 'filled'
       WHERE id = ? AND status IN ('pending', 'partial')`
    ).bind(orderId).run();
  } else {
    await env.DB.prepare(
      `UPDATE orders
       SET status = CASE WHEN amount >= ? THEN 'pending' ELSE 'partial' END
       WHERE id = ? AND status IN ('pending', 'partial')`
    ).bind(originalAmount, orderId).run();
  }
}

async function cancelOrderAndRefund(env, order, maxPrice) {
  const quantity = Number(order.amount) || 0;
  const cancel = env.DB.prepare(
    `UPDATE orders SET status = 'canceled', amount = 0
     WHERE id = ? AND status IN ('pending', 'partial')`
  ).bind(order.id);

  let refund;

  if (order.target_asset === 'yes' && order.side === 'buy') {
    refund = env.DB.prepare(
      `UPDATE users SET balance = ROUND(balance + ?, 2)
       WHERE id = ? AND changes() = 1`
    ).bind(round2(Number(order.price) * quantity), order.user_id);
  } else if (order.target_asset === 'yes' && order.side === 'sell') {
    refund = env.DB.prepare(
      `UPDATE positions SET long_amount = long_amount + ?
       WHERE contract_id = ? AND user_id = ? AND changes() = 1`
    ).bind(quantity, order.contract_id, order.user_id);
  } else if (order.target_asset === 'no' && order.side === 'sell') {
    refund = env.DB.prepare(
      `UPDATE users SET balance = ROUND(balance + ?, 2)
       WHERE id = ? AND changes() = 1`
    ).bind(round2((maxPrice - Number(order.price)) * quantity), order.user_id);
  } else {
    refund = env.DB.prepare(
      `UPDATE positions SET short_amount = short_amount + ?
       WHERE contract_id = ? AND user_id = ? AND changes() = 1`
    ).bind(quantity, order.contract_id, order.user_id);
  }

  const results = await env.DB.batch([cancel, refund]);
  return results[0].meta.changes > 0;
}

async function settleContract(env, contract, result) {
  const lock = await env.DB.prepare(
    `UPDATE contracts
     SET status = 'settling', settlement_result = ?
     WHERE id = ?
       AND ((status = 'active' AND settlement_result IS NULL)
            OR (status = 'settling' AND settlement_result = ?))`
  ).bind(result, contract.id, result).run();

  if (lock.meta.changes === 0) {
    const current = await env.DB.prepare(
      'SELECT status, settlement_result FROM contracts WHERE id = ?'
    ).bind(contract.id).first();

    if (!current) throw new Error('合约不存在');
    if (current.status === 'ended') throw new Error('合约已结束');
    if (current.status === 'settling' && current.settlement_result === result) {
      // same result retry is allowed
    } else {
      throw new Error('合约已按其他结果结算，不能覆盖');
    }
  }

  const lockedContract = await env.DB.prepare(
    'SELECT * FROM contracts WHERE id = ?'
  ).bind(contract.id).first();

  if (!lockedContract || lockedContract.status !== 'settling') {
    throw new Error('结算状态异常');
  }

  if (lockedContract.settlement_result !== result) {
    throw new Error('结算结果不一致');
  }

  const maxPrice = Number(lockedContract.max_price);
  const BATCH_LIMIT = 50;

  for (let round = 0; round < 200; round++) {
    const orders = await env.DB.prepare(
      `SELECT * FROM orders
       WHERE contract_id = ? AND status IN ('pending', 'partial')
       LIMIT ${BATCH_LIMIT}`
    ).bind(contract.id).all();

    if (!orders.results.length) break;
    for (const order of orders.results) {
      await cancelOrderAndRefund(env, order, maxPrice);
    }
  }

  for (let round = 0; round < 200; round++) {
    const positions = await env.DB.prepare(
      `SELECT * FROM positions
       WHERE contract_id = ? AND (long_amount > 0 OR short_amount > 0)
       LIMIT ${BATCH_LIMIT}`
    ).bind(contract.id).all();

    if (!positions.results.length) break;

    const statements = [];

    for (const position of positions.results) {
      const long = Number(position.long_amount);
      const short = Number(position.short_amount);
      const winningShares = result === 'yes' ? long : short;
      const payout = round2(winningShares * maxPrice);

      statements.push(
        env.DB.prepare(
          `UPDATE positions
           SET long_amount = 0, short_amount = 0
           WHERE contract_id = ? AND user_id = ? AND long_amount = ? AND short_amount = ?`
        ).bind(contract.id, position.user_id, long, short)
      );

      if (payout > 0) {
        statements.push(
          env.DB.prepare(
            `UPDATE users SET balance = ROUND(balance + ?, 2)
             WHERE id = ? AND changes() = 1`
          ).bind(payout, position.user_id)
        );
      }
    }

    await env.DB.batch(statements);
  }

  const finalize = await env.DB.prepare(
    `UPDATE contracts
     SET status = 'ended', end_result = ?, ended_at = datetime('now')
     WHERE id = ? AND status = 'settling'`
  ).bind(result, contract.id).run();

  if (finalize.meta.changes === 0) {
    throw new Error('结算最终提交失败');
  }
}

async function checkLoginThrottle(env, username) {
  const row = await env.DB.prepare(
    'SELECT locked_until FROM login_throttle WHERE username = ?'
  ).bind(username).first();

  if (row && row.locked_until &&
      new Date(row.locked_until.replace(' ', 'T') + 'Z').getTime() > Date.now()) {
    return true;
  }
  return false;
}

async function recordLoginFailure(env, username) {
  await env.DB.prepare(
    `INSERT INTO login_throttle (username, fail_count, updated_at)
     VALUES (?, 1, datetime('now'))
     ON CONFLICT(username) DO UPDATE SET
       fail_count = CASE
         WHEN locked_until IS NOT NULL AND locked_until > datetime('now') THEN fail_count
         ELSE fail_count + 1
       END,
       locked_until = CASE
         WHEN fail_count + 1 >= ${LOGIN_MAX_FAILS}
         THEN datetime('now', '+${LOGIN_LOCK_MINUTES} minutes')
         ELSE locked_until
       END,
       updated_at = datetime('now')`
  ).bind(username).run();
}

async function clearLoginThrottle(env, username) {
  await env.DB.prepare('DELETE FROM login_throttle WHERE username = ?')
    .bind(username).run();
}

const routes = {
  'POST /api/auth/register': async (env, request) => {
    const { username, password } = await parseBody(request);

    if (typeof username !== 'string' || typeof password !== 'string' ||
        !USERNAME_RE.test(username) || password.length < 6) {
      return json(request, env, { error: '用户名或密码格式不正确' }, 400);
    }

    const passwordHash = await hashPassword(password);
    let result;

    try {
      result = await env.DB.prepare(
        `INSERT INTO users (username, password_hash, balance, is_admin)
         VALUES (?, ?, 10000, 0)`
      ).bind(username, passwordHash).run();
    } catch (error) {
      if (String(error.message).toLowerCase().includes('unique')) {
        return json(request, env, { error: '用户名已存在' }, 409);
      }
      throw error;
    }

    const userId = result.meta.last_row_id;
    const created = await env.DB.prepare(
      'SELECT is_admin FROM users WHERE id = ?'
    ).bind(userId).first();

    const token = await createSession(env, userId);

    return json(request, env, {
      token,
      user: {
        id: userId,
        username,
        balance: 10000,
        is_admin: Number(created?.is_admin || 0)
      }
    });
  },

  'POST /api/auth/login': async (env, request) => {
    const { username, password } = await parseBody(request);

    if (typeof username !== 'string' || typeof password !== 'string') {
      return json(request, env, { error: '用户名或密码错误' }, 401);
    }

    if (await checkLoginThrottle(env, username)) {
      return json(request, env, {
        error: `失败次数过多，请 ${LOGIN_LOCK_MINUTES} 分钟后再试`
      }, 429);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind(username).first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      await recordLoginFailure(env, username);
      return json(request, env, { error: '用户名或密码错误' }, 401);
    }

    await clearLoginThrottle(env, username);
    const token = await createSession(env, user.id);

    return json(request, env, {
      token,
      user: {
        id: user.id,
        username: user.username,
        balance: user.balance,
        is_admin: isAdmin(env, user) ? 1 : 0
      }
    });
  },

  'POST /api/auth/logout': async (env, request) => {
    const auth = request.headers.get('Authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?')
        .bind(match[1].trim()).run();
    }
    return json(request, env, { success: true });
  },

  'GET /api/auth/me': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    return json(request, env, {
      user: {
        id: user.user_id,
        username: user.username,
        balance: user.balance,
        is_admin: isAdmin(env, user) ? 1 : 0
      }
    });
  },

  'GET /api/contracts': async (env, request) => {
    const result = await env.DB.prepare(
      `SELECT c.*,
         (SELECT price FROM trades WHERE contract_id = c.id
          ORDER BY created_at DESC, id DESC LIMIT 1) AS last_price,
         COALESCE((SELECT SUM(amount) FROM trades WHERE contract_id = c.id), 0) AS volume,
         (SELECT MAX(price) FROM orders
          WHERE contract_id = c.id AND side = 'buy'
          AND status IN ('pending', 'partial')) AS best_bid,
         (SELECT MIN(price) FROM orders
          WHERE contract_id = c.id AND side = 'sell'
          AND status IN ('pending', 'partial')) AS best_ask
       FROM contracts c ORDER BY c.created_at DESC, c.id DESC`
    ).all();

    return json(request, env, { contracts: result.results });
  },

  'GET /api/contracts/:id': async (env, request, params) => {
    const contract = await env.DB.prepare(
      'SELECT * FROM contracts WHERE id = ?'
    ).bind(params.id).first();

    if (!contract) return json(request, env, { error: '合约不存在' }, 404);

    const bids = await env.DB.prepare(
      `SELECT price, SUM(amount) AS total FROM orders
       WHERE contract_id = ? AND side = 'buy'
       AND status IN ('pending', 'partial')
       GROUP BY price ORDER BY price DESC`
    ).bind(params.id).all();

    const asks = await env.DB.prepare(
      `SELECT price, SUM(amount) AS total FROM orders
       WHERE contract_id = ? AND side = 'sell'
       AND status IN ('pending', 'partial')
       GROUP BY price ORDER BY price ASC`
    ).bind(params.id).all();

    const trades = await env.DB.prepare(
      `SELECT * FROM trades WHERE contract_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 20`
    ).bind(params.id).all();

    return json(request, env, {
      contract,
      orderbook: { bids: bids.results, asks: asks.results },
      trades: trades.results
    });
  },

  'POST /api/contracts': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!isAdmin(env, user)) {
      return json(request, env, { error: '需要管理员权限' }, 403);
    }

    const { name, description, max_price } = await parseBody(request);
    const maxPrice = max_price === undefined ? 100 : normalizePrice(max_price);

    if (typeof name !== 'string' || !name.trim() ||
        maxPrice === null || maxPrice <= 0) {
      return json(request, env, { error: '事件名称或面值无效' }, 400);
    }

    const result = await env.DB.prepare(
      `INSERT INTO contracts (name, description, max_price, status)
       VALUES (?, ?, ?, 'active')`
    ).bind(
      name.trim(),
      typeof description === 'string' ? description : '',
      maxPrice
    ).run();

    return json(request, env, {
      id: result.meta.last_row_id,
      name: name.trim(),
      max_price: maxPrice,
      status: 'active'
    });
  },

  'POST /api/contracts/:id/end': async (env, request, params) => {
    const user = await getAuthUser(env, request);
    if (!isAdmin(env, user)) {
      return json(request, env, { error: '需要管理员权限' }, 403);
    }

    const { result } = await parseBody(request);
    if (!['yes', 'no'].includes(result)) {
      return json(request, env, { error: '结果必须是 yes 或 no' }, 400);
    }

    const contract = await env.DB.prepare(
      'SELECT * FROM contracts WHERE id = ?'
    ).bind(params.id).first();

    if (!contract) {
      return json(request, env, { error: '合约不存在' }, 400);
    }

    if (contract.status === 'ended') {
      return json(request, env, { error: '合约已结算完成' }, 400);
    }

    if (contract.status === 'settling' && contract.settlement_result && contract.settlement_result !== result) {
      return json(request, env, { error: '合约已按其他结果结算，不能覆盖' }, 400);
    }

    if (contract.status === 'settling' && contract.settlement_result === result) {
      return json(request, env, {
        success: true,
        message: `已结算为: ${result.toUpperCase()}（重复请求，已幂等返回）`
      });
    }

    await settleContract(env, contract, result);
    return json(request, env, {
      success: true,
      message: `已结算为: ${result.toUpperCase()}`
    });
  },

  'POST /api/orders': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const body = await parseBody(request);
    const { contract_id, price, amount } = body;
    const asset = body.asset;
    const action = body.action;

    if (!Number.isInteger(contract_id) || !positiveInteger(amount) ||
        !['yes', 'no'].includes(asset) || !['buy', 'sell'].includes(action)) {
      return json(request, env, { error: '下单参数无效' }, 400);
    }

    const contract = await env.DB.prepare(
      'SELECT * FROM contracts WHERE id = ?'
    ).bind(contract_id).first();

    if (!contract || contract.status !== 'active') {
      return json(request, env, { error: '合约不存在或已结束' }, 400);
    }

    const frontPrice = normalizePrice(price);
    const maxPrice = Number(contract.max_price);

    if (frontPrice === null || frontPrice <= 0 || frontPrice >= maxPrice) {
      return json(request, env, { error: `价格须在 0 ~ ${maxPrice} 之间` }, 400);
    }

    let side;
    let storedPrice;
    let isClose;

    if (asset === 'yes' && action === 'buy') {
      side = 'buy'; storedPrice = frontPrice; isClose = 0;
    } else if (asset === 'yes' && action === 'sell') {
      side = 'sell'; storedPrice = frontPrice; isClose = 1;
    } else if (asset === 'no' && action === 'buy') {
      side = 'sell'; storedPrice = round2(maxPrice - frontPrice); isClose = 0;
    } else {
      side = 'buy'; storedPrice = round2(maxPrice - frontPrice); isClose = 1;
    }

    if (isClose === 0) {
      const cost = round2(frontPrice * amount);
      const debit = await env.DB.prepare(
        `UPDATE users SET balance = ROUND(balance - ?, 2)
         WHERE id = ? AND balance >= ?`
      ).bind(cost, user.user_id, cost).run();

      if (debit.meta.changes === 0) {
        return json(request, env, { error: `余额不足，需要 ${cost}` }, 400);
      }
    } else {
      const column = asset === 'yes' ? 'long_amount' : 'short_amount';
      const reserve = await env.DB.prepare(
        `UPDATE positions SET ${column} = ${column} - ?
         WHERE contract_id = ? AND user_id = ? AND ${column} >= ?`
      ).bind(amount, contract_id, user.user_id, amount).run();

      if (reserve.meta.changes === 0) {
        return json(request, env, { error: `${asset.toUpperCase()} 持仓不足` }, 400);
      }
    }

    let inserted;

    try {
      inserted = await env.DB.prepare(
        `INSERT INTO orders
          (contract_id, user_id, side, price, amount, original_amount,
           is_close, target_asset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        contract_id, user.user_id, side, storedPrice, amount, amount,
        isClose, asset
      ).run();
    } catch (error) {
      if (isClose === 0) {
        await env.DB.prepare(
          'UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?'
        ).bind(round2(frontPrice * amount), user.user_id).run();
      } else {
        const column = asset === 'yes' ? 'long_amount' : 'short_amount';
        await env.DB.prepare(
          `UPDATE positions SET ${column} = ${column} + ?
           WHERE contract_id = ? AND user_id = ?`
        ).bind(amount, contract_id, user.user_id).run();
      }
      throw error;
    }

    const match = await matchOrder(env, {
      contract_id,
      user_id: user.user_id,
      side,
      price: storedPrice,
      amount,
      isClose,
      targetAsset: asset,
      max_price: maxPrice,
      takerOrderId: inserted.meta.last_row_id
    });

    await finalizeTakerOrder(env, inserted.meta.last_row_id, amount, match.remaining);

    return json(request, env, {
      success: true,
      filled: match.filled,
      remaining: match.remaining
    });
  },

  'DELETE /api/orders/:id': async (env, request, params) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const order = await env.DB.prepare(
      `SELECT o.*, c.status AS contract_status, c.max_price
       FROM orders o JOIN contracts c ON c.id = o.contract_id
       WHERE o.id = ?`
    ).bind(params.id).first();

    if (!order || Number(order.user_id) !== Number(user.user_id) ||
        !['pending', 'partial'].includes(order.status)) {
      return json(request, env, { error: '订单不存在或已完成' }, 400);
    }

    if (order.contract_status === 'settling') {
      return json(request, env, { error: '合约结算中，请稍候再试' }, 409);
    }

    const canceled = await cancelOrderAndRefund(env, order, Number(order.max_price || 100));

    if (!canceled) {
      return json(request, env, { error: '订单状态已变化' }, 409);
    }

    return json(request, env, { success: true });
  },

  'POST /api/positions/split': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const { contract_id, amount } = await parseBody(request);
    if (!Number.isInteger(contract_id) || !positiveInteger(amount)) {
      return json(request, env, { error: '参数无效' }, 400);
    }

    const contract = await env.DB.prepare(
      'SELECT * FROM contracts WHERE id = ? AND status = ?'
    ).bind(contract_id, 'active').first();

    if (!contract) return json(request, env, { error: '合约不存在或已结束' }, 400);

    const cost = round2(Number(contract.max_price) * amount);
    const debit = await env.DB.prepare(
      `UPDATE users SET balance = ROUND(balance - ?, 2)
       WHERE id = ? AND balance >= ?`
    ).bind(cost, user.user_id, cost).run();

    if (debit.meta.changes === 0) {
      return json(request, env, { error: `余额不足，需要 ${cost}` }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO positions (contract_id, user_id, long_amount, short_amount)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(contract_id, user_id) DO UPDATE SET
         long_amount = long_amount + excluded.long_amount,
         short_amount = short_amount + excluded.short_amount`
    ).bind(contract_id, user.user_id, amount, amount).run();

    return json(request, env, { success: true });
  },

  'POST /api/positions/merge': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const { contract_id, amount } = await parseBody(request);
    if (!Number.isInteger(contract_id) || !positiveInteger(amount)) {
      return json(request, env, { error: '参数无效' }, 400);
    }

    const contract = await env.DB.prepare(
      'SELECT * FROM contracts WHERE id = ? AND status = ?'
    ).bind(contract_id, 'active').first();

    if (!contract) {
      return json(request, env, { error: '合约不存在或当前状态不可合并' }, 400);
    }

    const merge = await env.DB.prepare(
      `UPDATE positions
       SET long_amount = long_amount - ?, short_amount = short_amount - ?
       WHERE contract_id = ? AND user_id = ?
         AND long_amount >= ? AND short_amount >= ?`
    ).bind(amount, amount, contract_id, user.user_id, amount, amount).run();

    if (merge.meta.changes === 0) {
      return json(request, env, { error: 'YES/NO 成套持仓不足' }, 400);
    }

    await env.DB.prepare(
      'UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?'
    ).bind(round2(Number(contract.max_price) * amount), user.user_id).run();

    return json(request, env, { success: true });
  },

  'GET /api/positions': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const result = await env.DB.prepare(
      `SELECT p.*, c.name AS contract_name, c.max_price,
              c.status AS contract_status, c.end_result
       FROM positions p JOIN contracts c ON c.id = p.contract_id
       WHERE p.user_id = ? AND (p.long_amount > 0 OR p.short_amount > 0)`
    ).bind(user.user_id).all();

    return json(request, env, { positions: result.results });
  },

  'GET /api/orders/my': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const result = await env.DB.prepare(
      `SELECT o.*, c.name AS contract_name, c.max_price
       FROM orders o JOIN contracts c ON c.id = o.contract_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100`
    ).bind(user.user_id).all();

    return json(request, env, { orders: result.results });
  },

  'GET /api/trades/my': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!user) return json(request, env, { error: '未登录' }, 401);

    const result = await env.DB.prepare(
      `SELECT t.*, c.name AS contract_name, c.max_price, c.end_result
       FROM trades t JOIN contracts c ON c.id = t.contract_id
       WHERE t.buyer_id = ? OR t.seller_id = ?
       ORDER BY t.id DESC LIMIT 100`
    ).bind(user.user_id, user.user_id).all();

    return json(request, env, { trades: result.results });
  },

  'GET /api/admin/users': async (env, request) => {
    const user = await getAuthUser(env, request);
    if (!isAdmin(env, user)) {
      return json(request, env, { error: '无管理员权限' }, 403);
    }

    const result = await env.DB.prepare(
      `SELECT id, username, balance, is_admin, created_at
       FROM users ORDER BY id`
    ).all();

    return json(request, env, { users: result.results });
  },

  'POST /api/admin/users/:id/balance': async (env, request, params) => {
    const admin = await getAuthUser(env, request);
    if (!isAdmin(env, admin)) {
      return json(request, env, { error: '无管理员权限' }, 403);
    }

    const targetId = Number(params.id);
    const { amount, reason, idempotency_key } = await parseBody(request);
    const delta = typeof amount === 'number' ? round2(amount) : NaN;
    const auditReason = typeof reason === 'string' ? reason.trim() : '';
    const key = typeof idempotency_key === 'string' && idempotency_key.trim()
      ? idempotency_key.trim()
      : null;

    if (!Number.isInteger(targetId) || targetId <= 0 ||
        !Number.isFinite(delta) || delta === 0 ||
        !auditReason || auditReason.length > 300) {
      return json(request, env, {
        error: '用户、调整数量或调整原因无效'
      }, 400);
    }

    if (key) {
      const existing = await env.DB.prepare(
        'SELECT id FROM balance_ledger WHERE idempotency_key = ?'
      ).bind(key).first();

      if (existing) return json(request, env, { success: true });
    }

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
         SET balance = ROUND(balance + ?, 2)
         WHERE id = ? AND balance + ? >= 0`
      ).bind(delta, targetId, delta),

      env.DB.prepare(
        `INSERT INTO balance_ledger
           (user_id, delta, balance_after, reason,
            reference_type, reference_id, idempotency_key)
         SELECT id, ?, balance, ?, 'admin_adjust', ?, ?
         FROM users
         WHERE id = ? AND changes() = 1`
      ).bind(delta, auditReason, String(admin.user_id), key, targetId),

      env.DB.prepare(
        `INSERT INTO admin_audit
           (admin_user_id, action, target_user_id, amount,
            balance_before, balance_after, reason)
         SELECT ?, 'balance_adjust', id, ?, ROUND(balance - ?, 2),
                balance, ?
         FROM users
         WHERE id = ? AND changes() = 1`
      ).bind(admin.user_id, delta, delta, auditReason, targetId)
    ]);

    if (!results[0]?.meta?.changes) {
      return json(request, env, {
        error: '用户不存在，或扣减后余额不能低于 0'
      }, 400);
    }

    return json(request, env, { success: true });
  },

  'GET /api/admin/audit': async (env, request) => {
    const admin = await getAuthUser(env, request);
    if (!isAdmin(env, admin)) {
      return json(request, env, { error: '无管理员权限' }, 403);
    }

    const result = await env.DB.prepare(
      `SELECT a.*, au.username AS admin_username,
              tu.username AS target_username
       FROM admin_audit a
       LEFT JOIN users au ON au.id = a.admin_user_id
       LEFT JOIN users tu ON tu.id = a.target_user_id
       ORDER BY a.id DESC LIMIT 100`
    ).all();

    return json(request, env, { audit: result.results });
  }
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env)
      });
    }

    const url = new URL(request.url);

    for (const [route, handler] of Object.entries(routes)) {
      const [method, routePath] = route.split(' ');
      if (request.method !== method) continue;

      const routeParts = routePath.split('/');
      const pathParts = url.pathname.split('/');
      if (routeParts.length !== pathParts.length) continue;

      const params = {};
      let matched = true;

      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          params[routeParts[i].slice(1)] = safeDecode(pathParts[i]);
        } else if (routeParts[i] !== pathParts[i]) {
          matched = false;
          break;
        }
      }

      if (!matched) continue;

      try {
        return await handler(env, request, params);
      } catch (error) {
        console.error('Worker request failed:', error);
        return json(request, env, { error: '服务器内部错误' }, 500);
      }
    }

    return json(request, env, { error: 'Not Found' }, 404);
  }
};
