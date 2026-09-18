/* ビヨンド 予約 LIFF 画面（docs/screen-line.md、spec 7〜9章）
 * 画面は GitHub Pages、データは GAS の doPost と往復する。秘密情報はこのファイルに置かない。 */
(function () {
  'use strict';
  var CFG = window.BEYOND_CONFIG;
  var app = document.getElementById('app');
  var qs = new URLSearchParams(location.search);
  var PAGE = qs.get('p') || 'book';
  var DEV = { key: qs.get('dev') || '', sub: qs.get('sub') || '' };
  var DEBUG = qs.get('debug') === '1';
  var API_LOG = [];
  var T0 = Date.now();
  function logApi(entry) {
    API_LOG.push(entry);
    var t = entry.timing && entry.timing.marks ? entry.timing.marks.map(function (m) { return m.label + ' ' + m.ms; }).join(' / ') : '';
    var fails = entry.fails && entry.fails.length ? ' 失敗:' + entry.fails.join(',') : '';
    console.log('[api] ' + entry.action + (entry.bg ? '(先読み)' : '') + ' 試行' + entry.attempt + fails + ' 往復' + entry.ms + 'ms' + (entry.timing ? ' GAS内' + entry.timing.totalMs + 'ms（' + t + '）' : '') + (entry.error ? ' ERROR ' + entry.error : ''));
    if (DEBUG) renderDebug();
  }
  function renderDebug() {
    var box = document.getElementById('dbg');
    if (!box) { box = document.createElement('div'); box.id = 'dbg'; box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;background:rgba(0,0,0,.8);color:#9f9;font:11px/1.4 monospace;padding:6px 8px;max-height:40vh;overflow:auto;white-space:pre-wrap'; document.body.appendChild(box); }
    box.textContent = API_LOG.slice(-8).map(function (e) {
      var gas = e.timing ? ' gas' + e.timing.totalMs : '';
      var marks = e.timing && e.timing.marks ? ' [' + e.timing.marks.filter(function (m) { return m.ms >= 100; }).map(function (m) { return m.label + m.ms; }).join(' ') + ']' : '';
      var retry = e.attempt > 1 ? ' 再試行' + (e.attempt - 1) + '回(' + (e.fails || []).join(',') + ')' : ' 再試行0';
      var has404 = (e.fails || []).some(function (f) { return f.indexOf('404') >= 0; }) ? ' 404あり' : '';
      return '+' + ((e.at - T0) / 1000).toFixed(1) + 's ' + e.action + (e.bg ? '(先読み)' : '') + retry + has404 + ' 往復' + e.ms + gas + marks + (e.error ? ' !' + e.error : '');
    }).join('\n');
  }
  var S = { idToken: '', linked: [], current: null, contactText: '', deadlineText: '', book: null };
  var WD = ['日', '月', '火', '水', '木', '金', '土'];

  // ---------- 便利関数 ----------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.substring(2), attrs[k]);
      else if (k === 'disabled' || k === 'checked') { if (attrs[k]) el.setAttribute(k, ''); }
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c === null || c === undefined) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function hm(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function ymdToDate(ymd) { var p = ymd.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dispDate(ymd) { var d = ymdToDate(ymd); return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WD[d.getDay()] + '）'; }
  function dispMonth(ym) { return Number(ym.split('-')[1]) + '月'; }
  function todayYmd() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function addMonths(ym, n) { var p = ym.split('-'); var d = new Date(+p[0], +p[1] - 1 + n, 1); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function given() { return S.current ? S.current.given : ''; }

  var WRITE_ACTIONS = ['register', 'confirm', 'cancel'];
  // 本番の呼び出し（画面が待っているもの）と先読みを分ける。
  // 先読みは同時に1本まで。本番の呼び出しが始まったら先読みは中断し、本番が終わるまで新しい先読みは待つ。
  var fgInflight = 0;
  var bgCtl = null;
  var fgWaiters = [];
  function fgDone() { fgInflight--; if (fgInflight <= 0) { fgInflight = 0; var ws = fgWaiters; fgWaiters = []; ws.forEach(function (f) { f(); }); } }
  function whenIdle() { return fgInflight > 0 ? new Promise(function (res) { fgWaiters.push(res); }) : Promise.resolve(); }

  function api(action, params, opts) {
    var bg = !!(opts && opts.background);
    var body = { action: action, params: params || {}, idToken: S.idToken };
    if (DEV.key) { body.devKey = DEV.key; body.devSub = DEV.sub; }
    // 書き込み系は同じ reqId で再試行する（サーバー側で二重実行を防ぐ）
    if (WRITE_ACTIONS.indexOf(action) >= 0) body.reqId = String(Date.now()) + '-' + Math.random().toString(36).substring(2, 10);
    var json = JSON.stringify(body);
    var attempt = 0, fails = [];
    var t0 = Date.now();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (bg) {
      if (bgCtl) { try { bgCtl.abort(); } catch (e) { } }   // 先読みは同時に1本
      bgCtl = ctl;
    } else {
      if (bgCtl) { try { bgCtl.abort(); } catch (e) { } bgCtl = null; }   // 本番が始まったら先読みを中断
      fgInflight++;
    }
    function once() {
      attempt++;
      var status = 0;
      return fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: json, redirect: 'follow', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { status = r.status; return r.text(); })
        .then(function (t) {
          var res;
          try { res = JSON.parse(t); } catch (e) { throw new Error(status ? 'HTTP' + status : 'HTML'); }
          logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: res._timing || null, error: res.ok ? '' : res.error });
          return res;
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError') { logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: null, error: '中断' }); throw e; }
          fails.push(e.message === 'Failed to fetch' ? 'net' : e.message);
          if (attempt < 4) return new Promise(function (res) { setTimeout(res, 1000 * Math.pow(2, attempt - 1)); }).then(once); // 1秒→2秒→4秒
          logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: null, error: e.message });
          return { ok: false, error: '通信に失敗しました。電波の良いところでもう一度お試しください（' + fails.join(',') + '）' };
        });
    }
    var start = bg ? whenIdle() : Promise.resolve();
    var p = start.then(once);
    if (!bg) p.then(fgDone, fgDone);
    else p.then(function () { if (bgCtl === ctl) bgCtl = null; }, function () { if (bgCtl === ctl) bgCtl = null; });
    return p;
  }

  // ---------- 画面の骨組み ----------
  function render(title, bodyEls, footerEls, opts) {
    app.innerHTML = '';
    var who = null;
    if (S.current && !(opts && opts.noWho)) {
      var multi = S.linked.length > 1;
      who = h('div', { class: 'who' }, [
        h('span', {}, [given() + 'さんとして操作中']),
        multi ? h('button', { onclick: showSwitcher }, ['切り替え ▼']) : null,
      ]);
    }
    app.appendChild(h('div', { class: 'header' }, [
      h('div', { class: 'title' }, [h('span', {}, [title]), h('span', { class: 'brand' }, [CFG.schoolName])]),
      who,
    ]));
    app.appendChild(h('div', { class: 'body' }, bodyEls));
    if (footerEls && footerEls.length) app.appendChild(h('div', { class: 'footer' }, footerEls));
    window.scrollTo(0, 0);
  }
  function msg(text, cls) { return h('div', { class: 'msg ' + (cls || 'info') }, [text]); }
  function busy(title, text) { render(title, [h('div', { class: 'loading' }, [text || '処理しています…'])], [], { noWho: false }); }
  function sheet(title, options) {
    var panel = h('div', { class: 'panel' }, [h('h4', {}, [title])].concat(options.map(function (o) {
      return h('button', { class: 'opt' + (o.danger ? ' danger' : ''), onclick: function () { close(); o.onclick(); } }, [o.label]);
    })).concat([h('button', { class: 'btn sub', onclick: function () { close(); } }, ['閉じる'])]));
    var overlay = h('div', { class: 'sheet', onclick: function (e) { if (e.target === overlay) close(); } }, [panel]);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.body.appendChild(overlay);
  }

  function showSwitcher() {
    var opts = S.linked.map(function (s) {
      return { label: s.family + ' ' + s.given + ' さん（' + s.course + '・' + s.store + '）' + (s.id === S.current.id ? ' ✓' : ''), onclick: function () {
        S.current = s; try { localStorage.setItem('beyond.student', s.id); } catch (e) { }
        S.book = null; route();
      } };
    });
    opts.push({ label: '＋ もう1人登録する', onclick: function () { screenRegister(true); } });
    sheet('操作する生徒さんを選ぶ', opts);
  }

  // ---------- 起動 ----------
  function start() {
    var p = DEV.key ? Promise.resolve() : liff.init({ liffId: CFG.liffId }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return new Promise(function () { }); }
      S.idToken = liff.getIDToken() || '';
    });
    p.then(function () {
      console.log('[app] liff 準備 ' + (Date.now() - T0) + 'ms');
      var saved = '';
      try { saved = localStorage.getItem('beyond.student') || ''; } catch (e) { }
      return api('init', { studentId: saved, page: PAGE });
    }).then(function (r) {
      if (!r.ok) { screenError(r.error); return; }
      S.linked = r.linked; S.current = r.current; S.contactText = r.contactText; S.deadlineText = r.deadlineText;
      route({ book: r.book, list: r.list, count: r.count });
    }).catch(function (e) { screenError('もう一度 LINE から開いてください（' + e.message + '）'); });
  }

  /** pre: init に同梱されていた最初の画面のデータ（あれば往復を省く） */
  function route(pre) {
    pre = pre || {};
    if (PAGE === 'contact') return screenContact();
    if (!S.current) return screenRegister(false);
    if (S.current.status === '退会') return screenError('ご利用できる生徒さんがいません。お問い合わせください。');
    if (PAGE === 'list') return screenList(pre.list);
    if (PAGE === 'count') return screenCount(pre.count);
    return startBooking(null, pre.book);
  }

  function screenError(text) {
    render('ビヨンド', [msg(text, 'err'), h('button', { class: 'btn sub', onclick: screenContact }, ['お問い合わせ'])], [], { noWho: true });
  }

  // ---------- 初回登録（画面⓪） ----------
  function screenRegister(additional) {
    var kana = h('input', { type: 'text', placeholder: 'ヤマダ タロウ', autocomplete: 'off' });
    var phone = h('input', { type: 'text', inputmode: 'numeric', placeholder: '09012345678', autocomplete: 'off' });
    var note = h('div');
    var btn = h('button', { class: 'btn', onclick: submit }, ['確認する']);
    function submit() {
      btn.disabled = true; note.innerHTML = '';
      api('register', { kana: kana.value, phone: phone.value }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { note.appendChild(msg(r.error, 'err')); return; }
        S.linked = r.linked; S.current = r.student;
        try { localStorage.setItem('beyond.student', r.student.id); } catch (e) { }
        screenRegisterDone();
      });
    }
    render(additional ? 'もう1人登録する' : 'はじめてのご利用', [
      h('p', {}, ['生徒さんの情報を確認します' + (additional ? '' : '（初回のみ）') + '。']),
      h('div', { class: 'field' }, [h('label', {}, ['お名前（フリガナ）']), kana]),
      h('div', { class: 'field' }, [h('label', {}, ['教室にお届けの電話番号']), phone]),
      btn, note,
      h('p', { class: 'muted small' }, ['※名簿にご登録のフリガナと電話番号を入力してください。ご不明な点はお問い合わせへ。']),
      h('button', { class: 'btn ghost', onclick: screenContact }, ['お問い合わせ']),
    ], [], { noWho: !additional });
  }

  function screenRegisterDone() {
    var s = S.current;
    render('登録が完了しました', [
      h('div', { class: 'card' }, [h('h3', {}, ['✓ ' + s.family + ' ' + s.given + ' さん']), h('div', { class: 'muted' }, [s.course + '・' + s.store])]),
      h('button', { class: 'btn', onclick: function () { S.book = null; route(); } }, ['つづける']),
      h('p', { class: 'muted small' }, ['ご兄弟で同じ LINE をお使いの場合']),
      h('button', { class: 'btn sub', onclick: function () { screenRegister(true); } }, ['もう1人登録する']),
    ]);
  }

  // ---------- 残り回数 ----------
  function screenCount(pre) {
    if (!pre) busy('残り回数', '読み込み中…');
    (pre ? Promise.resolve(pre) : api('count', { studentId: S.current.id })).then(function (r) {
      if (!r.ok) return screenError(r.error);
      var s = r.student;
      render('残り回数', [
        h('div', { class: 'card' }, [
          h('div', { class: 'stat' }, [h('span', {}, ['今月あと']), h('span', {}, [h('b', {}, [String(s.remaining)]), ' 回'])]),
          s.advance > 0 ? h('div', { class: 'muted small' }, ['（来月分から先に使用 ' + s.advance + ' 回）']) : null,
        ]),
        h('h3', {}, ['これからの予約']),
        r.upcoming.length ? h('div', {}, r.upcoming.map(function (b) {
          return h('div', { class: 'card' }, [h('div', {}, [dispDate(b.date) + ' ' + hm(b.start) + '　' + b.teacherName + '先生']), h('div', { class: 'muted small' }, [b.store + '・' + b.course])]);
        })) : h('p', { class: 'muted' }, ['予約はありません']),
        h('button', { class: 'btn sub', onclick: screenList }, ['予約の確認・振替はこちら']),
        h('p', { class: 'muted small' }, ['振替・キャンセルは' + S.deadlineText + 'まで。期限を過ぎると回数を消化します。']),
      ]);
    });
  }

  // ---------- お問い合わせ ----------
  function screenContact() {
    render('お問い合わせ', [
      h('div', { class: 'card', html: (S.contactText || 'ご相談・お問い合わせは、このLINEのトークにメッセージをお送りください。').replace(/\n/g, '<br>') }),
      h('button', { class: 'btn', onclick: function () { if (window.liff && liff.closeWindow) liff.closeWindow(); else history.back(); } }, ['トークに戻る']),
    ], [], { noWho: true });
  }

  // ---------- 予約一覧（画面⑥） ----------
  function screenList(pre) {
    if (!pre) busy('予約の確認・振替', '読み込み中…');
    (pre ? Promise.resolve(pre) : api('list', { studentId: S.current.id })).then(function (r) {
      if (!r.ok) return screenError(r.error);
      S.current = r.student;
      var items = r.bookings.map(function (b) {
        var dl = b.deadline.substring(5, 16).replace('-', '/').replace(' ', ' ');
        return h('div', { class: 'card list-item' }, [
          h('div', { style: 'font-weight:700' }, [dispDate(b.date) + ' ' + hm(b.start) + '　' + b.course.replace(/マンツーマン/, 'マンツーマン')]),
          h('div', { class: 'muted' }, [b.teacherName + '先生・' + b.store]),
          b.editable ? h('div', { class: 'btns' }, [
            h('button', { class: 'btn sub', onclick: function () { startBooking(b); } }, ['振替する']),
            h('button', { class: 'btn sub', onclick: function () { confirmCancel(b); } }, ['キャンセル']),
          ]) : null,
          h('div', { class: 'muted small' }, [b.editable ? '変更は ' + deadlineText(b.deadline) + ' まで' : '変更期限を過ぎています。ご相談はLINEのメッセージでお願いします']),
        ]);
      });
      render('予約の確認・振替', [
        h('div', { class: 'muted small', style: 'margin-bottom:8px' }, ['今月あと ' + r.student.remaining + ' 回']),
        items.length ? h('div', {}, items) : h('p', { class: 'muted' }, ['これからの予約はありません。']),
        msg('期限を過ぎたお申し出は、これまでどおりLINEのメッセージでご相談ください。', 'warn'),
      ]);
    });
  }
  function deadlineText(dt) { var d = new Date(dt.replace(' ', 'T')); return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WD[d.getDay()] + '）' + hm(d.getHours() * 60 + d.getMinutes()); }

  function confirmCancel(b) {
    sheet(dispDate(b.date) + ' ' + hm(b.start) + ' ' + b.teacherName + '先生 の予約をキャンセルします。回数は1回戻ります。よろしいですか？', [
      { label: 'キャンセルする', danger: true, onclick: function () {
        busy('予約の確認・振替');
        api('cancel', { studentId: S.current.id, bookingId: b.id }).then(function (r) {
          if (!r.ok) { render('予約の確認・振替', [msg(r.error, 'err'), h('button', { class: 'btn sub', onclick: screenList }, ['一覧に戻る'])]); return; }
          S.current = r.student;
          render('予約の確認・振替', [msg('キャンセルしました。回数は1回戻ります（今月あと ' + r.student.remaining + ' 回）', 'ok'), h('button', { class: 'btn', onclick: screenList }, ['一覧に戻る'])]);
        });
      } },
    ]);
  }

  // ---------- 予約の流れ（画面②〜⑤） ----------
  function startBooking(original, pre) {
    S.book = { mode: original ? '振替' : '通常', original: original, teacherIds: [], month: '', months: [], wishDates: [], wishBands: [], rows: [], unused: [], n: 0, days: {}, cal: {}, pre: null };
    screenTeachers(pre);
  }

  function screenTeachers(pre) {
    var B = S.book;
    if (!pre) busy(B.mode === '振替' ? '振替：先生を選ぶ' : 'レッスン予約', '読み込み中…');
    (pre ? Promise.resolve(pre) : api('teachers', { studentId: S.current.id, originalId: B.original ? B.original.id : '' })).then(function (r) {
      if (!r.ok) return screenError(r.error);
      B.teachers = r.teachers; B.months = r.months; B.releaseDay = r.releaseDay; B.releaseTime = r.releaseTime;
      if (!B.month) B.month = B.original ? B.original.date.substring(0, 7) : r.months[0];
      if (r.months.indexOf(B.month) < 0) B.month = r.months[0];
      if (!B.teacherIds.length) B.teacherIds = r.preselected.slice();
      if (!r.teachers.length) return screenError('ご予約いただける先生の出勤がありません。お問い合わせください。');
      drawTeachers();
      prefetchCalendar();
    });
  }

  /** 先生選択の裏で、その月の空き状況を先に取り始める（選び終わるころには届いている） */
  var prefetchTimer = null;
  function calKey() { var B = S.book; return B.teacherIds.slice().sort().join(',') + '|' + B.month + '|' + (B.original ? B.original.id : ''); }
  function prefetchCalendar() {
    var B = S.book;
    if (!B.teacherIds.length) return;
    var key = calKey();
    if (B.pre && B.pre.key === key) return;
    var pre = { key: key, promise: null };
    pre.promise = api('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' }, { background: true })
      .catch(function () { if (B.pre === pre) B.pre = null; return null; });
    B.pre = pre;
  }
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(prefetchCalendar, 400);
  }
  function drawTeachers() {
    var B = S.book;
    var all = B.teachers.every(function (t) { return B.teacherIds.indexOf(t.id) >= 0; });
    var cards = [h('div', { class: 'card' + (all ? ' sel' : ''), onclick: function () {
      B.teacherIds = all ? [] : B.teachers.map(function (t) { return t.id; }); drawTeachers(); schedulePrefetch();
    } }, [h('div', { class: 'row' }, [h('div', { class: 'avatar', style: 'background:#5b8bb8' }, ['✦']), h('div', { class: 'grow' }, [h('h3', {}, ['どの先生でもOK']), h('div', { class: 'muted small' }, ['全員を選んだ状態になります'])]), h('div', { class: 'check' }, [all ? '✓' : ''])])])];
    B.teachers.forEach(function (t) {
      var on = B.teacherIds.indexOf(t.id) >= 0;
      cards.push(h('div', { class: 'card' + (on ? ' sel' : ''), onclick: function () {
        if (on) B.teacherIds = B.teacherIds.filter(function (x) { return x !== t.id; }); else B.teacherIds.push(t.id);
        drawTeachers(); schedulePrefetch();
      } }, [h('div', { class: 'row' }, [
        h('div', { class: 'avatar' }, [t.name.charAt(0)]),
        h('div', { class: 'grow' }, [h('h3', {}, [t.name + '先生']), h('div', { class: 'muted small' }, [t.workdays + 'に出勤']), t.message ? h('div', { class: 'small', style: 'color:#2b5d8c' }, ['「' + t.message + '」']) : null]),
        h('div', { class: 'check' }, [on ? '✓' : '']),
      ])]));
    });
    var body = [h('p', {}, ['希望の先生を選んでください']), h('p', { class: 'muted small' }, ['複数選べます。選んだ先生の空きを合わせてご提案します。'])].concat(cards);
    if (B.mode === '振替') body.unshift(msg('振替：' + dispDate(B.original.date) + ' ' + hm(B.original.start) + ' ' + B.original.teacherName + '先生 の予約を別の日時に動かします', 'info'));
    render(B.mode === '振替' ? '振替：先生を選ぶ' : 'レッスン予約', body, [
      h('button', { class: 'btn', disabled: !B.teacherIds.length, onclick: screenCalendar }, ['この先生たちで日を選ぶ']),
      B.mode === '振替' ? h('button', { class: 'btn ghost', onclick: screenList }, ['← 一覧に戻る']) : null,
    ]);
  }

  function screenCalendar() {
    var B = S.book;
    var key = calKey();
    var promise = (B.pre && B.pre.key === key) ? B.pre.promise
      : api('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' });
    if (!(B.pre && B.pre.key === key)) B.pre = { key: key, promise: promise };
    busy('空き状況', '読み込み中…');
    promise.then(function (r) {
      if (!r) {   // 先読みが中断されていたら本番で取り直す
        B.pre = null;
        return api('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r2) {
          if (!r2.ok) return screenError(r2.error);
          B.cal[B.month] = r2; drawCalendar();
        });
      }
      if (!r.ok) { B.pre = null; return screenError(r.error); }
      B.cal[B.month] = r;
      drawCalendar();
    });
  }
  function drawCalendar() {
    var B = S.book, r = B.cal[B.month];
    var names = B.teachers.filter(function (t) { return B.teacherIds.indexOf(t.id) >= 0; }).map(function (t) { return t.name; });
    var title = (names.length > 2 ? names.slice(0, 2).join('・') + ' 他' : names.join('・')) + '先生の空き状況';
    var mi = B.months.indexOf(B.month);
    var selected = B.wishDates.filter(function (d) { return d.substring(0, 7) === B.month; });
    var today = todayYmd();

    var grid = [];
    WD.forEach(function (w) { grid.push(h('div', { class: 'wd' }, [w])); });
    var first = ymdToDate(B.month + '-01');
    for (var i = 0; i < first.getDay(); i++) grid.push(h('div'));
    Object.keys(r.days).sort().forEach(function (ymd) {
      var st = r.days[ymd], on = B.wishDates.indexOf(ymd) >= 0, past = ymd < today || st === 'past';
      var mk = st === 'ok' ? '○' : st === 'few' ? '△' : st === 'full' ? '×' : '';
      var d = h('div', { class: 'd ' + st + (on ? ' on' : '') + (past ? ' past' : ''), onclick: function () {
        if (st === 'none' || st === 'full' || st === 'past' || past) return;
        if (on) B.wishDates = B.wishDates.filter(function (x) { return x !== ymd; }); else B.wishDates.push(ymd);
        drawCalendar();
      } }, [h('span', {}, [String(Number(ymd.substring(8)))]), h('span', { class: 'mk' }, [mk])]);
      grid.push(d);
    });

    var bands = ['午前', '午後', '夕方以降'].map(function (b) {
      var on = B.wishBands.indexOf(b) >= 0;
      return h('button', { class: 'chip' + (on ? ' on' : ''), onclick: function () { B.wishBands = on ? B.wishBands.filter(function (x) { return x !== b; }) : B.wishBands.concat([b]); drawCalendar(); } }, [b]);
    });

    var body = [
      h('button', { class: 'btn ghost', style: 'text-align:left;padding:4px 0', onclick: drawTeachers }, ['← 先生を選び直す']),
      h('div', { class: 'row between' }, [h('div', {}, ['希望日：', h('b', {}, [String(B.wishDates.length)]), '日を選択中']), h('div', {}, ['今月あと ', h('b', {}, [String(S.current.remaining)]), ' 回'])]),
      r.blocked ? msg(r.blocked, 'warn') : null,
      h('div', { class: 'chips' }, [
        h('button', { class: 'chip', onclick: function () { Object.keys(r.days).forEach(function (d) { if ((r.days[d] === 'ok' || r.days[d] === 'few') && d >= today && B.wishDates.indexOf(d) < 0) B.wishDates.push(d); }); drawCalendar(); } }, ['行ける日をすべて選ぶ']),
        h('button', { class: 'chip', onclick: function () { B.wishDates = B.wishDates.filter(function (d) { return d.substring(0, 7) !== B.month; }); drawCalendar(); } }, ['選択をクリア']),
      ]),
      h('div', { class: 'cal-nav' }, [
        h('button', { disabled: mi <= 0, onclick: function () { B.month = B.months[mi - 1]; B.cal[B.month] ? drawCalendar() : screenCalendar(); } }, ['‹']),
        h('span', {}, [B.month.split('-')[0] + '年' + dispMonth(B.month)]),
        h('button', { disabled: mi >= B.months.length - 1, onclick: function () { B.month = B.months[mi + 1]; B.cal[B.month] ? drawCalendar() : screenCalendar(); } }, ['›']),
      ]),
      h('div', { class: 'cal' }, grid),
      h('div', { class: 'legend' }, ['○ 空きあり　△ 残りわずか　× 満席　印なし＝出勤なし']),
      h('div', { class: 'muted small' }, ['時間帯の希望（任意）']),
      h('div', { class: 'chips' }, bands),
      B.months.length === 1 ? h('p', { class: 'muted small' }, ['翌月分の予約は ' + B.releaseDay + '日 ' + B.releaseTime + ' から受け付けます']) : null,
    ];
    render(title, body, [
      h('button', { class: 'btn', disabled: !selected.length || !!r.blocked, onclick: screenProposal }, ['この希望から提案してもらう']),
    ]);
  }

  function screenProposal() {
    var B = S.book;
    B.wishDates = B.wishDates.filter(function (d) { return d.substring(0, 7) === B.month; });
    busy('ご提案', '空きを探しています…');
    api('propose', { studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
      if (!r.ok) { render('ご提案', [msg(r.error, 'err'), h('button', { class: 'btn sub', onclick: drawCalendar }, ['← 希望日を選び直す'])]); return; }
      B.rows = r.rows; B.unused = r.unusedWishDates; B.n = r.n; B.short = r.message; S.current = r.student;
      drawProposal();
    });
  }
  function drawProposal() {
    var B = S.book;
    var items = B.rows.map(function (row, i) {
      return h('div', { class: 'card' }, [h('div', { class: 'prop' }, [
        h('div', { class: 'grow' }, [
          h('div', { class: 'when' }, [dispDate(row.date) + ' ' + hm(row.start) + '〜' + hm(row.end)]),
          h('div', { class: 'muted small' }, [row.teacherName + '先生・' + row.store]),
          row.reason ? h('div', { class: 'why' }, [row.reason]) : null,
          row.changed ? h('div', { class: 'changed' }, ['変更済み']) : null,
        ]),
        h('button', { class: 'btn small sub', onclick: function () { changeMenu(i); } }, ['変更']),
      ])]);
    });
    var body = [
      h('button', { class: 'btn ghost', style: 'text-align:left;padding:4px 0', onclick: drawCalendar }, ['← 希望日を選び直す']),
      h('p', {}, [B.mode === '振替' ? '振替先としてこの回をご提案します' : 'ご希望の' + B.wishDates.length + '日から、この' + B.rows.length + '回をご提案します']),
      B.short ? msg(B.short, 'warn') : null,
    ].concat(items).concat([h('p', { class: 'muted small' }, ['「変更」を押すと、その日の別の時間・別の先生や、選ばれなかった候補日と入れ替えられます。'])]);
    render('ご提案', body, [h('button', { class: 'btn', disabled: !B.rows.length, onclick: screenConfirm }, [B.mode === '振替' ? 'この回に振り替える' : 'この' + B.rows.length + '回で予約する'])]);
  }

  function changeMenu(i) {
    var B = S.book, row = B.rows[i];
    var opts = [
      { label: 'この日の別の時間', onclick: function () { alternatives('times', i); } },
    ];
    if (B.unused.length) opts.push({ label: '別の候補日と入れ替える', onclick: function () { swapMenu(i); } });
    if (B.teacherIds.length > 1) opts.push({ label: '別の先生で', onclick: function () { alternatives('teachers', i); } });
    if (B.mode !== '振替') opts.push({ label: 'この回はいらない', danger: true, onclick: function () {
      B.rows.splice(i, 1);
      if (!B.rows.length) { render('ご提案', [msg('予約する回がありません。希望日を選び直してください。', 'warn'), h('button', { class: 'btn', onclick: drawCalendar }, ['← 希望日を選び直す'])]); return; }
      drawProposal();
    } });
    sheet(dispDate(row.date) + ' ' + hm(row.start) + ' を変更', opts);
  }
  function alternatives(kind, i) {
    var B = S.book;
    busy('ご提案', '別の候補を探しています…');
    api('alternatives', { kind: kind, index: i, rows: B.rows, studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
      drawProposal();
      if (!r.ok) { sheet(r.error, []); return; }
      if (!r.options.length) { sheet(kind === 'times' ? 'この日に他の空き時間はありません' : 'この日に空きのある他の先生はいません', []); return; }
      sheet(kind === 'times' ? 'この日の別の時間' : '別の先生で', r.options.map(function (o) {
        return { label: (kind === 'teachers' ? o.teacherName + '先生　' : '') + hm(o.start) + '〜' + hm(o.end) + (o.reason ? '　' + o.reason : ''), onclick: function () {
          var cur = B.rows[i]; if (B.wishDates.indexOf(cur.date) >= 0 && cur.date !== o.date && B.unused.indexOf(cur.date) < 0) B.unused.push(cur.date);
          o.changed = true; B.rows[i] = o; B.unused = B.unused.filter(function (d) { return d !== o.date; }); drawProposal();
        } };
      }));
    });
  }
  function swapMenu(i) {
    var B = S.book;
    sheet('別の候補日と入れ替える', B.unused.slice().sort().map(function (d) {
      return { label: dispDate(d), onclick: function () {
        busy('ご提案', '空きを探しています…');
        api('alternatives', { kind: 'swap', index: i, newDate: d, rows: B.rows, studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
          drawProposal();
          if (!r.ok) { sheet(r.error, []); return; }
          var cur = B.rows[i]; if (B.wishDates.indexOf(cur.date) >= 0 && B.unused.indexOf(cur.date) < 0) B.unused.push(cur.date);
          B.rows[i] = r.row; B.unused = B.unused.filter(function (x) { return x !== d; }); drawProposal();
        });
      } };
    }));
  }

  function screenConfirm() {
    var B = S.book;
    var memo = h('textarea', { placeholder: '例：来月から木曜希望です' });
    var rows = B.rows.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; });
    var lines = rows.map(function (r) { return h('div', {}, [dispDate(r.date) + ' ' + hm(r.start) + '〜' + hm(r.end) + '　' + r.teacherName + '先生・' + r.store]); });
    var body = [h('p', {}, ['この内容でよろしいですか？'])];
    if (B.mode === '振替') {
      body.push(h('div', { class: 'card' }, [h('div', { class: 'muted small' }, ['元の予約']), h('div', {}, [dispDate(B.original.date) + ' ' + hm(B.original.start) + '　' + B.original.teacherName + '先生']), h('div', { style: 'text-align:center;color:#2b5d8c' }, ['↓']), h('div', { class: 'muted small' }, ['新しい予約']), lines[0]]));
      body.push(h('p', { class: 'muted small' }, ['回数は動きません（1回消えて1回入るため）。']));
    } else {
      body.push(h('div', { class: 'card' }, lines.concat([h('div', { class: 'row between', style: 'margin-top:8px' }, [h('span', {}, ['使う回数']), h('b', {}, [rows.length + '回（残り ' + S.current.remaining + ' → ' + Math.max(0, S.current.remaining - rows.length) + '）'])])])));
      body.push(h('div', { class: 'field' }, [h('label', {}, ['ご要望・ご相談（任意。運営に届きます。予約内容には反映されません）']), memo]));
    }
    body.push(msg('振替・キャンセルは' + S.deadlineText + 'までです。それ以降は回数を消化します。', 'warn'));
    render('予約内容の確認', body, [
      h('button', { class: 'btn', onclick: function () { doConfirm(rows, memo.value); } }, [B.mode === '振替' ? '振替を確定する' : 'この内容で予約する']),
      h('button', { class: 'btn ghost', onclick: drawProposal }, ['← 提案に戻る']),
    ]);
  }
  function doConfirm(rows, memoText) {
    var B = S.book;
    busy('予約内容の確認', '予約しています…（カレンダーに書き込むため少し時間がかかります）');
    api('confirm', { studentId: S.current.id, rows: rows, memo: memoText, originalId: B.original ? B.original.id : '' }).then(function (r) {
      if (!r.ok) {
        var body = [msg(r.error, 'err')];
        if (r.recheck && r.recheck.failed && r.recheck.failed.length) body.push(h('p', { class: 'muted small' }, ['埋まってしまった回：' + r.recheck.failed.map(function (f) { return dispDate(rows[f.index].date) + ' ' + hm(rows[f.index].start); }).join('、')]));
        body.push(h('button', { class: 'btn', onclick: drawProposal }, ['← 提案に戻って選び直す']));
        render('予約内容の確認', body); return;
      }
      S.current = r.student;
      if (r.transfer) {
        render('振替が完了しました', [msg('振替しました。', 'ok'), h('div', { class: 'card' }, [dispDate(r.booking.date) + ' ' + hm(r.booking.start) + '〜' + hm(r.booking.end) + '　' + r.booking.teacherName + '先生・' + r.booking.store]),
          h('button', { class: 'btn', onclick: screenList }, ['予約の確認・振替へ'])]);
        return;
      }
      var okRows = r.results.filter(function (x) { return x.ok; }), ng = r.results.filter(function (x) { return !x.ok; });
      render('予約が完了しました', [
        okRows.length ? msg(okRows.length + '回分を予約しました。', 'ok') : null,
        h('div', { class: 'card' }, okRows.map(function (x) { var tr = rows.filter(function (q) { return q.date === x.date && q.start === x.start; })[0]; return h('div', {}, [dispDate(x.date) + ' ' + hm(x.start) + '　' + (tr ? tr.teacherName + '先生' : '')]); })),
        ng.length ? msg('登録できなかった回があります：' + ng.map(function (x) { return dispDate(x.date) + ' ' + hm(x.start); }).join('、') + '\nもう一度予約画面からお試しください。', 'warn') : null,
        h('div', { class: 'stat' }, [h('span', {}, ['今月あと']), h('span', {}, [h('b', {}, [String(r.student.remaining)]), ' 回'])]),
        h('button', { class: 'btn', onclick: screenList }, ['予約の確認・振替へ']),
        h('button', { class: 'btn sub', onclick: function () { if (window.liff && liff.closeWindow) liff.closeWindow(); } }, ['閉じる']),
      ]);
    });
  }

  start();
})();
