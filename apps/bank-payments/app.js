/* Интерфейс обработки банковских выписок. Данные хранятся в localStorage этого браузера (если доступен). */
(function () {
  'use strict';
  const C = window.BankCore;
  const STORE_KEY = 'sid-bank-payments-v1';
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  const DEFAULT_CATEGORIES = [
    'Оплата от покупателя', 'Бронирование / депозит', 'Возврат покупателю', 'Подрядчики', 'Материалы',
    'Зарплата', 'Налоги', 'Комиссия банка', 'Коммунальные', 'Аренда', 'Маркетинг', 'Займы / финансирование',
    'Перевод между счетами', 'Прочее',
  ];
  const DEFAULT_RULES = [
    { text: '/fee|комисси|ค่าธรรมเนียม/', field: 'any', direction: 'out', action: 'categorize', category: 'Комиссия банка' },
    { text: '/own account|между своими|โอนเงินระหว่างบัญชี/', field: 'any', direction: 'any', action: 'categorize', category: 'Перевод между счетами' },
    { text: '/salary|payroll|зарплат|เงินเดือน/', field: 'any', direction: 'out', action: 'categorize', category: 'Зарплата' },
    { text: '/revenue dept|withholding|налог|ภาษี|สรรพากร/', field: 'any', direction: 'out', action: 'categorize', category: 'Налоги' },
    { text: '/electric|water|pea|mea|pwa|ค่าไฟ|ค่าน้ำ/', field: 'any', direction: 'out', action: 'categorize', category: 'Коммунальные' },
  ].map((r, i) => Object.assign({ id: 'r' + i }, r));

  const STATUS = {
    new: 'Новая',
    review: 'Проверить',
    matched: 'Сопоставлена',
    done: 'Обработана',
    ignored: 'Игнор',
  };

  let state = load();
  let pending = null; // разбираемый файл до импорта
  let selected = new Set();
  let openTxId = null;
  let currentTab = state.ui.tab || 'import';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtNum = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n) => (n == null || isNaN(n) ? '' : fmtNum.format(n));
  const fmtDate = (d) => (d ? d.split('-').reverse().join('.') : '');
  const today = () => new Date().toISOString().slice(0, 10);
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let storageOk = true;
  function load(from) {
    let s = from || null;
    if (!from) {
      try {
        s = JSON.parse(localStorage.getItem(STORE_KEY));
      } catch (e) {
        storageOk = false;
      }
    }
    s = s || {};
    return {
      transactions: s.transactions || [],
      expected: s.expected || [],
      rules: s.rules || DEFAULT_RULES.slice(),
      categories: s.categories || DEFAULT_CATEGORIES.slice(),
      imports: s.imports || [],
      ui: s.ui || {},
    };
  }
  function save() {
    state.ui.tab = currentTab;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      if (storageOk) toast('Браузер не даёт сохранить данные: они пропадут при закрытии страницы. Делайте резервную копию.');
      storageOk = false;
    }
  }
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function msg(el, kind, text, list) {
    el.innerHTML =
      `<div class="msg ${kind}">${esc(text)}` +
      (list && list.length
        ? `<ul>${list.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}${list.length > 8 ? `<li>…и ещё ${list.length - 8}</li>` : ''}</ul>`
        : '') +
      `</div>`;
  }
  // Диалог внутри страницы вместо confirm()/prompt(), которые блокируются во встроенных окнах.
  function ask(text, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const dlg = $('#dialog');
      $('#dialogText').textContent = text;
      const inp = $('#dialogInput');
      inp.classList.toggle('hidden', opts.input == null);
      inp.value = opts.input || '';
      $('#dialogOk').textContent = opts.ok || 'OK';
      $('#dialogOk').className = opts.danger ? 'primary danger-bg' : 'primary';
      dlg.classList.remove('hidden');
      (opts.input != null ? inp : $('#dialogOk')).focus();
      const done = (v) => {
        dlg.classList.add('hidden');
        $('#dialogOk').onclick = $('#dialogCancel').onclick = inp.onkeydown = null;
        resolve(v);
      };
      $('#dialogOk').onclick = () => done(opts.input != null ? inp.value.trim() || null : true);
      $('#dialogCancel').onclick = () => done(opts.input != null ? null : false);
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') $('#dialogOk').click();
      };
    });
  }

  let downloadsApi;
  async function download(name, content, type) {
    // Внутри чата Claude файлы сохраняются через платформу (с подтверждением пользователя).
    if (window.claude && typeof window.claude.use === 'function') {
      if (downloadsApi === undefined) {
        try {
          downloadsApi = await window.claude.use('downloads');
        } catch (e) {
          downloadsApi = null;
        }
      }
      if (downloadsApi) {
        try {
          await downloadsApi.save({ filename: name, data: content });
          toast('Файл сохранён');
        } catch (e) {
          if (e && e.code === 'declined') return;
          showCopy(name, content);
        }
        return;
      }
      return showCopy(name, content);
    }
    const blob = new Blob([content], { type: type || 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 100);
  }
  function showCopy(name, content) {
    $('#copyTitle').textContent = name;
    $('#copyText').value = content.replace(/^\uFEFF/, '');
    $('#copyDialog').classList.remove('hidden');
  }
  $('#copyClose').addEventListener('click', () => $('#copyDialog').classList.add('hidden'));
  $('#copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#copyText').value);
      toast('Скопировано — вставьте в Excel или текстовый файл');
    } catch (e) {
      $('#copyText').select();
      toast('Выделено — нажмите Ctrl+C');
    }
  });
  const expById = () => Object.fromEntries(state.expected.map((e) => [e.id, e]));

  // ---------- Вкладки ----------

  function showTab(name) {
    currentTab = name;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    if (name !== 'tx') closeDrawer();
    renderAll();
    save();
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  function renderAll() {
    renderCategorySelects();
    renderImports();
    if (currentTab === 'tx') renderTx();
    if (currentTab === 'expected') renderExpected();
    if (currentTab === 'rules') renderRules();
    const todo = state.transactions.filter((t) => t.status === 'new' || t.status === 'review').length;
    const rc = $('#reviewCount');
    rc.textContent = todo;
    rc.classList.toggle('hidden', !todo);
  }

  // ---------- 1. Загрузка выписки ----------

  const drop = $('#drop');
  drop.addEventListener('click', () => $('#file').click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });
  $('#file').addEventListener('change', (e) => {
    if (e.target.files[0]) readFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#pasteBtn').addEventListener('click', () => {
    const text = $('#paste').value;
    if (!text.trim()) return;
    startMapping(C.parseCsv(text), 'Вставка ' + new Date().toLocaleString('ru-RU'));
  });

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  }

  async function readFile(file) {
    const box = $('#importMsg');
    box.innerHTML = '';
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        if (!window.XLSX) {
          msg(box, 'warn', 'Загружаю модуль чтения Excel…');
          await loadScript(XLSX_URL);
        }
        const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const pad = (n) => String(n).padStart(2, '0');
        // ячейки-даты берём как даты (а не как текст в формате ячейки, который бывает американским)
        const cell = (v) =>
          v instanceof Date
            ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` +
              (v.getHours() || v.getMinutes() ? ` ${pad(v.getHours())}:${pad(v.getMinutes())}` : '')
            : String(v).trim();
        const rows = window.XLSX.utils
          .sheet_to_json(ws, { header: 1, raw: true, defval: '' })
          .map((r) => r.map(cell))
          .filter((r) => r.some((v) => v));
        box.innerHTML = '';
        startMapping(rows, file.name);
      } else {
        const buf = await file.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buf);
        // выгрузки старых систем бывают в windows-1251 / windows-874 (тайский)
        if (text.includes('\uFFFD')) {
          const enc = /[฀-๿]/.test(new TextDecoder('windows-874').decode(buf.slice(0, 4000))) ? 'windows-874' : 'windows-1251';
          text = new TextDecoder(enc).decode(buf);
        }
        startMapping(C.parseCsv(text), file.name);
      }
    } catch (e) {
      msg(box, 'err', 'Не удалось прочитать файл: ' + e.message + '. Сохраните выписку как CSV и попробуйте снова.');
    }
  }

  function startMapping(rows, source) {
    if (!rows.length) {
      msg($('#importMsg'), 'err', 'В файле нет данных');
      return;
    }
    let h = C.findHeaderRow(rows);
    pending = { rows, source, headerIdx: h < 0 ? 0 : h, hasHeader: h >= 0 };
    pending.mapping = pending.hasHeader ? C.guessMapping(rows[pending.headerIdx]) : rows[0].map(() => '');
    $('#headerRow').value = pending.headerIdx + 1;
    const known = state.imports.find((i) => i.source === source);
    $('#accountName').value = known ? known.account : state.ui.lastAccount || '';
    $('#mappingPanel').classList.remove('hidden');
    renderMapping();
    $('#mappingPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#headerRow').addEventListener('change', () => {
    if (!pending) return;
    const v = Math.max(1, Math.min(pending.rows.length, Number($('#headerRow').value) || 1));
    pending.headerIdx = v - 1;
    pending.hasHeader = true;
    pending.mapping = C.guessMapping(pending.rows[pending.headerIdx]);
    renderMapping();
  });
  $('#dateOrder').addEventListener('change', renderMapping);

  function renderMapping() {
    const { rows, headerIdx, mapping } = pending;
    const header = rows[headerIdx];
    const width = Math.max(...rows.slice(headerIdx, headerIdx + 50).map((r) => r.length));
    while (mapping.length < width) mapping.push('');
    const opts = Object.entries(C.FIELD_LABELS);
    const data = rows.slice(headerIdx + 1);
    let html = '<thead><tr>';
    for (let i = 0; i < width; i++) {
      html += `<th><select data-col="${i}">${opts
        .map(([k, v]) => `<option value="${k}"${mapping[i] === k ? ' selected' : ''}>${esc(v)}</option>`)
        .join('')}</select><div class="muted" title="${esc(header[i])}">${esc(header[i] || '—')}</div></th>`;
    }
    html += '</tr></thead><tbody>';
    for (const r of data.slice(0, 12)) {
      html += '<tr>' + Array.from({ length: width }, (_, i) => `<td title="${esc(r[i])}">${esc(r[i])}</td>`).join('') + '</tr>';
    }
    html += '</tbody>';
    $('#mappingTable').innerHTML = html;
    const res = C.rowsToTransactions(data, mapping, { dateOrder: $('#dateOrder').value, account: 'preview' });
    const inSum = res.transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const outSum = res.transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
    $('#previewInfo').textContent = res.errors.length && !res.transactions.length
      ? res.errors[0]
      : `Будет загружено строк: ${res.transactions.length} · приход ${money(inSum)} · расход ${money(-outSum)}` +
        (res.errors.length ? ` · пропущено с ошибками: ${res.errors.length}` : '');
    $('#doImport').disabled = !res.transactions.length;
  }
  $('#mappingTable').addEventListener('change', (e) => {
    const s = e.target.closest('select[data-col]');
    if (!s) return;
    const col = Number(s.dataset.col);
    // одно поле — одна колонка
    if (s.value) pending.mapping = pending.mapping.map((m, i) => (m === s.value && i !== col ? '' : m));
    pending.mapping[col] = s.value;
    renderMapping();
  });
  $('#cancelImport').addEventListener('click', () => {
    pending = null;
    $('#mappingPanel').classList.add('hidden');
  });

  $('#doImport').addEventListener('click', () => {
    if (!pending) return;
    const account = $('#accountName').value.trim();
    state.ui.lastAccount = account;
    const importId = uid('imp_');
    const res = C.rowsToTransactions(pending.rows.slice(pending.headerIdx + 1), pending.mapping, {
      dateOrder: $('#dateOrder').value,
      account,
      currency: $('#currency').value.trim() || 'THB',
      source: importId,
    });
    const existing = new Set(state.transactions.map((t) => t.id));
    const fresh = res.transactions.filter((t) => !existing.has(t.id));
    const dup = res.transactions.length - fresh.length;
    state.transactions.push(...fresh);
    const dates = fresh.map((t) => t.date).sort();
    state.imports.push({
      id: importId,
      source: pending.source,
      account,
      at: new Date().toISOString(),
      count: fresh.length,
      duplicates: dup,
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
    });
    C.applyRules(fresh, state.rules);
    const m = C.autoMatch(state.transactions, state.expected);
    save();
    pending = null;
    $('#mappingPanel').classList.add('hidden');
    msg(
      $('#importMsg'),
      res.errors.length ? 'warn' : 'ok',
      `Загружено ${fresh.length} операций` +
        (dup ? `, пропущено дублей: ${dup}` : '') +
        (m.matched || m.review ? `. Автосопоставлено: ${m.matched}, на проверку: ${m.review}` : '') +
        (res.errors.length ? `. Строк с ошибками: ${res.errors.length}` : ''),
      res.errors
    );
    renderAll();
  });

  function renderImports() {
    const el = $('#importsList');
    if (!state.imports.length) {
      el.innerHTML = '<div class="muted">Пока ничего не загружено. Можно нажать «Демо-данные», чтобы посмотреть, как это работает.</div>';
      return;
    }
    const counts = {};
    state.transactions.forEach((t) => (counts[t.source] = (counts[t.source] || 0) + 1));
    el.innerHTML =
      '<table><thead><tr><th>Файл</th><th>Счёт</th><th>Период</th><th class="num">Операций</th><th class="num">Дублей пропущено</th><th>Загружен</th><th></th></tr></thead><tbody>' +
      state.imports
        .slice()
        .reverse()
        .map(
          (i) => `<tr><td>${esc(i.source)}</td><td>${esc(i.account)}</td><td>${fmtDate(i.from)} – ${fmtDate(i.to)}</td>
          <td class="num">${counts[i.id] || 0}</td><td class="num">${i.duplicates || 0}</td>
          <td>${new Date(i.at).toLocaleString('ru-RU')}</td>
          <td><button class="link danger" data-del-import="${esc(i.id)}">удалить</button></td></tr>`
        )
        .join('') +
      '</tbody></table>';
  }
  $('#importsList').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.delImport;
    if (!id) return;
    const n = state.transactions.filter((t) => t.source === id).length;
    if (!(await ask(`Удалить выписку и ${n} её операций (включая сделанные сопоставления)?`, { ok: 'Удалить', danger: true }))) return;
    state.transactions = state.transactions.filter((t) => t.source !== id);
    state.imports = state.imports.filter((i) => i.id !== id);
    save();
    renderAll();
  });

  // ---------- 2. Платежи ----------

  function renderCategorySelects() {
    const cats = state.categories;
    $('#fCat').innerHTML =
      '<option value="">Все категории</option><option value="__none">Без категории</option>' +
      cats.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#fCat').value = state.ui.fCat || '';
    $('#bulkCat').innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#ruleCat').innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('');
  }

  ['q', 'fStatus', 'fDir', 'fCat', 'fFrom', 'fTo'].forEach((id) => {
    const el = $('#' + id);
    el.value = state.ui[id] || (id === 'fStatus' ? '' : '');
    el.addEventListener('input', () => {
      state.ui[id] = el.value;
      selected.clear();
      renderTx();
      save();
    });
  });

  function filtered() {
    const q = ($('#q').value || '').toLowerCase().trim();
    const st = $('#fStatus').value;
    const dir = $('#fDir').value;
    const cat = $('#fCat').value;
    const from = $('#fFrom').value;
    const to = $('#fTo').value;
    const ex = expById();
    return state.transactions
      .filter((t) => {
        if (st === 'todo' ? !(t.status === 'new' || t.status === 'review') : st && t.status !== st) return false;
        if (dir === 'in' && t.amount < 0) return false;
        if (dir === 'out' && t.amount > 0) return false;
        if (cat === '__none' ? t.category : cat && t.category !== cat) return false;
        if (from && t.date < from) return false;
        if (to && t.date > to) return false;
        if (q) {
          const e = ex[t.matchId] || {};
          const hay = [t.description, t.counterparty, t.reference, t.account, t.note, t.category, e.code, e.payer, String(t.amount)]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : -1) : a.date < b.date ? 1 : -1));
  }

  function renderCards() {
    const tx = state.transactions;
    const sum = (arr) => arr.reduce((s, t) => s + t.amount, 0);
    const incoming = tx.filter((t) => t.amount > 0 && t.status !== 'ignored');
    const outgoing = tx.filter((t) => t.amount < 0 && t.status !== 'ignored');
    const review = tx.filter((t) => t.status === 'review');
    const fresh = tx.filter((t) => t.status === 'new');
    const matched = tx.filter((t) => t.status === 'matched');
    const unknownIn = incoming.filter((t) => t.status === 'new');
    $('#cards').innerHTML = [
      ['Приход', money(sum(incoming)), `${incoming.length} операций`, 'pos'],
      ['Расход', money(-sum(outgoing)), `${outgoing.length} операций`, 'neg'],
      ['Сопоставлено с ожидаемыми', money(sum(matched)), `${matched.length} поступлений`, '', 'matched'],
      ['На проверке', review.length, money(sum(review)), '', 'review'],
      ['Неопознанные поступления', unknownIn.length, money(sum(unknownIn)), unknownIn.length ? 'neg' : '', 'new', 'in'],
      ['Новые (всего)', fresh.length, 'без категории и связи', '', 'new'],
    ]
      .map(
        ([label, value, sub, cls, st, dir]) =>
          `<div class="card"><div class="label">${label}</div><div class="value ${cls || ''}">${value}</div>
           <div class="small muted">${sub}${st ? ` · <button class="link" data-card-status="${st}" data-card-dir="${dir || ''}">показать</button>` : ''}</div></div>`
      )
      .join('');
  }
  $('#cards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-card-status]');
    if (!b) return;
    $('#fStatus').value = state.ui.fStatus = b.dataset.cardStatus;
    $('#fDir').value = state.ui.fDir = b.dataset.cardDir;
    selected.clear();
    renderTx();
  });

  function linkCell(t, ex) {
    if (t.status === 'matched' && ex[t.matchId]) {
      const e = ex[t.matchId];
      return `<span class="badge b-matched">${esc(e.code)}</span> <span class="small muted">${esc(e.payer)}</span>`;
    }
    if (t.status === 'review' && ex[t.suggestId]) {
      const e = ex[t.suggestId];
      return `<span class="small muted">Предложено:</span> <b>${esc(e.code)}</b> <span class="small muted">(${t.matchScore})</span>
        <button class="link" data-confirm="${esc(t.id)}">подтвердить</button>`;
    }
    return '';
  }

  function renderTx() {
    renderCards();
    const rows = filtered();
    const ex = expById();
    const table = $('#txTable');
    if (!state.transactions.length) {
      table.innerHTML = '<tr><td class="empty">Нет операций. Загрузите выписку на вкладке «1. Выписки».</td></tr>';
      $('#txFooter').textContent = '';
      $('#bulk').classList.add('hidden');
      return;
    }
    const limit = 1000;
    const catOpts = (cur) =>
      '<option value="">—</option>' + state.categories.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
    const allChecked = rows.length && rows.every((t) => selected.has(t.id));
    table.innerHTML =
      `<thead><tr><th><input type="checkbox" id="selAll"${allChecked ? ' checked' : ''} title="Выбрать все по фильтру"></th>
       <th>Дата</th><th class="num">Сумма</th><th>Контрагент / назначение</th><th>Счёт</th><th>Статус</th><th>Связь с ожидаемым</th><th>Категория</th></tr></thead><tbody>` +
      (rows.length
        ? rows
            .slice(0, limit)
            .map(
              (t) => `<tr class="clickable${t.id === openTxId ? ' selected' : ''}" data-id="${esc(t.id)}">
          <td><input type="checkbox" data-sel="${esc(t.id)}"${selected.has(t.id) ? ' checked' : ''}></td>
          <td style="white-space:nowrap">${fmtDate(t.date)}${t.time ? `<div class="small muted">${esc(t.time)}</div>` : ''}</td>
          <td class="num ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount))}<div class="small muted">${esc(t.currency)}</div></td>
          <td class="desc">${t.counterparty ? `<b>${esc(t.counterparty)}</b><br>` : ''}${esc(t.description)}${
                t.reference ? ` <span class="small muted">#${esc(t.reference)}</span>` : ''
              }${t.note ? `<div class="small" style="color:var(--accent)">✎ ${esc(t.note)}</div>` : ''}</td>
          <td class="small muted">${esc(t.account)}</td>
          <td><span class="badge b-${t.status}">${STATUS[t.status]}</span></td>
          <td>${linkCell(t, ex)}</td>
          <td><select data-cat="${esc(t.id)}" style="max-width:170px">${catOpts(t.category)}</select></td></tr>`
            )
            .join('')
        : '<tr><td colspan="8" class="empty">Нет операций по фильтру</td></tr>') +
      '</tbody>';
    const total = rows.reduce((s, t) => s + t.amount, 0);
    $('#txFooter').textContent =
      `Показано ${Math.min(rows.length, limit)} из ${rows.length} (всего ${state.transactions.length}) · сальдо по фильтру ${money(total)}` +
      (rows.length > limit ? ' · уточните фильтр, чтобы увидеть остальные' : '') +
      ' · горячие клавиши в карточке: ↑/↓ — соседняя операция, Enter — подтвердить, I — игнор, Esc — закрыть';
    renderBulk();
  }

  function renderBulk() {
    $('#bulk').classList.toggle('hidden', !selected.size);
    $('#bulkCount').textContent = `Выбрано: ${selected.size}`;
  }

  $('#txTable').addEventListener('click', (e) => {
    if (e.target.id === 'selAll') {
      const rows = filtered();
      if (e.target.checked) rows.forEach((t) => selected.add(t.id));
      else selected.clear();
      renderTx();
      return;
    }
    if (e.target.dataset.sel) {
      e.stopPropagation();
      const id = e.target.dataset.sel;
      e.target.checked ? selected.add(id) : selected.delete(id);
      renderBulk();
      return;
    }
    if (e.target.dataset.confirm) {
      e.stopPropagation();
      confirmSuggestion(getTx(e.target.dataset.confirm));
      save();
      renderAll();
      return;
    }
    if (e.target.closest('select, input, button')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDrawer(tr.dataset.id);
  });
  $('#txTable').addEventListener('change', (e) => {
    const id = e.target.dataset.cat;
    if (!id) return;
    setCategory(getTx(id), e.target.value);
    save();
    renderAll();
    if (openTxId === id) openDrawer(id);
  });

  const getTx = (id) => state.transactions.find((t) => t.id === id);

  function setCategory(t, cat) {
    t.category = cat;
    t.locked = true;
    if (cat && (t.status === 'new' || (t.status === 'review' && t.amount < 0))) t.status = 'done';
    if (!cat && t.status === 'done') t.status = 'new';
  }
  function linkTo(t, expId) {
    t.matchId = expId;
    t.suggestId = '';
    t.status = 'matched';
    t.locked = true;
    if (!t.category) t.category = 'Оплата от покупателя';
  }
  function confirmSuggestion(t) {
    if (t && t.status === 'review' && t.suggestId) linkTo(t, t.suggestId);
  }
  function resetTx(t) {
    t.status = 'new';
    t.matchId = '';
    t.suggestId = '';
    t.matchScore = null;
    t.locked = false;
  }

  $('#autoBtn').addEventListener('click', () => {
    if (!state.expected.length) {
      toast('Сначала загрузите ожидаемые поступления (вкладка 3)');
      return;
    }
    const m = C.autoMatch(state.transactions, state.expected);
    save();
    renderAll();
    toast(`Сопоставлено автоматически: ${m.matched}, отправлено на проверку: ${m.review}`);
  });
  $('#rulesBtn').addEventListener('click', () => {
    const n = C.applyRules(state.transactions, state.rules);
    save();
    renderAll();
    toast(`Правила изменили операций: ${n}`);
  });

  $('#bulkCatBtn').addEventListener('click', () => bulk((t) => setCategory(t, $('#bulkCat').value)));
  $('#bulkConfirm').addEventListener('click', () => bulk(confirmSuggestion));
  $('#bulkIgnore').addEventListener('click', () =>
    bulk((t) => {
      t.status = 'ignored';
      t.locked = true;
    })
  );
  $('#bulkReset').addEventListener('click', () => bulk(resetTx));
  $('#bulkClear').addEventListener('click', () => {
    selected.clear();
    renderTx();
  });
  function bulk(fn) {
    let n = 0;
    selected.forEach((id) => {
      const t = getTx(id);
      if (t) {
        fn(t);
        n++;
      }
    });
    selected.clear();
    save();
    renderAll();
    toast(`Изменено операций: ${n}`);
  }

  $('#exportTx').addEventListener('click', () => {
    const ex = expById();
    const rows = [
      ['Дата', 'Время', 'Сумма', 'Валюта', 'Счёт', 'Контрагент', 'Назначение', 'Референс', 'Статус', 'Категория',
        'Код ожидаемого', 'Плательщик (ожид.)', 'Проект', 'Комментарий'],
    ];
    for (const t of filtered()) {
      const e = (t.status === 'matched' && ex[t.matchId]) || {};
      rows.push([t.date, t.time, t.amount.toFixed(2), t.currency, t.account, t.counterparty, t.description, t.reference,
        STATUS[t.status], t.category, e.code || '', e.payer || '', e.project || '', t.note]);
    }
    download(`платежи_${today()}.csv`, C.toCsv(rows));
  });

  // ---------- Карточка платежа ----------

  function openDrawer(id) {
    const t = getTx(id);
    if (!t) return closeDrawer();
    openTxId = id;
    $$('#txTable tr[data-id]').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
    const ex = expById();
    const balances = C.expectedBalances(state.expected, state.transactions);
    const d = $('#drawer');
    let candHtml = '';
    if (t.amount > 0) {
      const cands = C.scoreCandidates(t, state.expected, balances).slice(0, 6);
      const linked = t.status === 'matched' && ex[t.matchId];
      candHtml = `<h4>Связь с ожидаемым поступлением</h4>`;
      if (linked) {
        const e = ex[t.matchId];
        candHtml += `<div class="cand suggested" style="border-color:var(--green);background:var(--green-weak)">
          <div class="grow"><b>${esc(e.code)}</b> · ${esc(e.payer)} <div class="small muted">${esc(e.project)} ${esc(e.description)} · ${money(e.amount)} · срок ${fmtDate(e.due)} · остаток ${money(balances[e.id].remaining)}</div></div>
          <button data-unlink>Отвязать</button></div>`;
      } else if (!state.expected.length) {
        candHtml += '<div class="muted small">Нет списка ожидаемых поступлений — загрузите его на вкладке 3.</div>';
      } else {
        candHtml += cands.length
          ? cands
              .map((c) => {
                const e = ex[c.id];
                return `<div class="cand${c.id === t.suggestId ? ' suggested' : ''}">
              <div class="score" title="Уверенность">${c.score}</div>
              <div class="grow"><b>${esc(e.code)}</b> · ${esc(e.payer)}
                <div class="small muted">${esc(e.project)} ${esc(e.description)} · ${money(e.amount)} · срок ${fmtDate(e.due)} · остаток ${money(balances[e.id].remaining)}</div>
                <div class="small">${c.reasons.map(esc).join(', ')}</div></div>
              <button class="primary" data-link="${esc(c.id)}">Связать</button></div>`;
              })
              .join('')
          : '<div class="muted small">Подходящих кандидатов не найдено.</div>';
        candHtml += `<div class="row" style="margin-top:8px"><input id="manualSearch" class="grow" placeholder="Найти вручную: код, плательщик, проект"></div><div id="manualResults"></div>`;
      }
    }
    d.innerHTML = `
      <div class="row"><h3 class="grow ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount))} ${esc(t.currency)}</h3>
        <button data-close title="Esc">✕</button></div>
      <span class="badge b-${t.status}">${STATUS[t.status]}</span>
      <dl>
        <dt>Дата</dt><dd>${fmtDate(t.date)} ${esc(t.time)}</dd>
        <dt>Счёт</dt><dd>${esc(t.account) || '—'}</dd>
        <dt>Контрагент</dt><dd>${esc(t.counterparty) || '—'}</dd>
        <dt>Назначение</dt><dd>${esc(t.description) || '—'}</dd>
        <dt>Референс</dt><dd>${esc(t.reference) || '—'}</dd>
        ${t.channel ? `<dt>Канал</dt><dd>${esc(t.channel)}</dd>` : ''}
        ${t.balance != null ? `<dt>Остаток после</dt><dd>${money(t.balance)}</dd>` : ''}
      </dl>
      <label>Категория<br><select id="dCat" style="width:100%"><option value="">—</option>${state.categories
        .map((c) => `<option${c === t.category ? ' selected' : ''}>${esc(c)}</option>`)
        .join('')}</select></label>
      <div style="margin-top:10px"><label>Комментарий<br><textarea id="dNote" style="min-height:50px;font-family:inherit;font-size:13px">${esc(t.note)}</textarea></label></div>
      ${candHtml}
      <div class="row" style="margin-top:16px">
        ${t.status === 'review' ? '<button class="primary" data-confirm-d>Подтвердить предложенное</button>' : ''}
        ${t.status !== 'ignored' ? '<button data-ignore>Игнорировать</button>' : ''}
        ${t.status !== 'new' ? '<button data-reset>Сбросить</button>' : ''}
        <button data-mkrule title="Создать правило по контрагенту/назначению">Создать правило…</button>
      </div>`;
    d.classList.add('open');
  }
  function closeDrawer() {
    openTxId = null;
    $('#drawer').classList.remove('open');
    $$('#txTable tr.selected').forEach((tr) => tr.classList.remove('selected'));
  }

  $('#drawer').addEventListener('click', async (e) => {
    const t = getTx(openTxId);
    if (!t) return;
    const ds = e.target.dataset || {};
    if ('close' in ds) return closeDrawer();
    let changed = true;
    if (ds.link) linkTo(t, ds.link);
    else if ('unlink' in ds) resetTx(t);
    else if ('confirmD' in ds) confirmSuggestion(t);
    else if ('ignore' in ds) {
      t.status = 'ignored';
      t.locked = true;
    } else if ('reset' in ds) resetTx(t);
    else if ('mkrule' in ds) {
      const text = await ask('Новое правило: если текст операции содержит…', { input: t.counterparty || t.description.slice(0, 30), ok: 'Создать' });
      if (!text) return;
      const cat = t.category || state.categories[0];
      state.rules.push({ id: uid('r'), text, field: 'any', direction: t.amount > 0 ? 'in' : 'out', action: 'categorize', category: cat });
      toast(`Правило добавлено: «${text}» → ${cat}. Нажмите «Применить правила».`);
    } else changed = false;
    if (changed) {
      save();
      renderAll();
      openDrawer(t.id);
    }
  });
  $('#drawer').addEventListener('change', (e) => {
    const t = getTx(openTxId);
    if (!t) return;
    if (e.target.id === 'dCat') setCategory(t, e.target.value);
    else if (e.target.id === 'dNote') t.note = e.target.value.trim();
    else return;
    save();
    renderAll();
    openDrawer(t.id);
  });
  $('#drawer').addEventListener('input', (e) => {
    if (e.target.id !== 'manualSearch') return;
    const q = e.target.value.toLowerCase().trim();
    const box = $('#manualResults');
    if (!q) return (box.innerHTML = '');
    const balances = C.expectedBalances(state.expected, state.transactions);
    const hits = state.expected
      .filter((x) => [x.code, x.payer, x.project, x.description].join(' ').toLowerCase().includes(q))
      .slice(0, 8);
    box.innerHTML = hits.length
      ? hits
          .map(
            (x) => `<div class="cand"><div class="grow"><b>${esc(x.code)}</b> · ${esc(x.payer)}
          <div class="small muted">${esc(x.project)} ${esc(x.description)} · ${money(x.amount)} · остаток ${money(balances[x.id].remaining)}</div></div>
          <button data-link="${esc(x.id)}">Связать</button></div>`
          )
          .join('')
      : '<div class="muted small">Ничего не найдено</div>';
  });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!$('#dialog').classList.contains('hidden')) {
      if (e.key === 'Escape') $('#dialogCancel').click();
      return;
    }
    if (e.key === 'Escape' && !$('#copyDialog').classList.contains('hidden')) return $('#copyDialog').classList.add('hidden');
    if (e.key === 'Escape') {
      if (typing) document.activeElement.blur();
      else closeDrawer();
      return;
    }
    if (typing || currentTab !== 'tx') return;
    if (e.key === '/') {
      e.preventDefault();
      $('#q').focus();
      return;
    }
    if (!openTxId) return;
    const list = filtered();
    const i = list.findIndex((t) => t.id === openTxId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) {
        openDrawer(n.id);
        const tr = $(`#txTable tr[data-id="${CSS.escape(n.id)}"]`);
        if (tr) tr.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' || e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'ш') {
      const t = getTx(openTxId);
      if (e.key === 'Enter') confirmSuggestion(t);
      else {
        t.status = 'ignored';
        t.locked = true;
      }
      save();
      renderTx();
      // переходим к следующей операции, требующей действия
      const next = filtered().find((x, j) => j >= i && x.id !== t.id && (x.status === 'new' || x.status === 'review'));
      next ? openDrawer(next.id) : openDrawer(t.id);
      renderAll();
    }
  });

  // ---------- 3. Ожидаемые поступления ----------

  $('#expFileBtn').addEventListener('click', () => $('#expFile').click());
  $('#expFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const res = C.parseExpected(await f.text());
    const existing = new Set(state.expected.map((x) => x.id));
    const fresh = res.items.filter((x) => !existing.has(x.id));
    state.expected.push(...fresh);
    const m = fresh.length ? C.autoMatch(state.transactions, state.expected) : { matched: 0, review: 0 };
    save();
    msg(
      $('#expMsg'),
      res.errors.length ? (fresh.length ? 'warn' : 'err') : 'ok',
      fresh.length
        ? `Добавлено ${fresh.length} позиций` + (res.items.length - fresh.length ? `, уже были: ${res.items.length - fresh.length}` : '') +
          `. Сопоставлено поступлений: ${m.matched}, на проверку: ${m.review}`
        : 'Ничего не добавлено',
      res.errors
    );
    renderAll();
  });
  $('#expAddBtn').addEventListener('click', () => $('#expForm').classList.toggle('hidden'));
  $('#expForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const amount = C.parseAmount(f.get('amount'));
    if (!amount) return toast('Укажите сумму');
    state.expected.push({
      id: uid('ex_'),
      code: f.get('code').trim(),
      payer: f.get('payer').trim(),
      project: f.get('project').trim(),
      description: f.get('description').trim(),
      amount: Math.abs(amount),
      due: f.get('due') || null,
    });
    e.target.reset();
    save();
    renderAll();
  });
  $('#expClear').addEventListener('click', async () => {
    if (!state.expected.length || !(await ask('Удалить все ожидаемые поступления? Связи операций с ними будут сброшены.', { ok: 'Удалить', danger: true }))) return;
    state.transactions.forEach((t) => {
      if (t.status === 'matched' || t.status === 'review') resetTx(t);
    });
    state.expected = [];
    save();
    renderAll();
  });
  ['expQ', 'expStatus'].forEach((id) => $('#' + id).addEventListener('input', renderExpected));

  function expStatus(e, b) {
    if (b.remaining <= 0.009) return 'paid';
    if (e.due && e.due < today()) return 'overdue';
    if (b.paid > 0) return 'partial';
    return 'open';
  }
  const EXP_STATUS = { paid: 'Оплачен', partial: 'Частично', overdue: 'Просрочен', open: 'Ожидается' };

  function renderExpected() {
    const balances = C.expectedBalances(state.expected, state.transactions);
    const q = $('#expQ').value.toLowerCase().trim();
    const st = $('#expStatus').value;
    const txByExp = {};
    state.transactions.forEach((t) => {
      if (t.status === 'matched' && t.matchId) (txByExp[t.matchId] = txByExp[t.matchId] || []).push(t);
    });
    const all = state.expected.map((e) => ({ e, b: balances[e.id], s: expStatus(e, balances[e.id]) }));
    const totals = { amount: 0, paid: 0, overdue: 0 };
    all.forEach(({ e, b, s }) => {
      totals.amount += e.amount;
      totals.paid += Math.min(b.paid, e.amount);
      if (s === 'overdue') totals.overdue += b.remaining;
    });
    $('#expCards').innerHTML = state.expected.length
      ? [
          ['Ожидается всего', money(totals.amount), `${all.length} позиций`],
          ['Получено', money(totals.paid), `${all.filter((x) => x.s === 'paid').length} оплачено полностью`, 'pos'],
          ['Остаток к получению', money(totals.amount - totals.paid), `${all.filter((x) => x.s === 'partial').length} частично`],
          ['Просрочено', money(totals.overdue), `${all.filter((x) => x.s === 'overdue').length} позиций`, totals.overdue ? 'neg' : ''],
        ]
          .map(([l, v, s, c]) => `<div class="card"><div class="label">${l}</div><div class="value ${c || ''}">${v}</div><div class="small muted">${s}</div></div>`)
          .join('')
      : '';
    const rows = all
      .filter(({ e, s }) => (st ? s === st : true) && (!q || [e.code, e.payer, e.project, e.description].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (a.e.due || '9999') < (b.e.due || '9999') ? -1 : 1);
    $('#expTable').innerHTML = !state.expected.length
      ? '<tr><td class="empty">Список пуст. Загрузите CSV с графиком платежей или счетами — пример в <code>samples/expected-sample.csv</code>.</td></tr>'
      : `<thead><tr><th>Код</th><th>Плательщик</th><th>Проект</th><th>Описание</th><th>Срок</th><th class="num">Сумма</th><th class="num">Получено</th><th class="num">Остаток</th><th>Статус</th><th>Платежи</th><th></th></tr></thead><tbody>` +
        rows
          .map(
            ({ e, b, s }) => `<tr><td><b>${esc(e.code)}</b></td><td>${esc(e.payer)}</td><td>${esc(e.project)}</td><td class="small">${esc(e.description)}</td>
          <td>${fmtDate(e.due)}</td><td class="num">${money(e.amount)}</td><td class="num pos">${b.paid ? money(b.paid) : ''}</td>
          <td class="num${b.remaining < 0 ? ' neg' : ''}" ${b.remaining < 0 ? 'title="Переплата"' : ''}>${money(b.remaining)}</td>
          <td><span class="badge b-${s}">${EXP_STATUS[s]}</span></td>
          <td class="small">${(txByExp[e.id] || []).map((t) => `${fmtDate(t.date)}: ${money(t.amount)}`).join('<br>')}</td>
          <td><button class="link danger" data-del-exp="${esc(e.id)}">удалить</button></td></tr>`
          )
          .join('') +
        (rows.length ? '' : '<tr><td colspan="11" class="empty">Нет позиций по фильтру</td></tr>') +
        '</tbody>';
  }
  $('#expTable').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.delExp;
    if (!id) return;
    state.transactions.forEach((t) => {
      if (t.matchId === id || t.suggestId === id) resetTx(t);
    });
    state.expected = state.expected.filter((x) => x.id !== id);
    save();
    renderAll();
  });
  $('#exportExp').addEventListener('click', () => {
    const balances = C.expectedBalances(state.expected, state.transactions);
    const rows = [['Код', 'Плательщик', 'Проект', 'Описание', 'Срок', 'Сумма', 'Получено', 'Остаток', 'Статус']];
    state.expected.forEach((e) => {
      const b = balances[e.id];
      rows.push([e.code, e.payer, e.project, e.description, e.due || '', e.amount.toFixed(2), b.paid.toFixed(2), b.remaining.toFixed(2), EXP_STATUS[expStatus(e, b)]]);
    });
    download(`ожидаемые_${today()}.csv`, C.toCsv(rows));
  });

  // ---------- 4. Правила и категории ----------

  function renderRules() {
    const fieldL = { any: 'любое поле', description: 'назначение', counterparty: 'контрагент', reference: 'референс' };
    const dirL = { any: 'приход/расход', in: 'приход', out: 'расход' };
    $('#rulesTable').innerHTML = state.rules.length
      ? '<thead><tr><th>#</th><th>Поле</th><th>Содержит</th><th>Направление</th><th>Действие</th><th class="num">Совпадений</th><th></th></tr></thead><tbody>' +
        state.rules
          .map((r, i) => {
            const hits = state.transactions.filter((t) => C.ruleMatches(r, t)).length;
            return `<tr><td>${i + 1}</td><td>${fieldL[r.field] || r.field}</td><td><code>${esc(r.text)}</code></td><td>${dirL[r.direction]}</td>
          <td>${r.action === 'ignore' ? 'игнорировать' : '→ ' + esc(r.category)}</td><td class="num">${hits}</td>
          <td class="row"><button class="link" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button class="link" data-down="${i}" ${
              i < state.rules.length - 1 ? '' : 'disabled'
            }>↓</button><button class="link danger" data-del-rule="${i}">удалить</button></td></tr>`;
          })
          .join('') +
        '</tbody>'
      : '<tr><td class="empty">Правил нет</td></tr>';
    $('#catList').innerHTML = state.categories
      .map((c, i) => {
        const n = state.transactions.filter((t) => t.category === c).length;
        return `<span class="badge b-open" style="padding:4px 10px">${esc(c)} <span class="muted">${n}</span> <button class="link danger" data-del-cat="${i}" title="Удалить">✕</button></span>`;
      })
      .join('');
  }
  $('#ruleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    state.rules.push({
      id: uid('r'),
      text: f.get('text').trim(),
      field: f.get('field'),
      direction: f.get('direction'),
      action: f.get('action'),
      category: f.get('action') === 'ignore' ? '' : f.get('category'),
    });
    e.target.text.value = '';
    save();
    renderRules();
  });
  $('#rulesTable').addEventListener('click', (e) => {
    const d = e.target.dataset || {};
    const r = state.rules;
    if (d.delRule != null) r.splice(Number(d.delRule), 1);
    else if (d.up != null) {
      const i = Number(d.up);
      [r[i - 1], r[i]] = [r[i], r[i - 1]];
    } else if (d.down != null) {
      const i = Number(d.down);
      [r[i + 1], r[i]] = [r[i], r[i + 1]];
    } else return;
    save();
    renderRules();
  });
  $('#catForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (name && !state.categories.includes(name)) state.categories.push(name);
    e.target.reset();
    save();
    renderAll();
  });
  $('#catList').addEventListener('click', async (e) => {
    const i = e.target.dataset && e.target.dataset.delCat;
    if (i == null) return;
    const c = state.categories[Number(i)];
    const n = state.transactions.filter((t) => t.category === c).length;
    if (n && !(await ask(`Категория «${c}» назначена ${n} операциям. Удалить её из списка? (у операций она останется)`, { ok: 'Удалить', danger: true }))) return;
    state.categories.splice(Number(i), 1);
    save();
    renderAll();
  });

  // ---------- Резервная копия / демо ----------

  $('#backupBtn').addEventListener('click', () =>
    download(`bank-payments-backup_${today()}.json`, JSON.stringify(state, null, 1), 'application/json')
  );
  $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.transactions)) throw new Error('это не резервная копия этого приложения');
      if (!(await ask('Заменить текущие данные содержимым резервной копии?', { ok: 'Заменить' }))) return;
      state = load(data);
      save();
      renderAll();
      toast('Данные восстановлены');
    } catch (err) {
      toast('Ошибка: ' + err.message);
    }
  });
  $('#resetBtn').addEventListener('click', async () => {
    if (!(await ask('Удалить все операции, ожидаемые поступления, правила и категории из этого браузера?', { ok: 'Удалить всё', danger: true }))) return;
    state = load({});
    save();
    selected.clear();
    closeDrawer();
    renderAll();
  });

  $('#demoBtn').addEventListener('click', async () => {
    if (state.transactions.length && !(await ask('Добавить демо-данные к текущим?', { ok: 'Добавить' }))) return;
    loadDemo(window.DEMO_STATEMENT, window.DEMO_EXPECTED);
  });
  function loadDemo(st, ex) {
    if (!st) return toast('Демо-файлы не найдены');
    const exp = C.parseExpected(ex);
    const have = new Set(state.expected.map((x) => x.id));
    state.expected.push(...exp.items.filter((x) => !have.has(x.id)));
    const rows = C.parseCsv(st);
    const h = C.findHeaderRow(rows);
    const importId = uid('imp_');
    const res = C.rowsToTransactions(rows.slice(h + 1), C.guessMapping(rows[h]), { account: 'DEMO KBank 000-0-00000-0', source: importId });
    const ids = new Set(state.transactions.map((t) => t.id));
    const fresh = res.transactions.filter((t) => !ids.has(t.id));
    state.transactions.push(...fresh);
    const dates = fresh.map((t) => t.date).sort();
    state.imports.push({ id: importId, source: 'Демо-выписка', account: 'DEMO KBank 000-0-00000-0', at: new Date().toISOString(),
      count: fresh.length, duplicates: res.transactions.length - fresh.length, from: dates[0] || '', to: dates[dates.length - 1] || '' });
    C.applyRules(fresh, state.rules);
    const m = C.autoMatch(state.transactions, state.expected);
    save();
    showTab('tx');
    toast(`Демо: ${fresh.length} операций, сопоставлено ${m.matched}, на проверку ${m.review}`);
  }

  $('#menu').addEventListener('click', (e) => {
    if (e.target.closest('.menu-list button')) $('#menu').open = false;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu')) $('#menu').open = false;
  });
  const setHeaderH = () => document.documentElement.style.setProperty('--header-h', $('header').offsetHeight + 'px');
  window.addEventListener('resize', setHeaderH);
  setHeaderH();
  showTab(currentTab);
})();
