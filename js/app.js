const API_BASE = '';

let token = localStorage.getItem('token');
let currentContract = null;
let currentOrderbook = { bids: [], asks: [] };
let tradeAction = 'buy';
let tradeAsset = 'yes';
let currentUserId = null;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>\"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function init() {
  if (!token) {
    location.href = '/login.html';
    return;
  }

  try {
    const response = await fetch(API_BASE + '/api/auth/me', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await response.json();

    if (!data.user) {
      logout();
      return;
    }

    currentUserId = data.user.id;
    document.getElementById('user-name').textContent = data.user.username;
    document.getElementById('user-balance').textContent =
      Number(data.user.balance).toFixed(2);

    if (Number(data.user.is_admin) === 1) {
      document.getElementById('admin-link').style.display = 'block';
    }

    await loadContracts();
  } catch (error) {
    console.error('初始化失败:', error);
  }
}

function showSection(name) {
  ['markets', 'trade', 'positions', 'orders', 'history'].forEach(section => {
    const element = document.getElementById(`section-${section}`);
    if (element) element.style.display = section === name ? 'block' : 'none';
  });

  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    link.classList.remove('active');
  });

  const navKey = name === 'trade' ? 'markets' : name;
  document.getElementById(`nav-${navKey}`)?.classList.add('active');

  if (name === 'positions') loadPositionsList();
  if (name === 'orders') loadOrdersList();
  if (name === 'history') loadHistoryList();
}

async function loadContracts() {
  const response = await fetch(API_BASE + '/api/contracts');
  const data = await response.json();
  const grid = document.getElementById('markets-grid');

  if (!data.contracts?.length) {
    grid.innerHTML = '<div class="text-muted">暂无预测事件，请管理员前往后台创建</div>';
    return;
  }

  grid.innerHTML = data.contracts.map(contract => {
    const yesPrice = contract.last_price !== null
      ? Number(contract.last_price)
      : Number(contract.best_ask || contract.max_price / 2);
    const noPrice = Math.round((contract.max_price - yesPrice) * 100) / 100;

    return `
      <div class="market-card" onclick="enterMarket(${Number(contract.id)})">
        <div class="flex-between mb-2">
          <strong>${escapeHTML(contract.name)}</strong>
          <span class="badge ${contract.status === 'active' ? 'badge-green' : 'badge-gray'}">
            ${contract.status === 'active' ? '进行中' : '已结束'}
          </span>
        </div>
        <p class="text-sm text-muted mb-3">
          ${escapeHTML(contract.description || '点击进入盘口交易')}
        </p>
        <div class="market-odds">
          <span class="odd-yes">YES ${yesPrice}</span>
          <span class="odd-no">NO ${noPrice}</span>
        </div>
        <div class="text-sm text-muted mt-2">成交量: ${Number(contract.volume || 0)} 份</div>
      </div>
    `;
  }).join('');
}

async function enterMarket(id) {
  showSection('trade');

  const response = await fetch(API_BASE + `/api/contracts/${id}`);
  const data = await response.json();

  if (!response.ok) {
    alert(data.error || '加载失败');
    showSection('markets');
    return;
  }

  currentContract = data.contract;
  currentOrderbook = data.orderbook || { bids: [], asks: [] };

  document.getElementById('contract-name').textContent = currentContract.name;
  document.getElementById('contract-desc').textContent = currentContract.description || '';
  document.getElementById('contract-max-price').textContent = currentContract.max_price;
  document.getElementById('contract-status').textContent =
    currentContract.status === 'active'
      ? '进行中'
      : `已结算 (${String(currentContract.end_result || '').toUpperCase()})`;

  renderOrderbook();
  updateTradeUI();
  await Promise.all([
    loadMyPositionsForContract(id),
    loadMyOrdersForContract(id)
  ]);
}

