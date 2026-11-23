const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../core.js');

test('parseAmount: разные форматы', () => {
  assert.strictEqual(C.parseAmount('1,234.56'), 1234.56);
  assert.strictEqual(C.parseAmount('1 234,56'), 1234.56);
  assert.strictEqual(C.parseAmount('1.234,56'), 1234.56);
  assert.strictEqual(C.parseAmount('(500.00)'), -500);
  assert.strictEqual(C.parseAmount('500.00-'), -500);
  assert.strictEqual(C.parseAmount('-500'), -500);
  assert.strictEqual(C.parseAmount('500 DR'), -500);
  assert.strictEqual(C.parseAmount('500 CR'), 500);
  assert.strictEqual(C.parseAmount('฿ 1,000'), 1000);
  assert.strictEqual(C.parseAmount('12,5'), 12.5);
  assert.strictEqual(C.parseAmount(''), null);
  assert.strictEqual(C.parseAmount('abc'), null);
});

test('parseDate: dmy, iso, буддийский год, месяцы словами', () => {
  assert.strictEqual(C.parseDate('02/11/2026'), '2026-11-02');
  assert.strictEqual(C.parseDate('02/11/2026', 'mdy'), '2026-02-11');
  assert.strictEqual(C.parseDate('2026-11-02'), '2026-11-02');
  assert.strictEqual(C.parseDate('02.11.26'), '2026-11-02');
  assert.strictEqual(C.parseDate('02/11/2569'), '2026-11-02');
  assert.strictEqual(C.parseDate('15-Jan-2026'), '2026-01-15');
  assert.strictEqual(C.parseDate('15 ม.ค. 2569'), '2026-01-15');
  assert.strictEqual(C.parseDate('15 января 2026'), '2026-01-15');
  assert.strictEqual(C.parseDate('31/02/2026'), null);
  assert.strictEqual(C.parseDate(46000), '2025-12-09');
});

