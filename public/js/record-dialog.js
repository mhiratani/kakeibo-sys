// 記録の登録・編集・削除ダイアログ（全ページ共通）
// グローバル: openRecordDialog(record?) … record ありで編集モード
(function () {
  'use strict';

  let masters = null;
  let editingRecord = null;   // 編集中の元レコード（null なら新規登録モード）
  let registeredCount = 0;    // このダイアログ表示中に登録した件数（閉じた時のリロード判定）
  let saving = false;

  const $ = (id) => document.getElementById(id);

  // ---------- トースト ----------
  function toast(message, isError = false) {
    let el = $('appToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('toast-error', isError);
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ---------- マスター取得 ----------
  async function loadMasters(force = false) {
    if (masters && !force) return masters;
    const res = await fetch('/api/masters');
    if (!res.ok) throw new Error('マスターの取得に失敗しました');
    masters = await res.json();
    return masters;
  }

  // ---------- ダイアログDOM生成 ----------
  function ensureDialogs() {
    if ($('recordDialog')) return;

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <dialog id="recordDialog" class="app-dialog">
        <form id="recordForm">
          <h3 id="recordDialogTitle">✏️ 記録を追加</h3>
          <div class="form-group">
            <label for="rdDate">日付</label>
            <input type="date" id="rdDate" required>
          </div>
          <div class="form-group">
            <label>収支</label>
            <div class="segmented" id="rdIncomeExpense">
              <button type="button" class="seg-btn active" data-value="支出">支出</button>
              <button type="button" class="seg-btn" data-value="収入">収入</button>
            </div>
          </div>
          <div class="form-group">
            <label>人</label>
            <button type="button" id="rdPerson" class="select-btn placeholder" data-value="">タップして選択</button>
          </div>
          <div class="form-group">
            <label>カテゴリ</label>
            <button type="button" id="rdCategory" class="select-btn placeholder" data-value="">タップして選択</button>
          </div>
          <div class="form-group">
            <label for="rdLocation">場所</label>
            <input id="rdLocation" maxlength="200" autocomplete="off" enterkeyhint="next">
          </div>
          <div class="form-group">
            <label for="rdMemo">買ったもの</label>
            <input id="rdMemo" maxlength="500" autocomplete="off" enterkeyhint="next">
          </div>
          <div class="form-group">
            <label for="rdAmount">金額</label>
            <input id="rdAmount" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" enterkeyhint="done">
          </div>
          <div class="btn-container dialog-btns">
            <button type="submit" id="rdSave" class="btn-primary">登録する</button>
            <button type="button" id="rdClose" class="btn-secondary">登録をやめる</button>
          </div>
        </form>
      </dialog>

      <dialog id="pickerDialog" class="app-dialog picker-dialog">
        <h3 id="pickerTitle"></h3>
        <div id="pickerList" class="picker-list"></div>
        <button type="button" id="pickerCancel" class="btn-secondary">キャンセル</button>
      </dialog>

      <dialog id="actionDialog" class="app-dialog">
        <h3>この記録をどうしますか？</h3>
        <div id="actionSummary" class="action-summary"></div>
        <div class="btn-container dialog-btns">
          <button type="button" id="actEdit" class="btn-primary">編集</button>
          <button type="button" id="actDelete" class="btn-danger">削除</button>
          <button type="button" id="actCancel" class="btn-secondary">キャンセル</button>
        </div>
      </dialog>
    `;
    document.body.appendChild(wrap);
    bindRecordDialogEvents();
  }

  // ---------- 選択ボタン ----------
  function setSelect(id, value) {
    const btn = $(id);
    btn.dataset.value = value || '';
    btn.textContent = value || 'タップして選択';
    btn.classList.toggle('placeholder', !value);
  }

  function setIncomeExpense(value) {
    $('rdIncomeExpense').querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === value);
    });
  }

  function getIncomeExpense() {
    return $('rdIncomeExpense').querySelector('.seg-btn.active')?.dataset.value || '支出';
  }

  // ---------- ピッカー ----------
  function openPicker(title, names) {
    return new Promise((resolve) => {
      const dlg = $('pickerDialog');
      $('pickerTitle').textContent = title;
      const list = $('pickerList');
      list.innerHTML = '';

      if (names.length === 0) {
        const p = document.createElement('p');
        p.className = 'picker-empty';
        p.textContent = 'マスターが未登録です。「マスター管理」から追加してください。';
        list.appendChild(p);
      }

      // 選択値を保持し、close イベント発火時に一度だけ解決する。
      // 人・カテゴリのピッカーは同じ dialog 要素を使い回すため、click 時点で
      // 解決すると、直前のピッカーの close イベント（非同期発火）が次のピッカーの
      // リスナーにも届き、選択前に null で解決されてしまう。close で解決すれば
      // 次のピッカーを開く時には前回の close は消化・リスナー除去済みとなる。
      let chosen = null;

      names.forEach((name) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'picker-item';
        b.textContent = name;
        b.addEventListener('click', () => {
          chosen = name;
          dlg.close();
        });
        list.appendChild(b);
      });

      dlg.addEventListener('close', () => resolve(chosen), { once: true });
      $('pickerCancel').onclick = () => { chosen = null; dlg.close(); };
      dlg.showModal();
    });
  }

  async function pickPerson() {
    try {
      const m = await loadMasters();
      const value = await openPicker('👤 人を選択', m.persons.map((p) => p.name));
      if (value !== null) {
        setSelect('rdPerson', value);
        // 仕様: 人を選ぶとカテゴリ選択ダイアログを自動表示
        await pickCategory();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function pickCategory() {
    try {
      const m = await loadMasters();
      const value = await openPicker('🏷️ カテゴリを選択', m.categories.map((c) => c.name));
      if (value !== null) {
        setSelect('rdCategory', value);
        $('rdAmount').focus();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ---------- 保存 ----------
  async function save() {
    if (saving) return;

    const payload = {
      record_date: $('rdDate').value,
      income_expense: getIncomeExpense(),
      person: $('rdPerson').dataset.value,
      category: $('rdCategory').dataset.value,
      amount: parseInt($('rdAmount').value, 10),
      location: $('rdLocation').value.trim(),
      memo: $('rdMemo').value.trim(),
      // 支払方法はダイアログに置かない: 編集時は元の値を保持、新規は空
      payment_method: editingRecord ? (editingRecord.payment_method || '') : '',
    };

    if (!payload.record_date) {
      toast('日付を入力してください', true);
      $('rdDate').focus();
      return;
    }
    if (!payload.person) {
      toast('人を選択してください', true);
      pickPerson();
      return;
    }
    if (!payload.category) {
      toast('カテゴリを選択してください', true);
      pickCategory();
      return;
    }
    if (!Number.isInteger(payload.amount) || payload.amount < 1) {
      toast('金額を入力してください', true);
      $('rdAmount').focus();
      return;
    }

    saving = true;
    $('rdSave').disabled = true;
    try {
      const isEdit = editingRecord !== null;
      const res = await fetch(isEdit ? `/api/records/${editingRecord.id}` : '/api/records', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || '保存に失敗しました', true);
        return;
      }

      if (isEdit) {
        toast('保存しました');
        $('recordDialog').close();
        setTimeout(() => location.reload(), 300);
        return;
      }

      // 連続登録: 人・カテゴリ・日付は保持して場所/メモ/金額だけクリア
      registeredCount++;
      toast(`登録しました: ${payload.person} / ${payload.category} ¥${payload.amount.toLocaleString()}`);
      $('rdAmount').value = '';
      $('rdLocation').value = '';
      $('rdMemo').value = '';
      $('rdLocation').focus();
    } catch (error) {
      toast('通信エラーが発生しました', true);
    } finally {
      saving = false;
      $('rdSave').disabled = false;
    }
  }

  // ---------- イベント ----------
  function bindRecordDialogEvents() {
    $('rdPerson').addEventListener('click', pickPerson);
    $('rdCategory').addEventListener('click', pickCategory);

    $('rdIncomeExpense').querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => setIncomeExpense(b.dataset.value));
    });

    // 金額は数値のみ
    $('rdAmount').addEventListener('input', function () {
      const cleaned = this.value.replace(/[^0-9]/g, '');
      if (this.value !== cleaned) this.value = cleaned;
    });

    // Enter（決定）で次のフォームへ移動、金額では即保存
    $('rdLocation').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('rdMemo').focus(); }
    });
    $('rdMemo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('rdAmount').focus(); }
    });
    $('rdAmount').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    });

    $('recordForm').addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });

    $('rdClose').addEventListener('click', () => $('recordDialog').close());

    // 閉じた時、このセッションで登録があればページを更新して反映
    $('recordDialog').addEventListener('close', () => {
      if (registeredCount > 0) {
        registeredCount = 0;
        location.reload();
      }
    });
  }

  // ---------- 公開関数 ----------
  window.openRecordDialog = function (record) {
    ensureDialogs();
    editingRecord = record || null;
    registeredCount = 0;

    const isEdit = editingRecord !== null;
    $('recordDialogTitle').textContent = isEdit ? '✏️ 記録を編集' : '✏️ 記録を追加';
    $('rdSave').textContent = isEdit ? '保存する' : '登録する';
    $('rdClose').textContent = isEdit ? 'キャンセル' : '登録をやめる';

    if (isEdit) {
      $('rdDate').value = record.record_date;
      setIncomeExpense(record.income_expense === '収入' ? '収入' : '支出');
      setSelect('rdPerson', record.person);
      setSelect('rdCategory', record.category);
      $('rdAmount').value = String(record.amount);
      $('rdLocation').value = record.location || '';
      $('rdMemo').value = record.memo || '';
    } else {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      $('rdDate').value = iso;
      setIncomeExpense('支出');
      setSelect('rdPerson', '');
      setSelect('rdCategory', '');
      $('rdAmount').value = '';
      $('rdLocation').value = '';
      $('rdMemo').value = '';
    }

    $('recordDialog').showModal();

    // マスターを先読みし、新規登録時は人ピッカーを自動表示
    loadMasters().then(() => {
      if (!isEdit) pickPerson();
    }).catch((error) => toast(error.message, true));
  };

  // ---------- サマリー明細タップ → 編集/削除 ----------
  function openRecordActions(record) {
    ensureDialogs();
    const dlg = $('actionDialog');

    const summary = $('actionSummary');
    summary.innerHTML = '';
    const line1 = document.createElement('p');
    line1.className = 'action-main';
    line1.textContent = `${record.record_date}　${record.person} / ${record.category}　¥${Number(record.amount).toLocaleString()}`;
    summary.appendChild(line1);
    const subText = [record.location, record.memo].filter(Boolean).join(' / ');
    if (subText) {
      const line2 = document.createElement('p');
      line2.className = 'action-sub';
      line2.textContent = subText;
      summary.appendChild(line2);
    }

    $('actEdit').onclick = () => {
      dlg.close();
      window.openRecordDialog(record);
    };

    $('actDelete').onclick = async () => {
      if (!confirm('この記録を削除しますか？')) return;
      try {
        const res = await fetch(`/api/records/${record.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data.error || '削除に失敗しました', true);
          return;
        }
        toast('削除しました');
        dlg.close();
        setTimeout(() => location.reload(), 300);
      } catch (error) {
        toast('通信エラーが発生しました', true);
      }
    };

    $('actCancel').onclick = () => dlg.close();
    dlg.showModal();
  }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('.record-row');
    if (!row || !row.dataset.record) return;
    let record;
    try {
      record = JSON.parse(row.dataset.record);
    } catch {
      return;
    }
    openRecordActions(record);
  });
})();