function renderOrderbook() {
  if (!currentContract) return;

  const maxPrice = Number(currentContract.max_price);
  const rawBids = currentOrderbook.bids || [];
  const rawAsks = currentOrderbook.asks || [];

  let displayBids;
  let displayAsks;

  if (tradeAsset === 'yes') {
    document.getElementById('ob-asset-label').textContent = 'YES 视角';
    document.getElementById('ob-asset-label').className = 'text-green';
    displayBids = rawBids.map(row => ({ price: Number(row.price), total: row.total }));
    displayAsks = rawAsks.map(row => ({ price: Number(row.price), total: row.total }));
  } else {
    document.getElementById('ob-asset-label').textContent = 'NO 视角';
    document.getElementById('ob-asset-label').className = 'text-red';

    displayBids = rawAsks.map(row => ({
      price: Math.round((maxPrice - Number(row.price)) * 100) / 100,
      total: row.total
    })).sort((a, b) => b.price - a.price);

    displayAsks = rawBids.map(row => ({
      price: Math.round((maxPrice - Number(row.price)) * 100) / 100,
      total: row.total
    })).sort((a, b) => a.price - b.price);
  }

  const yesAsk = rawAsks.length ? Number(rawAsks[0].price) : maxPrice / 2;
  const noAsk = rawBids.length ? Math.round((maxPrice - Number(rawBids[0].price)) * 100) / 100 : maxPrice / 2;

  document.getElementById('yes-ref-price').textContent = yesAsk;
  document.getElementById('no-ref-price').textContent = noAsk;

  document.getElementById('orderbook-asks').innerHTML = displayAsks.length
    ? displayAsks.slice().reverse().map(row => `
        <div class="ob-row ask" onclick="setPrice(${row.price})">
          <span>${row.price}</span><span>${row.total}</span>
        </div>`).join('')
    : '<div class="text-center text-muted text-sm py-2">暂无卖盘</div>';

  document.getElementById('orderbook-bids').innerHTML = displayBids.length
    ? displayBids.map(row => `
        <div class="ob-row bid" onclick="setPrice(${row.price})">
          <span>${row.price}</span><span>${row.total}</span>
        </div>`).join('')
    : '<div class="text-center text-muted text-sm py-2">暂无买盘</div>';

  const bestBid = displayBids.length ? displayBids[0].price : '-';
  const bestAsk = displayAsks.length ? displayAsks[0].price : '-';
  document.getElementById('orderbook-spread').textContent = `买一: ${bestBid} | 卖一: ${bestAsk}`;
}

function setPrice(price) {
  document.getElementById('order-price').value = price;
  updateOrderSummary();
}

function setTradeAction(action) {
  tradeAction = action;
  document.getElementById('tab-action-buy').classList.toggle('active', action === 'buy');
  document.getElementById('tab-action-sell').classList.toggle('active', action === 'sell');
  updateTradeUI();
}

function setTradeAsset(asset) {
  tradeAsset = asset;
  document.getElementById('btn-outcome-yes').classList.toggle('active', asset === 'yes');
  document.getElementById('btn-outcome-no').classList.toggle('active', asset === 'no');
  renderOrderbook();
  updateTradeUI();
}

function updateTradeUI() {
  const actionText = tradeAction === 'buy' ? '买入' : '卖出';
  const assetText = tradeAsset.toUpperCase();

  document.getElementById('price-label').textContent = `${actionText} ${assetText} 单价`;

  const button = document.getElementById('place-order-btn');
  button.textContent = `${actionText} ${assetText}`;
  button.className = tradeAsset === 'yes' ? 'btn btn-green btn-block' : 'btn btn-red btn-block';

  document.getElementById('summary-cost-label').textContent = tradeAction === 'buy' ? '预计支付现金:' : '预计回笼现金:';

  updateOrderSummary();
}

function updateOrderSummary() {
  if (!currentContract) return;

  const price = Number(document.getElementById('order-price').value) || 0;
  const amount = Number.parseInt(document.getElementById('order-amount').value, 10) || 0;

  const total = Math.round(price * amount * 100) / 100;
  const payout = Math.round(Number(currentContract.max_price) * amount * 100) / 100;

  document.getElementById('summary-cost-val').textContent = total.toFixed(2);
  document.getElementById('summary-payout-val').textContent = tradeAction === 'buy' ? payout.toFixed(2) : '-';
}

