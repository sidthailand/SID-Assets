/*
 * Ядро обработки банковских выписок: разбор CSV, распознавание колонок,
 * нормализация дат/сумм, правила категорий и сопоставление поступлений
 * с ожидаемыми платежами. Без зависимостей; работает в браузере и в Node.
 */
(function (root) {
  'use strict';

  // ---------- CSV ----------

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestScore = -1;
    for (const d of candidates) {
      const counts = lines.map((l) => splitCsvLine(l, d).length);
      const max = Math.max(...counts, 0);
      if (max < 2) continue;
      // предпочитаем разделитель, дающий много одинаковых по ширине строк
      const same = counts.filter((c) => c === max).length;
      const score = same * max;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  function splitCsvLine(line, d) {
    return parseCsv(line, d)[0] || [];
  }

  function parseCsv(text, delimiter) {
    text = String(text || '').replace(/^﻿/, '');
    const d = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field.trim() === '') {
        inQuotes = true;
        field = '';
      } else if (c === d) {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows
      .map((r) => r.map((v) => v.trim()))
      .filter((r) => r.some((v) => v !== ''));
  }

  // ---------- Колонки ----------

  const FIELD_KEYWORDS = {
    date: ['date', 'дата', 'วันที่', 'txn date', 'transaction date', 'value date', 'posting date', 'วันที่ทำรายการ'],
    time: ['time', 'время', 'เวลา'],
    amount: ['amount', 'сумма', 'จำนวนเงิน', 'จำนวน', 'sum'],
    debit: ['debit', 'withdrawal', 'withdraw', 'расход', 'списание', 'дебет', 'ถอน', 'เดบิต', 'จ่าย', 'out'],
    credit: ['credit', 'deposit', 'приход', 'поступление', 'зачисление', 'кредит', 'ฝาก', 'เครดิต', 'รับ', 'in'],
    balance: ['balance', 'остаток', 'баланс', 'ยอดคงเหลือ', 'คงเหลือ'],
    description: ['description', 'narrative', 'назначение', 'описание', 'รายละเอียด', 'รายการ', 'memo', 'particulars', 'remark'],
    counterparty: ['counterparty', 'payer', 'payee', 'name', 'контрагент', 'плательщик', 'получатель', 'ชื่อ', 'ผู้โอน', 'from/to'],
    details: ['details', 'detail', 'детали', 'дополнительно', 'additional info', 'รายละเอียดเพิ่มเติม', 'note'],
    reference: ['reference', 'ref', 'номер', 'документ', 'cheque', 'chq', 'เลขที่', 'อ้างอิง', 'transaction id'],
    currency: ['currency', 'валюта', 'สกุลเงิน', 'ccy'],
    channel: ['channel', 'канал', 'ช่องทาง', 'type', 'тип'],
  };

  const FIELD_LABELS = {
    '': '— не использовать —',
    date: 'Дата',
    time: 'Время',
    amount: 'Сумма (±)',
    debit: 'Расход (списание)',
    credit: 'Приход (зачисление)',
    balance: 'Остаток',
    description: 'Назначение / описание',
    details: 'Доп. детали (к назначению)',
    counterparty: 'Контрагент',
    reference: 'Номер / референс',
    currency: 'Валюта',
    channel: 'Канал / тип',
  };

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[_\-.:()]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function scoreHeaderCell(cell, field) {
    const c = norm(cell);
    if (!c) return 0;
    let best = 0;
    for (const k of FIELD_KEYWORDS[field]) {
      if (c === k) best = Math.max(best, 3);
      else if (k.length > 2 && c.includes(k)) best = Math.max(best, 2);
      else if (k.length <= 2 && c.split(' ').includes(k)) best = Math.max(best, 1);
    }
    return best;
  }

  /** Ищет строку заголовка среди первых строк (у банков бывает «шапка» выписки). */
  function findHeaderRow(rows) {
    let bestIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      let score = 0;
      for (const cell of rows[i]) {
        let m = 0;
        for (const f of Object.keys(FIELD_KEYWORDS)) m = Math.max(m, scoreHeaderCell(cell, f));
        score += m;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestScore >= 3 ? bestIdx : -1;
  }

  function guessMapping(header) {
    const mapping = header.map(() => '');
    const used = new Set();
    // жадно: самые уверенные совпадения первыми
    const pairs = [];
    header.forEach((cell, i) => {
      for (const f of Object.keys(FIELD_KEYWORDS)) {
        const s = scoreHeaderCell(cell, f);
        if (s) pairs.push({ i, f, s });
      }
    });
    pairs.sort((a, b) => b.s - a.s);
    for (const p of pairs) {
      if (mapping[p.i] || used.has(p.f)) continue;
      mapping[p.i] = p.f;
      used.add(p.f);
    }
    return mapping;
  }

  // ---------- Значения ----------

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
    'ม.ค': 1, 'ก.พ': 2, 'มี.ค': 3, 'เม.ย': 4, 'พ.ค': 5, 'มิ.ย': 6, 'ก.ค': 7, 'ส.ค': 8, 'ก.ย': 9, 'ต.ค': 10, 'พ.ย': 11, 'ธ.ค': 12,
  };

  function fixYear(y) {
    y = Number(y);
    if (y < 100) y += y > 70 ? 1900 : 2000; // двузначный
    if (y > 2400) y -= 543; // буддийский календарь (Таиланд)
    return y;
  }

  function iso(y, m, d) {
    y = fixYear(y);
    m = Number(m);
    d = Number(d);
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /**
   * Дата в ISO (YYYY-MM-DD). По умолчанию день идёт первым (dd/mm/yyyy),
   * как в выписках тайских и российских банков. order: 'dmy' | 'mdy'.
   */
  function parseDate(value, order) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && value > 20000 && value < 80000) {
      // серийный номер даты Excel
      const dt = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return dt.toISOString().slice(0, 10);
    }
    const s = String(value).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return iso(m[1], m[2], m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) return order === 'mdy' ? iso(m[3], m[1], m[2]) : iso(m[3], m[2], m[1]);
    m = s.match(/^(\d{1,2})[\s\-/]+([A-Za-zА-Яа-яก-๙.]+?)\.?[\s\-/,]+(\d{2,4})/);
    if (m) {
      const key = m[2].toLowerCase().replace(/\.$/, '').slice(0, m[2].match(/[ก-๙]/) ? 5 : 3);
      const mon = MONTHS[key];
      if (mon) return iso(m[3], mon, m[1]);
    }
    return null;
  }

  /** Число из банковской строки: "1,234.56", "1 234,56", "(500.00)", "500.00-", "500 DR". */
  function parseAmount(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let s = String(value).trim();
    if (!s || s === '-') return null;
    let sign = 1;
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1);
    }
    if (/\b(dr|debit)\b\.?$/i.test(s)) {
      sign = -1;
      s = s.replace(/\b(dr|debit)\b\.?$/i, '');
    } else s = s.replace(/\b(cr|credit)\b\.?$/i, '');
    s = s.replace(/[^\d,.\-+]/g, '');
    if (/-$/.test(s)) {
      sign = -sign;
      s = s.slice(0, -1);
    }
    if (/^-/.test(s)) {
      sign = -sign;
      s = s.slice(1);
    }
    s = s.replace(/^\+/, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      // "1,234" — тысячи; "12,50" — дробная часть
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length !== 3) s = parts.join('.');
      else s = s.replace(/,/g, '');
    }
    if (!s || isNaN(Number(s))) return null;
    return Math.round(sign * Number(s) * 100) / 100;
  }

  function hash(str) {
    // FNV-1a, достаточно для дедупликации строк выписки
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * Превращает строки таблицы в транзакции по заданному сопоставлению колонок.
   * Возвращает { transactions, errors }.
   */
  function rowsToTransactions(rows, mapping, opts) {
    opts = opts || {};
    const transactions = [];
    const errors = [];
    const seen = {};
    const col = (f) => mapping.indexOf(f);
    const idx = {};
    for (const f of Object.keys(FIELD_LABELS)) if (f) idx[f] = col(f);
    if (idx.date < 0) return { transactions, errors: ['Не выбрана колонка с датой'] };
    if (idx.amount < 0 && idx.debit < 0 && idx.credit < 0)
      return { transactions, errors: ['Не выбрана колонка с суммой (или приход/расход)'] };

    rows.forEach((r, n) => {
      const get = (f) => (idx[f] >= 0 ? r[idx[f]] : '');
      const date = parseDate(get('date'), opts.dateOrder);
      let amount = null;
      if (idx.amount >= 0) amount = parseAmount(get('amount'));
      if (amount == null || amount === 0) {
        const cr = parseAmount(get('credit'));
        const dr = parseAmount(get('debit'));
        if (cr) amount = Math.abs(cr);
        else if (dr) amount = -Math.abs(dr);
      }
      if (!date && amount == null) return; // пустая/итоговая строка
      if (!date) {
        errors.push(`Строка ${n + 1}: не распознана дата «${get('date')}»`);
        return;
      }
      if (amount == null || amount === 0) {
        if (!/итог|остаток|сальдо|total|รวม|ยอด|balance|brought forward|carried forward/i.test(r.join(' ')))
          errors.push(`Строка ${n + 1}: не распознана сумма`);
        return;
      }
      const t = {
        date,
        time: get('time') || '',
        amount,
        currency: (get('currency') || opts.currency || 'THB').toUpperCase(),
        description: [get('description'), get('details')].filter(Boolean).join(' · '),
        counterparty: get('counterparty') || '',
        reference: get('reference') || '',
        channel: get('channel') || '',
        balance: idx.balance >= 0 ? parseAmount(get('balance')) : null,
        account: opts.account || '',
      };
      const base = [t.account, t.date, t.time, t.amount, t.description, t.counterparty, t.reference, t.balance].join('|');
      seen[base] = (seen[base] || 0) + 1;
      t.id = 'tx_' + hash(base + '#' + seen[base]);
      t.status = 'new';
      t.category = '';
      t.matchId = '';
      t.note = '';
      t.source = opts.source || '';
      transactions.push(t);
    });
    return { transactions, errors };
  }

  // ---------- Ожидаемые платежи (график / счета) ----------

  const EXPECTED_KEYWORDS = {
    code: ['unit', 'code', 'contract', 'invoice', 'юнит', 'квартира', 'договор', 'счет', 'счёт', 'код', 'ห้อง', 'สัญญา', 'ใบแจ้งหนี้'],
    payer: ['payer', 'customer', 'buyer', 'name', 'клиент', 'плательщик', 'покупатель', 'ลูกค้า', 'ชื่อ'],
    amount: ['amount', 'sum', 'сумма', 'จำนวนเงิน', 'к оплате', 'amount due'],
    due: ['due', 'date', 'срок', 'дата', 'กำหนด', 'วันที่'],
    project: ['project', 'проект', 'โครงการ'],
    description: ['description', 'comment', 'назначение', 'комментарий', 'รายละเอียด', 'installment', 'взнос', 'งวด', 'period'],
  };

  function parseExpected(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { items: [], errors: ['Файл пуст'] };
    const header = rows[0];
    const map = {};
    for (const f of Object.keys(EXPECTED_KEYWORDS)) {
      let best = -1;
      let bestS = 0;
      header.forEach((h, i) => {
        const c = norm(h);
        for (const k of EXPECTED_KEYWORDS[f]) {
          const s = c === k ? 3 : c.includes(k) ? 2 : 0;
          if (s > bestS && !Object.values(map).includes(i)) {
            bestS = s;
            best = i;
          }
        }
      });
      if (best >= 0) map[f] = best;
    }
    const errors = [];
    if (map.code == null) errors.push('Нет колонки с кодом (юнит / договор / счёт)');
    if (map.amount == null) errors.push('Нет колонки с суммой');
    if (errors.length) return { items: [], errors };
    const items = [];
    rows.slice(1).forEach((r, n) => {
      const code = (r[map.code] || '').trim();
      const amount = parseAmount(r[map.amount]);
      if (!code || !amount) {
        errors.push(`Строка ${n + 2}: нет кода или суммы`);
        return;
      }
      const due = map.due != null ? parseDate(r[map.due]) : null;
      const item = {
        code,
        payer: map.payer != null ? r[map.payer] || '' : '',
        project: map.project != null ? r[map.project] || '' : '',
        description: map.description != null ? r[map.description] || '' : '',
        amount: Math.abs(amount),
        due,
      };
      item.id = 'ex_' + hash([item.code, item.amount, item.due, item.description, n].join('|'));
      items.push(item);
    });
    return { items, errors };
  }

  // ---------- Правила ----------

  /**
   * rule: { id, text, field: 'any'|'description'|'counterparty'|'reference',
   *         direction: 'any'|'in'|'out', category, action: 'categorize'|'ignore' }
   */
  function ruleMatches(rule, t) {
    if (!rule.text) return false;
    if (rule.direction === 'in' && t.amount < 0) return false;
    if (rule.direction === 'out' && t.amount > 0) return false;
    const hay =
      rule.field && rule.field !== 'any'
        ? String(t[rule.field] || '')
        : [t.description, t.counterparty, t.reference, t.channel].join(' ');
    const needle = rule.text.trim();
    if (needle.startsWith('/') && needle.lastIndexOf('/') > 0) {
      try {
        const last = needle.lastIndexOf('/');
        return new RegExp(needle.slice(1, last), needle.slice(last + 1) || 'i').test(hay);
      } catch (e) {
        return false;
      }
    }
    return hay.toLowerCase().includes(needle.toLowerCase());
  }

  function applyRules(transactions, rules) {
    let changed = 0;
    for (const t of transactions) {
      if (t.locked) continue;
      for (const r of rules) {
        if (!ruleMatches(r, t)) continue;
        if (r.action === 'ignore') {
          if (t.status !== 'ignored') {
            t.status = 'ignored';
            changed++;
          }
        } else if (r.category && t.category !== r.category) {
          t.category = r.category;
          if (t.status === 'new' && t.amount < 0) t.status = 'done';
          changed++;
        }
        break;
      }
    }
    return changed;
  }

  // ---------- Сопоставление поступлений ----------

  function tokens(s) {
    return norm(s)
      .split(/[^a-zа-яё0-9ก-๙]+/i)
      .filter((w) => w.length >= 3);
  }

  function codeRegex(code) {
    // "B-1204" должен находить "B1204", "B 1204", "b-1204", но не "B-12045"
    const parts = String(code).toLowerCase().split(/[^a-z0-9а-яё]+/i).filter(Boolean);
    if (!parts.length) return null;
    const esc = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('(^|[^a-z0-9а-яё])' + esc.join('[\\s\\-_/.]*') + '(?![a-z0-9а-яё])', 'i');
  }

  function daysBetween(a, b) {
    return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  }

  /** Остаток к оплате по каждому ожидаемому платежу с учётом уже связанных транзакций. */
  function expectedBalances(expected, transactions) {
    const paid = {};
    for (const t of transactions) {
      if (t.matchId && t.status === 'matched' && t.amount > 0) paid[t.matchId] = (paid[t.matchId] || 0) + t.amount;
    }
    const res = {};
    for (const e of expected) {
      const p = Math.round((paid[e.id] || 0) * 100) / 100;
      res[e.id] = { paid: p, remaining: Math.round((e.amount - p) * 100) / 100 };
    }
    return res;
  }

  /** Кандидаты для одной транзакции, отсортированные по убыванию score (0–100). */
  function scoreCandidates(t, expected, balances) {
    if (t.amount <= 0) return [];
    const text = [t.description, t.counterparty, t.reference].join(' ');
    const textTokens = new Set(tokens(text));
    const out = [];
    for (const e of expected) {
      const bal = balances[e.id] || { remaining: e.amount };
      if (bal.remaining <= 0.009 && t.matchId !== e.id) continue;
      let score = 0;
      const reasons = [];
      const re = codeRegex(e.code);
      if (re && re.test(text)) {
        score += 55;
        reasons.push('код в назначении');
      }
      const target = t.matchId === e.id ? e.amount : bal.remaining;
      if (Math.abs(t.amount - target) < 0.01) {
        score += 30;
        reasons.push('сумма совпадает');
      } else if (Math.abs(t.amount - e.amount) < 0.01) {
        score += 25;
        reasons.push('сумма = взнос');
      } else if (t.amount < target && t.amount > target * 0.5) {
        score += 8;
        reasons.push('частичная оплата?');
      }
      const payerTokens = tokens(e.payer);
      if (payerTokens.length) {
        const hits = payerTokens.filter((w) => textTokens.has(w)).length;
        if (hits) {
          score += Math.min(20, Math.round((20 * hits) / payerTokens.length));
          reasons.push('плательщик');
        }
      }
      if (e.due && t.date) {
        const dd = daysBetween(e.due, t.date);
        if (dd <= 7) {
          score += 10;
          reasons.push('дата близко к сроку');
        } else if (dd <= 31) score += 4;
      }
      if (score > 0) out.push({ id: e.id, score: Math.min(100, score), reasons });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Автосопоставление новых поступлений.
   * score ≥ autoThreshold и отрыв от второго ≥ 15 → matched; иначе ≥ reviewThreshold → review.
   */
  function autoMatch(transactions, expected, opts) {
    opts = opts || {};
    const autoT = opts.autoThreshold != null ? opts.autoThreshold : 80;
    const reviewT = opts.reviewThreshold != null ? opts.reviewThreshold : 35;
    const stats = { matched: 0, review: 0 };
    const sorted = transactions
      .filter((t) => t.amount > 0 && (t.status === 'new' || t.status === 'review') && !t.locked)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const t of sorted) {
      const balances = expectedBalances(expected, transactions);
      const c = scoreCandidates(t, expected, balances);
      const top = c[0];
      const second = c[1];
      if (top && top.score >= autoT && (!second || top.score - second.score >= 15)) {
        t.status = 'matched';
        t.matchId = top.id;
        t.matchScore = top.score;
        t.suggestId = '';
        stats.matched++;
      } else if (top && top.score >= reviewT) {
        t.status = 'review';
        t.suggestId = top.id;
        t.matchScore = top.score;
        stats.review++;
      }
    }
    return stats;
  }

  // ---------- Экспорт ----------

  function toCsv(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }

  const api = {
    parseCsv,
    detectDelimiter,
    findHeaderRow,
    guessMapping,
    parseDate,
    parseAmount,
    rowsToTransactions,
    parseExpected,
    ruleMatches,
    applyRules,
    expectedBalances,
    scoreCandidates,
    autoMatch,
    codeRegex,
    toCsv,
    hash,
    FIELD_LABELS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BankCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
