const assert = require('node:assert/strict');
const test = require('node:test');
const { makeApp, memosKey } = require('./helpers.cjs');

function memoEvents(app, date) {
  return app.renderedEvents().filter((event) =>
    event.extendedProps?.kind === 'memo' && event.extendedProps.base === date);
}

test('memos are saved per date, edited, deleted with blank text, and restored', () => {
  const app = makeApp();
  assert.equal(app.saveMemo('2026-09-07', '午前は混雑\n採血室へ連絡'), true);
  assert.equal(app.saveMemo('2026-09-08', '午後は空きあり'), true);
  assert.deepEqual(app.memos(), {
    '2026-09-07': '午前は混雑\n採血室へ連絡',
    '2026-09-08': '午後は空きあり',
  });
  assert.equal(memoEvents(app, '2026-09-07').length, 1);

  assert.equal(app.saveMemo('2026-09-07', '内容を更新'), true);
  assert.equal(app.memos()['2026-09-07'], '内容を更新');
  assert.equal(app.saveMemo('2026-09-07', '   \n '), true);
  assert.equal(app.memos()['2026-09-07'], undefined);
  assert.equal(memoEvents(app, '2026-09-07').length, 0);

  const reloaded = makeApp({ storedMemos: app.storage.memoValue });
  assert.deepEqual(reloaded.memos(), { '2026-09-08': '午後は空きあり' });
});

test('memo event exposes only a fixed label and never renders memo text as a title', () => {
  const app = makeApp({ storedMemos: JSON.stringify({
    '2026-09-07': '<img src=x onerror=alert(1)> 患者メモ',
  }) });
  const [event] = memoEvents(app, '2026-09-07');
  assert.ok(event);
  assert.equal(event.title, 'メモあり');
  assert.equal(JSON.stringify(event).includes('<img'), false);
});

test('a quick second tap on the same date opens its dialog', () => {
  const app = makeApp({ storedMemos: '{"2026-09-07":"既存メモ"}' });
  app.dateClick('2026-09-07', 1000);
  assert.equal(app.node('#memoDialog').open, false);
  app.dateClick('2026-09-07', 1380);
  assert.equal(app.node('#memoDialog').open, true);
  assert.equal(app.node('#memoDate').textContent, '2026-09-07 のメモ');
  assert.equal(app.node('#memoText').value, '既存メモ');
});

test('slow taps or taps on different dates do not open a memo', () => {
  const app = makeApp();
  app.dateClick('2026-09-07', 1000);
  app.dateClick('2026-09-07', 1501);
  assert.equal(app.node('#memoDialog').open, false);
  app.dateClick('2026-09-08', 1600);
  assert.equal(app.node('#memoDialog').open, false);
});

test('the selected-date memo button opens and form submission saves', () => {
  const app = makeApp();
  app.node('#closureDate').value = '2026-10-02';
  app.node('#openMemo').dispatch('click');
  assert.equal(app.node('#memoDialog').open, true);
  app.node('#memoText').value = '予約枠を1枠追加';
  app.node('#memoForm').dispatch('submit');
  assert.equal(app.node('#memoDialog').open, false);
  assert.equal(app.memos()['2026-10-02'], '予約枠を1枠追加');
});

test('cancel closes without saving the draft', () => {
  const app = makeApp({ storedMemos: '{"2026-09-07":"保存済み"}' });
  app.openMemo('2026-09-07');
  app.node('#memoText').value = '未保存の変更';
  app.node('#cancelMemo').dispatch('click');
  assert.equal(app.node('#memoDialog').open, false);
  assert.equal(app.storage.memoValue, '{"2026-09-07":"保存済み"}');
});

test('Escape does not discard a changed draft', () => {
  const app = makeApp();
  app.openMemo('2026-09-07');
  app.node('#memoText').value = 'まだ保存していない';
  const event = app.node('#memoDialog').dispatch('cancel');
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.node('#memoDialog').open, true);
  assert.equal(app.node('#memoText').value, 'まだ保存していない');
  assert.match(app.node('#memoStatus').textContent, /未保存/);
});

