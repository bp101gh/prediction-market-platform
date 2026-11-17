// 首页市场分类与截止时间展示。加载在 app.js 之后，覆盖原 loadContracts。
let marketFilter = 'open';

async function loadContracts() {
  const response = await fetch(API_BASE + '/api/contracts');
  const data = await response.json();
  const grid = document.getElementById('markets-grid');
  const contracts = data.contracts || [];
  const now = Date.now();

  if (!contracts.length) {
    grid.innerHTML = '<div class="text-muted">暂无预测事件，请管理员前往后台创建</div>';
    return;
  }

  grid.innerHTML = contracts.map(contract => {
    const closed = contract.betting_closes_at &&
      new Date(contract.betting_closes_at).getTime() <= now;
    const ended = contract.status === 'ended';
    const yesPrice = contract.last_price !== null
      ? Number(contract.last_price)
      : Number(contract.best_ask || contract.max_price / 2);
    const noPrice = Math.round((Number(contract.max_price) - yesPrice) * 100) / 100;
    const deadlineText = contract.betting_closes_at
      ? new Date(contract.betting_closes_at).toLocaleString()
      : '未设置';
    const category = ended ? 'ended' : 'open';
    const badge = ended ? '已结算'
      : closed ? '投注已截止'
        : contract.status === 'settling' ? '结算中' : '进行中';

    return `
      <div class="market-card" data-market-category="${category}"
           onclick="enterMarket(${Number(contract.id)})">
        <div class="flex-between mb-2">
          <strong>${escapeHTML(contract.name)}</strong>
          <span class="badge ${ended || closed ? 'badge-gray' : 'badge-green'}">${badge}</span>
        </div>
        <p class="text-sm text-muted mb-3">${escapeHTML(contract.description || '点击进入盘口交易')}</p>
        <div class="market-odds">
          <span class="odd-yes">YES ${yesPrice}</span>
          <span class="odd-no">NO ${noPrice}</span>
        </div>
        <div class="text-sm text-muted mt-2">成交量: ${Number(contract.volume || 0)} 份</div>
        <div class="text-sm text-muted mt-1">投注截止: ${escapeHTML(deadlineText)}</div>
      </div>`;
  }).join('');
  applyMarketFilter();
}

function setMarketFilter(filter) {
  marketFilter = filter;
  document.getElementById('tab-markets-open')?.classList.toggle('active', filter === 'open');
  document.getElementById('tab-markets-ended')?.classList.toggle('active', filter === 'ended');
  applyMarketFilter();
}

function applyMarketFilter() {
  document.querySelectorAll('#markets-grid [data-market-category]').forEach(card => {
    card.style.display = card.dataset.marketCategory === marketFilter ? '' : 'none';
  });
}

const originalEnterMarket = enterMarket;
async function enterMarket(id) {
  await originalEnterMarket(id);
  if (!currentContract) return;

  const deadlinePassed = currentContract.betting_closes_at &&
    new Date(currentContract.betting_closes_at).getTime() <= Date.now();
  const closed = currentContract.status !== 'active' || deadlinePassed;
  const status = document.getElementById('contract-status');
  status.textContent = currentContract.status === 'ended'
    ? `已结算 (${String(currentContract.end_result || '').toUpperCase()})`
    : deadlinePassed ? '投注已截止'
      : currentContract.status === 'settling' ? '结算中' : '进行中';
  status.className = `badge ${closed ? 'badge-gray' : 'badge-green'}`;
  const button = document.getElementById('place-order-btn');
  button.disabled = Boolean(closed);
  if (closed) {
    button.textContent = currentContract.status === 'ended' ? '事件已结算' : '投注已截止';
    button.className = 'btn btn-outline btn-block';
  }
  document.querySelectorAll('#section-trade input, #section-trade button').forEach(element => {
    if (element.id === 'place-order-btn') return;
    if (['order-price', 'order-amount'].includes(element.id)) element.disabled = Boolean(closed);
    if (element.getAttribute('onclick')?.includes('doSplit')) element.disabled = Boolean(closed);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('tab-markets-open')?.classList.add('active');
});