async function refreshBalance() {
  const response = await fetch(API_BASE + '/api/auth/me', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();

  if (data.user) {
    document.getElementById('user-balance').textContent = Number(data.user.balance).toFixed(2);
  }
}

async function placeOrder() {
  if (!currentContract) return;

  const price = Number(document.getElementById('order-price').value);
  const amount = Number(document.getElementById('order-amount').value);

  if (!Number.isFinite(price) || price <= 0 ||
      !Number.isInteger(amount) || amount <= 0) {
    alert('请输入有效单价和正整数数量');
    return;
  }

  const response = await fetch(API_BASE + '/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({
      contract_id: Number(currentContract.id),
      asset: tradeAsset,
      action: tradeAction,
      price,
      amount
    })
  });

  const data = await response.json();

  if (!response.ok) {
    alert(data.error || '下单失败');
    return;
  }

  alert(`委托成功！立即成交 ${data.filled} 份，剩余挂单 ${data.remaining} 份`);
  document.getElementById('order-amount').value = '';

  await refreshBalance();
  updateOrderSummary();
  await enterMarket(currentContract.id);
}

async function doSplit() {
  if (!currentContract) return;

  const amount = Number.parseInt(document.getElementById('split-amount').value, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    alert('请输入有效套数');
    return;
  }

  const response = await fetch(API_BASE + '/api/positions/split', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({ contract_id: Number(currentContract.id), amount })
  });

  const data = await response.json();
  alert(data.error || '拆分成功');

  if (response.ok) {
    await refreshBalance();
    await enterMarket(currentContract.id);
  }
}

async function doMerge() {
  if (!currentContract) return;

  const amount = Number.parseInt(document.getElementById('split-amount').value, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    alert('请输入有效套数');
    return;
  }

  const response = await fetch(API_BASE + '/api/positions/merge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify({ contract_id: Number(currentContract.id), amount })
  });

  const data = await response.json();
  alert(data.error || '合并成功');

  if (response.ok) {
    await refreshBalance();
    await enterMarket(currentContract.id);
  }
}