test('memo write failure keeps the dialog and draft while closure saving remains usable', () => {
  const app = makeApp();
  app.openMemo('2026-09-07');
  app.node('#memoText').value = '消えてはいけない入力';
  app.storage.failWriteKeys.add(memosKey);
  app.node('#memoForm').dispatch('submit');
  assert.equal(app.node('#memoDialog').open, true);
  assert.equal(app.node('#memoText').value, '消えてはいけない入力');
  assert.equal(app.memos()['2026-09-07'], undefined);
  assert.match(app.node('#memoStatus').textContent, /保存できません/);
  assert.equal(app.save('2026-09-07', true), true);
});

test('corrupt memo data is protected without disabling closure settings', () => {
  const corrupt = '{broken';
  const app = makeApp({ storedMemos: corrupt });
  assert.equal(app.canSaveMemos(), false);
  assert.equal(app.saveMemo('2026-09-07', '上書きしない'), false);
  assert.equal(app.storage.memoValue, corrupt);
  assert.equal(app.save('2026-09-07', true), true);
});

test('saving detects a same-date change from another tab and preserves the draft', () => {
  const app = makeApp({ storedMemos: '{"2026-09-07":"元の内容"}' });
  app.openMemo('2026-09-07');
  app.node('#memoText').value = 'こちらの編集';
  app.storage.values.set(memosKey, '{"2026-09-07":"別タブの編集"}');
  app.node('#memoForm').dispatch('submit');
  assert.equal(app.node('#memoDialog').open, true);
  assert.equal(app.node('#memoText').value, 'こちらの編集');
  assert.match(app.node('#memoStatus').textContent, /別の画面/);
  assert.equal(app.storage.memoValue, '{"2026-09-07":"別タブの編集"}');
});

test('Obsidian export creates an encoded Markdown note without overwrite flags', () => {
  const app = makeApp();
  const uri = app.obsidianUri('2026-09-07', '午前は混雑\n#記号 & 記号');
  assert.ok(uri.startsWith('obsidian://new?'));
  assert.equal(uri.includes('overwrite'), false);
  assert.equal(uri.includes('append'), false);

  const query = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  assert.equal(query.get('name'), '2026-09-07 外来診療メモ');
  assert.equal(query.get('paneType'), 'tab');
  assert.equal(query.get('content'), [
    '---',
    'date: 2026-09-07',
    'source: 外来予約カレンダー',
    '---',
    '',
    '# 2026-09-07 外来診療メモ',
    '',
    '午前は混雑',
    '#記号 & 記号',
    '',
  ].join('\n'));
});

test('Obsidian button exports the current draft without changing its local saved version', () => {
  const app = makeApp({ storedMemos: '{"2026-09-07":"保存済み"}' });
  app.openMemo('2026-09-07');
  app.node('#memoText').value = 'Obsidianだけに送る編集中の内容';
  app.node('#exportObsidian').dispatch('click');
  assert.ok(app.window.location.href.startsWith('obsidian://new?'));
  const query = new URLSearchParams(app.window.location.href.split('?')[1]);
  assert.match(query.get('content'), /Obsidianだけに送る編集中の内容/);
  assert.equal(app.storage.memoValue, '{"2026-09-07":"保存済み"}');
  assert.equal(app.node('#memoDialog').open, true);
});

test('empty or invalid memo content does not launch Obsidian', () => {
  const app = makeApp();
  for (const [date, text] of [
    ['2026-09-07', '   \n'],
    ['2026-02-30', '本文'],
  ]) {
    app.window.location.href = '';
    assert.equal(app.exportMemo(date, text), false);
    assert.equal(app.window.location.href, '');
  }
  assert.match(app.node('#memoStatus').textContent, /入力/);
});
