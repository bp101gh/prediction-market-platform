import baseWorker from './worker.js';

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      Vary: 'Origin'
    }
  });
}

function isExpired(closesAt) {
  return Boolean(closesAt) && new Date(closesAt).getTime() <= Date.now();
}

function validFutureIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

async function readJson(response) {
  try { return await response.clone().json(); } catch { return {}; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return baseWorker.fetch(request, env, ctx);

    // Create market and persist its UTC cutoff. The base worker still performs
    // authentication and admin authorization before the deadline is written.
    if (request.method === 'POST' && url.pathname === '/api/contracts') {
      let body;
      try { body = await request.clone().json(); } catch { body = {}; }
      if (!validFutureIso(body.betting_closes_at)) {
        return json(request, { error: '请设置有效且晚于当前时间的投注截止时间' }, 400);
      }

      const forwarded = { ...body };
      delete forwarded.betting_closes_at;
      const headers = new Headers(request.headers);
      headers.set('Content-Type', 'application/json');
      const response = await baseWorker.fetch(new Request(request.url, {
        method: 'POST', headers, body: JSON.stringify(forwarded)
      }), env, ctx);

      if (!response.ok) return response;
      const result = await readJson(response);
      const saved = await env.DB.prepare(
        `UPDATE contracts SET betting_closes_at = ?
         WHERE id = ? AND status = 'active'`
      ).bind(body.betting_closes_at, result.id).run();

      if (!saved.meta?.changes) {
        console.error('Could not persist betting deadline for contract', result.id);
        return json(request, { error: '事件已创建，但截止时间保存失败，请联系管理员' }, 500);
      }
      return response;
    }

    // Enforce deadline on the server, not just in the browser.
    const orderPath = request.method === 'POST' && url.pathname === '/api/orders';
    const splitPath = request.method === 'POST' && url.pathname === '/api/positions/split';
    if (orderPath || splitPath) {
      let body;
      try { body = await request.clone().json(); } catch { body = {}; }
      const contract = await env.DB.prepare(
        'SELECT status, betting_closes_at FROM contracts WHERE id = ?'
      ).bind(body.contract_id).first();
      if (!contract || contract.status !== 'active') {
        return json(request, { error: '合约不存在或已结束' }, 400);
      }
      if (isExpired(contract.betting_closes_at)) {
        return json(request, { error: '该事件已截止投注，不能再操作' }, 400);
      }
    }

    // Do not settle an event before its betting window has ended. Legacy rows
    // with NULL deadline remain settleable for backward compatibility.
    const settleMatch = request.method === 'POST'
      ? url.pathname.match(/^\/api\/contracts\/([^/]+)\/end$/)
      : null;
    if (settleMatch) {
      const contract = await env.DB.prepare(
        'SELECT status, betting_closes_at FROM contracts WHERE id = ?'
      ).bind(decodeURIComponent(settleMatch[1])).first();
      if (contract?.status === 'active' && contract.betting_closes_at &&
          !isExpired(contract.betting_closes_at)) {
        return json(request, { error: '投注截止时间未到，暂不能结算' }, 400);
      }
    }

    return baseWorker.fetch(request, env, ctx);
  }
};