async function loadMyPositionsForContract(contractId) {
  const response = await fetch(API_BASE + '/api/positions', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();
  const position = (data.positions || []).find(
    item => Number(item.contract_id) === Number(contractId)
  );
  const element = document.getElementById('my-position');

  element.innerHTML = position
    ? `<div class="flex-between">
         <span>YES 现货: <strong class="text-green">${Number(position.long_amount)} 份</strong></span>
         <span>NO 现货: <strong class="text-red">${Number(position.short_amount)} 份</strong></span>
       </div>`
    : '<span class="text-muted">当前事件暂无持仓</span>';
}

async function loadMyOrdersForContract(contractId) {
  const response = await fetch(API_BASE + '/api/orders/my', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();
  const orders = (data.orders || []).filter(order =>
    Number(order.contract_id) === Number(contractId) &&
    ['pending', 'partial'].includes(order.status)
  );

  const element = document.getElementById('my-market-orders');
  if (!element) return;

  if (!orders.length) {
    element.innerHTML = '<span class="text-muted">暂无未成交挂单</span>';
    return;
  }

  element.innerHTML = `
    <table class="table" style="min-width:100%">
      <thead><tr><th>方向</th><th>单价</th><th>数量</th><th>操作</th></tr></thead>
      <tbody>
        ${orders.map(order => {
          const asset = order.target_asset === 'yes' ? 'YES' : 'NO';
          const isBuy = Number(order.is_close) === 0;
          const shownPrice = order.target_asset === 'yes'
            ? Number(order.price)
            : Number(order.max_price) - Number(order.price);

          return `<tr>
            <td>${isBuy ? '买入' : '卖出'} ${asset}</td>
            <td>${shownPrice.toFixed(2)}</td>
            <td>${Number(order.amount)}</td>
            <td><button class="btn btn-outline btn-sm"
              onclick="cancelOrder(${Number(order.id)}, ${Number(contractId)})">撤单</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function loadPositionsList() {
  const response = await fetch(API_BASE + '/api/positions', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();

  document.getElementById('positions-list').innerHTML =
    (data.positions || []).map(position => `
      <tr>
        <td>${escapeHTML(position.contract_name)}</td>
        <td class="text-green"><strong>${Number(position.long_amount)}</strong></td>
        <td class="text-red"><strong>${Number(position.short_amount)}</strong></td>
        <td>${Number(position.max_price).toFixed(2)}</td>
        <td>${position.contract_status === 'active'
          ? '进行中'
          : `已结算 (${escapeHTML(position.end_result || '')})`}</td>
      </tr>
    `).join('') ||
    '<tr><td colspan="5" class="text-center text-muted">暂无现货持仓</td></tr>';
}

async function loadOrdersList() {
  const response = await fetch(API_BASE + '/api/orders/my', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();

  document.getElementById('orders-list').innerHTML =
    (data.orders || []).map(order => {
      const asset = order.target_asset === 'yes' ? 'YES' : 'NO';
      const label = Number(order.is_close) === 1 ? '卖出' : '买入';
      const shownPrice = order.target_asset === 'yes'
        ? Number(order.price)
        : Number(order.max_price) - Number(order.price);

      return `<tr>
        <td>${escapeHTML(order.contract_name)}</td>
        <td><strong>${label} ${asset}</strong></td>
        <td>${shownPrice.toFixed(2)}</td>
        <td>${Number(order.amount)}</td>
        <td>${['pending', 'partial'].includes(order.status)
          ? `<button class="btn btn-outline btn-sm"
               onclick="cancelOrder(${Number(order.id)})">撤单</button>`
          : escapeHTML(order.status)}</td>
      </tr>`;
    }).join('') ||
    '<tr><td colspan="5" class="text-center text-muted">暂无委托挂单</td></tr>';
}

async function cancelOrder(id, contractId) {
  if (!confirm('确定撤销此挂单吗？')) return;

  const response = await fetch(API_BASE + `/api/orders/${id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json();

  if (!response.ok) {
    alert(data.error || '撤单失败');
    return;
  }

  await refreshBalance();

  if (contractId) {
    await enterMarket(contractId);
  } else {
    await loadOrdersList();
  }
}

async function loadHistoryList() {
  const response = await fetch(API_BASE + '/api/trades/my', {
    headers: { Authorization: 'Bearer ' + token }
  });

  const data = await response.json();

  if (!response.ok) {
    document.getElementById('trades-list').textContent = data.error || '成交记录加载失败';
    return;
  }

  const trades = data.trades || [];
  const container = document.getElementById('trades-list');

  if (!trades.length) {
    container.innerHTML = '<div class="text-center text-muted">暂无成交记录</div>';
    return;
  }

  container.innerHTML = trades.map(trade => {
    const isBookBuyer = Number(trade.buyer_id) === Number(currentUserId);
    const asset = isBookBuyer ? trade.buy_order_asset : trade.sell_order_asset;
    const isClose = Number(isBookBuyer ? trade.buy_order_is_close : trade.sell_order_is_close) === 1;

    const assetName = asset === 'no' ? 'NO' : 'YES';
    const action = isClose ? '卖出' : '买入';
    const openClose = isClose ? '平仓' : '开仓';
    const maxPrice = Number(trade.max_price);
    const ownPrice = asset === 'yes'
      ? Number(trade.price)
      : Math.round((maxPrice - Number(trade.price)) * 100) / 100;

    return `
      <div class="card mb-2" style="padding:12px">
        <div class="flex-between">
          <strong>${escapeHTML(trade.contract_name)}</strong>
          <span>
            己方成交价: <strong>${ownPrice.toFixed(2)}</strong>
            | 数量: <strong>${Number(trade.amount)}</strong>
            ${trade.end_result ? `| 结果: <strong>${String(trade.end_result).toUpperCase()}</strong>` : ''}
          </span>
        </div>
        <div class="text-sm text-muted mt-1">
          本人操作：${action} ${assetName}（${openClose}）
          | YES 基准价: ${Number(trade.price).toFixed(2)}
        </div>
        <div class="text-sm text-muted mt-1">
          ${escapeHTML(trade.created_at)}
        </div>
      </div>
    `;
  }).join('');
}

async function logout() {
  try {
    await fetch(API_BASE + '/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    });
  } catch (error) {
    console.error('退出请求失败:', error);
  }

  localStorage.removeItem('token');
  location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', init);