test('parseCsv: кавычки, разделители, BOM', () => {
  assert.deepStrictEqual(C.parseCsv('﻿a;b\n"x;1";"he said ""hi"""\n'), [['a', 'b'], ['x;1', 'he said "hi"']]);
  assert.deepStrictEqual(C.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(C.parseCsv('a,b\r\n"1,000.00",2\r\n'), [['a', 'b'], ['1,000.00', '2']]);
});

test('codeRegex: B-1204 находит варианты написания, но не длиннее', () => {
  const re = C.codeRegex('B-1204');
  assert.ok(re.test('unit b1204 inst'));
  assert.ok(re.test('UNIT B 1204'));
  assert.ok(re.test('B-1204'));
  assert.ok(!re.test('B-12045'));
  assert.ok(!re.test('AB1204'));
});

function loadSample() {
  const st = fs.readFileSync(path.join(__dirname, '../samples/statement-sample.csv'), 'utf8');
  const ex = fs.readFileSync(path.join(__dirname, '../samples/expected-sample.csv'), 'utf8');
  const rows = C.parseCsv(st);
  const h = C.findHeaderRow(rows);
  const mapping = C.guessMapping(rows[h]);
  return { rows, h, mapping, ex: C.parseExpected(ex) };
}

test('пример выписки: заголовок и колонки распознаются', () => {
  const { rows, h, mapping } = loadSample();
  assert.strictEqual(rows[h][0], 'Date');
  assert.deepStrictEqual(mapping, ['date', 'time', 'description', 'debit', 'credit', 'balance', 'channel', 'details']);
});

test('пример выписки: транзакции, итоговые строки пропускаются, дубли не схлопываются', () => {
  const { rows, h, mapping } = loadSample();
  const { transactions, errors } = C.rowsToTransactions(rows.slice(h + 1), mapping, { account: 'X' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(transactions.length, 15); // Beginning Balance без суммы пропущен
  const inSum = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outSum = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  assert.strictEqual(inSum, 1160000);
  assert.strictEqual(Math.round(outSum * 100) / 100, -4185785.5);
  assert.strictEqual(new Set(transactions.map((t) => t.id)).size, 15);
  // повторный импорт даёт те же id → дедупликация
  const again = C.rowsToTransactions(rows.slice(h + 1), mapping, { account: 'X' }).transactions;
  assert.deepStrictEqual(again.map((t) => t.id), transactions.map((t) => t.id));
});

test('сопоставление: уверенные — автоматически, сомнительные — на проверку', () => {
  const { rows, h, mapping, ex } = loadSample();
  assert.deepStrictEqual(ex.errors, []);
  assert.strictEqual(ex.items.length, 8);
  const { transactions } = C.rowsToTransactions(rows.slice(h + 1), mapping, { account: 'X' });
  const stats = C.autoMatch(transactions, ex.items);
  const byDetail = (s) => transactions.find((t) => t.description.includes(s));
  const code = (t) => (ex.items.find((e) => e.id === (t.matchId || t.suggestId)) || {}).code;

  assert.strictEqual(byDetail('SOMCHAI').status, 'matched');
  assert.strictEqual(code(byDetail('SOMCHAI')), 'B-1204');
  assert.strictEqual(code(byDetail('NARIN')), 'A-0507'); // A0507 без дефиса
  assert.strictEqual(byDetail('NARIN').status, 'matched');
  assert.strictEqual(code(byDetail('JOHN SMITH')), 'C-0310');
  // имя + сумма + дата, но без кода — на проверку
  assert.strictEqual(code(byDetail('MR LI WEI')), 'C-1101');
  assert.strictEqual(byDetail('MR LI WEI').status, 'review');
  // без кода, сумма совпадает у нескольких — только предложение
  const kanya = byDetail('KANYA');
  assert.strictEqual(kanya.status, 'review');
  assert.strictEqual(code(kanya), 'A-0215');
  // частичная оплата с кодом "B 0811"
  assert.strictEqual(code(byDetail('TANAKA')), 'B-0811');
  // неизвестный платёж остаётся новым
  assert.strictEqual(byDetail('UNKNOWN').status, 'new');
  // расходы не сопоставляются
  assert.ok(transactions.filter((t) => t.amount < 0).every((t) => t.status === 'new'));
  assert.deepStrictEqual(stats, { matched: 3, review: 3 });
});

test('остатки: оплаченная позиция больше не предлагается', () => {
  const ex = [{ id: 'e1', code: 'B-1204', payer: 'A', amount: 100, due: null }];
  const tx = [
    { id: 't1', date: '2026-01-01', amount: 100, description: 'B-1204', counterparty: '', reference: '', status: 'new' },
    { id: 't2', date: '2026-01-02', amount: 100, description: 'B-1204', counterparty: '', reference: '', status: 'new' },
  ];
  C.autoMatch(tx, ex);
  assert.strictEqual(tx[0].status, 'matched');
  assert.strictEqual(tx[1].status, 'new');
  assert.deepStrictEqual(C.expectedBalances(ex, tx).e1, { paid: 100, remaining: 0 });
});

test('правила: подстрока и регулярное выражение, направление', () => {
  const tx = [
    { amount: -35, description: 'TRANSFER FEE', counterparty: '', reference: '', channel: '', status: 'new', category: '' },
    { amount: 35, description: 'fee refund', counterparty: '', reference: '', channel: '', status: 'new', category: '' },
    { amount: -10, description: 'PEA ELECTRICITY', counterparty: '', reference: '', channel: '', status: 'new', category: '', locked: true },
  ];
  const rules = [
    { text: '/fee/', field: 'any', direction: 'out', action: 'categorize', category: 'Комиссия банка' },
    { text: 'electricity', field: 'any', direction: 'any', action: 'categorize', category: 'Коммунальные' },
  ];
  assert.strictEqual(C.applyRules(tx, rules), 1);
  assert.strictEqual(tx[0].category, 'Комиссия банка');
  assert.strictEqual(tx[0].status, 'done');
  assert.strictEqual(tx[1].category, '');
  assert.strictEqual(tx[2].category, ''); // ручная правка не перезаписывается
});

test('toCsv: экранирование и BOM для Excel', () => {
  assert.strictEqual(C.toCsv([['a', 'b,c'], ['x"y', 1]]), '﻿a,"b,c"\r\n"x""y",1');
});
