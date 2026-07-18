// マスター管理画面（人・カテゴリの一覧・追加・削除）
(function () {
  'use strict';

  async function refresh() {
    try {
      const res = await fetch('/api/masters');
      if (!res.ok) throw new Error('マスターの取得に失敗しました');
      const data = await res.json();
      render('personList', data.persons, 'persons', '人');
      render('categoryList', data.categories, 'categories', 'カテゴリ');
    } catch (error) {
      alert(error.message);
    }
  }

  function render(elementId, items, apiPath, label) {
    const el = document.getElementById(elementId);
    el.innerHTML = '';

    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = `まだ${label}が登録されていません。`;
      el.appendChild(p);
      return;
    }

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'master-item';

      const name = document.createElement('span');
      name.textContent = item.name;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-danger master-del';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        if (!confirm(`「${item.name}」を削除しますか？\n（登録済みの記録は変更されません）`)) return;
        const res = await fetch(`/api/${apiPath}/${item.id}`, { method: 'DELETE' });
        if (res.ok) {
          refresh();
        } else {
          const data = await res.json().catch(() => ({}));
          alert(data.error || '削除に失敗しました');
        }
      });

      row.append(name, del);
      el.appendChild(row);
    });
  }

  async function add(apiPath, inputId) {
    const input = document.getElementById(inputId);
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const res = await fetch(`/api/${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      input.value = '';
      input.focus();
      refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || '追加に失敗しました');
    }
  }

  function bindAdd(buttonId, inputId, apiPath) {
    document.getElementById(buttonId).addEventListener('click', () => add(apiPath, inputId));
    document.getElementById(inputId).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add(apiPath, inputId);
      }
    });
  }

  bindAdd('personAdd', 'personName', 'persons');
  bindAdd('categoryAdd', 'categoryName', 'categories');
  refresh();
})();
