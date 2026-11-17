// Admin-page additions for the betting cutoff. Loaded after admin.html's inline script.
const originalAdminLoad = loadAdminData;

async function loadAdminData() {
  await originalAdminLoad();
  const response = await api('/api/contracts');
  const data = await response.json();
  const rows = [...document.querySelectorAll('#admin-contracts tr')];
  const contracts = data.contracts || [];
  rows.forEach((row, index) => {
    const contract = contracts[index];
    if (!contract) return;
    const cell = row.insertCell(3);
    cell.textContent = contract.betting_closes_at
      ? new Date(contract.betting_closes_at).toLocaleString()
      : '未设置';
  });
}

async function createContract() {
  const name = document.getElementById('c-name').value.trim();
  const description = document.getElementById('c-desc').value.trim();
  const max_price = Number(document.getElementById('c-max').value);
  const input = document.getElementById('c-deadline');
  const localValue = input.value;
  const betting_closes_at = localValue ? new Date(localValue).toISOString() : '';

  if (!name || !Number.isFinite(max_price) || max_price <= 0 || !localValue ||
      !Number.isFinite(Date.parse(betting_closes_at)) || Date.parse(betting_closes_at) <= Date.now()) {
    alert('请填写事件名称、有效面值以及晚于当前时间的投注截止时间');
    input.focus();
    return;
  }

  const response = await api('/api/contracts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, max_price, betting_closes_at })
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || '创建失败');
    return;
  }

  document.getElementById('c-name').value = '';
  document.getElementById('c-desc').value = '';
  document.getElementById('c-max').value = '100';
  input.value = '';
  await loadAdminData();
}
