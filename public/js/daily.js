// 「何買ったっけ？」日別ビュー: カレンダー + カテゴリ別円グラフ + 明細一覧
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmtYen = (n) => '¥' + Number(n).toLocaleString();
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const MAX_SLOTS = 8; // カテゴリ色の固定スロット数（超過分は「その他」に集約）

  let categoryOrder = [];        // マスター順のカテゴリ名（色割当の基準・全日で固定）
  let viewYear, viewMonth;       // 表示中の月（1-12）
  let selectedDate = null;       // 'YYYY-MM-DD'
  let totalsByDay = {};          // { 'YYYY-MM-DD': {total, count} }

  // カテゴリ→色スロット（マスター順で固定割当。順位や日によって変えない）
  function slotOf(category) {
    const idx = categoryOrder.indexOf(category);
    return idx >= 0 && idx < MAX_SLOTS ? idx + 1 : 'other';
  }

  function colorVar(slot) {
    return slot === 'other' ? 'var(--series-other)' : `var(--series-${slot})`;
  }

  // ---------- カレンダー ----------
  async function loadMonth() {
    const yearMonth = `${viewYear}-${pad2(viewMonth)}`;
    $('calTitle').textContent = `${viewYear}年${viewMonth}月`;
    try {
      const res = await fetch(`/api/daily-totals?yearMonth=${yearMonth}`);
      const data = res.ok ? await res.json() : { days: [] };
      totalsByDay = {};
      data.days.forEach((d) => { totalsByDay[d.day] = d; });
    } catch {
      totalsByDay = {};
    }
    renderCalendar();
  }

  function renderCalendar() {
    const cal = $('calendar');
    cal.innerHTML = '';

    WEEKDAYS.forEach((w, i) => {
      const h = document.createElement('div');
      h.className = 'cal-weekday' + (i === 0 ? ' cal-sun' : i === 6 ? ' cal-sat' : '');
      h.textContent = w;
      cal.appendChild(h);
    });

    const firstDow = new Date(viewYear, viewMonth - 1, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement('div');
      blank.className = 'cal-day cal-blank';
      cal.appendChild(blank);
    }

    const today = new Date();
    const todayIso = isoDate(today.getFullYear(), today.getMonth() + 1, today.getDate());

    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoDate(viewYear, viewMonth, d);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      if (iso === todayIso) cell.classList.add('cal-today');
      if (iso === selectedDate) cell.classList.add('cal-selected');

      const num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = d;
      cell.appendChild(num);

      const info = totalsByDay[iso];
      if (info) {
        cell.classList.add('cal-has-data');
        const total = document.createElement('span');
        total.className = 'cal-day-total';
        total.textContent = fmtYen(info.total);
        cell.appendChild(total);
      }

      cell.addEventListener('click', () => selectDate(iso));
      cal.appendChild(cell);
    }
  }

  // ---------- 日別詳細 ----------
  async function selectDate(iso) {
    selectedDate = iso;
    history.replaceState(null, '', `/daily?date=${iso}`);
    renderCalendar();

    let records = [];
    try {
      const res = await fetch(`/api/records?date=${iso}`);
      const data = res.ok ? await res.json() : { records: [] };
      records = data.records;
    } catch {
      records = [];
    }

    const [y, m, d] = iso.split('-').map(Number);
    const dow = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    $('dayDetailTitle').textContent = `📅 ${y}年${m}月${d}日（${dow}）の買い物`;

    if (records.length === 0) {
      $('dayDetail').hidden = true;
      $('dayEmpty').hidden = false;
      return;
    }
    $('dayEmpty').hidden = true;
    $('dayDetail').hidden = false;

    // カテゴリ別に集計し、色スロットの固定順（マスター順→その他）で並べる
    const byCategory = new Map();
    let total = 0;
    records.forEach((r) => {
      const amount = Number(r.amount);
      total += amount;
      byCategory.set(r.category, (byCategory.get(r.category) || 0) + amount);
    });

    const groups = [];
    const otherNames = [];
    let otherTotal = 0;
    categoryOrder.forEach((name, idx) => {
      if (!byCategory.has(name)) return;
      if (idx < MAX_SLOTS) {
        groups.push({ name, slot: idx + 1, amount: byCategory.get(name) });
      } else {
        otherNames.push(name);
        otherTotal += byCategory.get(name);
      }
    });
    byCategory.forEach((amount, name) => {
      if (!categoryOrder.includes(name)) {
        otherNames.push(name);
        otherTotal += amount;
      }
    });
    if (otherTotal > 0) {
      groups.push({ name: `その他（${otherNames.join('・')}）`, slot: 'other', amount: otherTotal });
    }

    renderDonut(groups, total);
    renderLegend(groups, total);
    renderRecords(records);
  }

  function polar(cx, cy, r, deg) {
    const rad = (deg - 90) * Math.PI / 180; // 12時起点
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function renderDonut(groups, total) {
    const svg = $('donutChart');
    svg.innerHTML = '';
    const NS = 'http://www.w3.org/2000/svg';
    const cx = 100, cy = 100, r = 96;

    if (groups.length === 1) {
      // 1カテゴリのみの日は全円
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
      c.setAttribute('class', 'donut-wedge');
      c.style.fill = colorVar(groups[0].slot);
      attachWedgeTooltip(c, groups[0], total);
      svg.appendChild(c);
    } else {
      let angle = 0;
      groups.forEach((g) => {
        const sweep = (g.amount / total) * 360;
        const [x1, y1] = polar(cx, cy, r, angle);
        const [x2, y2] = polar(cx, cy, r, angle + sweep);
        const largeArc = sweep > 180 ? 1 : 0;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`);
        path.setAttribute('class', 'donut-wedge');
        path.style.fill = colorVar(g.slot);
        attachWedgeTooltip(path, g, total);
        svg.appendChild(path);
        angle += sweep;
      });
    }

    // 中央をくり抜いてドーナツに（中央値はHTML側で表示）
    const hole = document.createElementNS(NS, 'circle');
    hole.setAttribute('cx', cx); hole.setAttribute('cy', cy); hole.setAttribute('r', 58);
    hole.setAttribute('class', 'donut-hole');
    svg.appendChild(hole);

    $('donutTotal').textContent = fmtYen(total);
  }

  function attachWedgeTooltip(el, group, total) {
    const pct = Math.round((group.amount / total) * 100);
    const show = (e) => {
      const tip = $('chartTooltip');
      tip.textContent = `${group.name} ${fmtYen(group.amount)}（${pct}%）`;
      tip.hidden = false;
      const wrap = tip.parentElement.getBoundingClientRect();
      tip.style.left = `${e.clientX - wrap.left + 12}px`;
      tip.style.top = `${e.clientY - wrap.top + 12}px`;
    };
    el.addEventListener('mousemove', show);
    el.addEventListener('click', show);
    el.addEventListener('mouseleave', () => { $('chartTooltip').hidden = true; });
  }

  function renderLegend(groups, total) {
    const legend = $('chartLegend');
    legend.innerHTML = '';
    groups.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'legend-row';

      const chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.style.background = colorVar(g.slot);

      const name = document.createElement('span');
      name.className = 'legend-name';
      name.textContent = g.name;

      const value = document.createElement('span');
      value.className = 'legend-value';
      value.textContent = `${fmtYen(g.amount)}（${Math.round((g.amount / total) * 100)}%）`;

      row.append(chip, name, value);
      legend.appendChild(row);
    });
  }

  function renderRecords(records) {
    const container = $('dayRecords');
    container.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'table-container';
    const table = document.createElement('table');
    table.className = 'detail-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['カテゴリ', '人', '金額', '場所', 'メモ'].forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    records.forEach((r) => {
      const tr = document.createElement('tr');
      tr.className = 'record-row';
      tr.dataset.record = JSON.stringify(r); // タップで record-dialog の編集/削除が開く

      const catCell = document.createElement('td');
      const chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.style.background = colorVar(slotOf(r.category));
      catCell.append(chip, document.createTextNode(' ' + r.category));

      const personCell = document.createElement('td');
      personCell.textContent = r.person;

      const amountCell = document.createElement('td');
      amountCell.className = 'amount';
      amountCell.textContent = fmtYen(r.amount);

      const locationCell = document.createElement('td');
      locationCell.textContent = r.location || '';

      const memoCell = document.createElement('td');
      memoCell.textContent = r.memo || '';

      tr.append(catCell, personCell, amountCell, locationCell, memoCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  // ---------- 初期化 ----------
  async function init() {
    try {
      const res = await fetch('/api/masters');
      const data = res.ok ? await res.json() : { categories: [] };
      categoryOrder = data.categories.map((c) => c.name);
    } catch {
      categoryOrder = [];
    }

    const param = new URLSearchParams(location.search).get('date');
    const initial = param && /^\d{4}-\d{2}-\d{2}$/.test(param) ? param : null;
    const base = initial ? new Date(initial) : new Date();
    viewYear = base.getFullYear();
    viewMonth = base.getMonth() + 1;

    $('calPrev').addEventListener('click', async () => {
      viewMonth--;
      if (viewMonth < 1) { viewMonth = 12; viewYear--; }
      await loadMonth();
    });
    $('calNext').addEventListener('click', async () => {
      viewMonth++;
      if (viewMonth > 12) { viewMonth = 1; viewYear++; }
      await loadMonth();
    });

    await loadMonth();
    if (initial) await selectDate(initial);
  }

  init();
})();
