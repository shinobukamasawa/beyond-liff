/* ビヨンド 予約 LIFF 画面（docs/screen-line.md、spec 7〜9章）
 * 画面は GitHub Pages、データは GAS の doPost と往復する。秘密情報はこのファイルに置かない。 */
(function () {
  'use strict';
  var CFG = window.BEYOND_CONFIG;
  var app = document.getElementById('app');
  var qs = new URLSearchParams(location.search);
  var PAGE = qs.get('p') || 'home';   // 入口は1つ（ホーム。2026-09-24 にん決定）。p=book/list/count/contact は古いリンク用に残す
  var DEV = { key: qs.get('dev') || '', sub: qs.get('sub') || '' };
  var DEBUG = qs.get('debug') === '1';
  // 通信の向き先。既定は新しい土台（Supabase の Edge Function。2026-09-23 に切り替え）。?api=gas を付けたときだけ旧環境（GAS）へ。
  // 新しい土台の通し確認が済んだら、既定を入れ替える（docs/supabase-ikou.md）
  var API_URL = (qs.get('api') === 'gas' || !CFG.edgeApiUrl) ? CFG.apiUrl : CFG.edgeApiUrl;
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
    if (!box) {
      box = document.createElement('div'); box.id = 'dbg';
      box.style.cssText = 'position:fixed;right:4px;top:4px;z-index:99;background:rgba(0,0,0,.8);color:#9f9;font:10px/1.4 monospace;padding:4px 6px;max-width:70vw;max-height:45vh;overflow:auto;white-space:pre-wrap;border-radius:6px';
      box.addEventListener('click', function () { box.dataset.open = box.dataset.open === '1' ? '' : '1'; renderDebug(); });
      document.body.appendChild(box);
    }
    var open = box.dataset.open === '1';
    box.textContent = (open ? '▼ 計測（タップで縮小）\n' : '▶ 計測（タップで展開）\n') + API_LOG.slice(open ? -8 : -1).map(function (e) {
      var gas = e.timing ? ' gas' + e.timing.totalMs : '';
      var marks = e.timing && e.timing.marks ? ' [' + e.timing.marks.filter(function (m) { return m.ms >= 100; }).map(function (m) { return m.label + m.ms; }).join(' ') + ']' : '';
      var retry = e.attempt > 1 ? ' 再試行' + (e.attempt - 1) + '回(' + (e.fails || []).join(',') + ')' : ' 再試行0';
      var has404 = (e.fails || []).some(function (f) { return f.indexOf('404') >= 0; }) ? ' 404あり' : '';
      return '+' + ((e.at - T0) / 1000).toFixed(1) + 's ' + e.action + (e.bg ? '(先読み)' : '') + retry + has404 + ' 往復' + e.ms + gas + marks + (e.error ? ' !' + e.error : '');
    }).join('\n');
  }
  var S = { idToken: '', linked: [], current: null, contactText: '', deadlineText: '', book: null, page: '' };   // page：いま出している画面（三本線の「ホームへ」の出し分け）
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
      // 1回の通信は最長25秒（確定は40秒）で打ち切って再試行する。
      // 短く見切らないこと：通信制限中のスマホでは、最初の接続だけで 13〜19 秒かかる（2026-09-19 実測）。
      // 8秒で見切る版を試したら、あと数秒で届く通信を捨ててやり直すことになり、合計33秒に悪化した。
      var limit = action === 'confirm' ? 40000 : 25000;
      var timedOut = false;
      var timer = ctl ? setTimeout(function () { timedOut = true; ctl.abort(); }, limit) : null;
      return fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: json, redirect: 'follow', signal: ctl ? ctl.signal : undefined })
        .finally(function () { if (timer) clearTimeout(timer); })
        .then(function (r) { status = r.status; return r.text(); })
        .then(function (t) {
          var res;
          try { res = JSON.parse(t); } catch (e) { throw new Error(status ? 'HTTP' + status : 'HTML'); }
          // GAS が POST の結果ではなく doGet の応答（{ ok:true, service:'beyond-booking' }）を返してくることがある
          // （2026-09-20 に2回確認。処理は実行されているのに、結果だけが届かない）。ok:true なので、そのまま使うと画面が壊れる。
          // 失敗として出し直す。書き込み系は同じ reqId なので、GAS 側が1回目の結果を返す（二重にはならない）
          if (res && res.service === 'beyond-booking') throw new Error('GET応答');
          logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: res._timing || null, error: res.ok ? '' : res.error });
          return res;
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError' && !timedOut) { logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: null, error: '中断' }); throw e; }
          if (timedOut) { ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null; if (bg) bgCtl = ctl; }
          fails.push(timedOut ? 'timeout' : (e.message === 'Failed to fetch' ? 'net' : e.message));
          if (attempt < 4) return new Promise(function (res) { setTimeout(res, 1000 * Math.pow(2, attempt - 1)); }).then(once); // 1秒→2秒→4秒
          logApi({ at: Date.now(), action: action, bg: bg, attempt: attempt, fails: fails, ms: Date.now() - t0, timing: null, error: e.message });
          // 予約・キャンセルは、結果を受け取れなかっただけで手続きは済んでいることがある。押し直す前に一覧で確かめてもらう
          if (action === 'confirm' || action === 'cancel') return { ok: false, error: '通信に失敗し、結果を確認できませんでした。もう一度押す前に、「予約の確認・振替」で手続きが済んでいないかお確かめください（' + fails.join(',') + '）' };
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
      // 名前と三本線（お問い合わせ／切り替え・もう1人登録／ホームへ。2026-09-24 にん決定）。
      // 1人だけのときは切り替えを出さず「もう1人登録する」だけ（決定 R）
      who = h('div', { class: 'who' }, [given() + 'さんとして操作中']);
    } else if (S.book && S.book.provisional && !(opts && opts.noWho)) {
      who = h('div', { class: 'who' }, [h('span', {}, ['最新の情報を確認しています…'])]);
    }
    // 白いヘッダ（2026-09-24 にん決定。全画面共通）：小さく「レッスン予約 ビヨンド」、大きく画面名、その下に操作中の生徒。右に三本線
    app.appendChild(h('div', { class: 'header' }, [
      // 小さい「レッスン予約 ビヨンド」は出さない（LINE のブラウザが同じ題名を上に出して二重になる。9/24 にん）
      h('div', { class: 'hl' }, [h('div', { class: 'title' }, [title]), who]),
      (S.current && !(opts && opts.noWho)) ? h('button', { class: 'menu-btn', onclick: showMenu, 'aria-label': 'メニュー' }, [h('span', { class: 'ic', html: ICON.menu }), 'メニュー']) : null,
    ]));
    app.appendChild(h('div', { class: 'body' }, bodyEls));
    if (footerEls && footerEls.length) app.appendChild(h('div', { class: 'footer' }, footerEls));
    window.scrollTo(0, 0);
  }
  function msg(text, cls) { return h('div', { class: 'msg ' + (cls || 'info') }, [text]); }
  /** writing：予約の確定・キャンセルなど、書き込みの待ち画面のとき true */
  function busy(title, text, writing) { render(title, [h('div', { class: 'loading' }, [text || '処理しています…'])], [], { noWho: false }); slowHint(writing); }
  // 読み込みが長引いたら、止まっていないことを伝える（通信制限中のスマホでは最初の通信に 15 秒前後かかることがある）。
  // 書き込みのときは「閉じないで」をはっきり書く：Google 側の不調で依頼がまだ届いていないことがあり、
  // そこで閉じられると出し直しが止まって、手続きされないままになる（2026-09-19、キャンセルに 74 秒かかった回で確認）。
  // 受付済みのようには見せない。取り消したつもりで予約が残るのがいちばん困るため。
  var slowTimer = null;
  function slowHint(writing) {
    clearTimeout(slowTimer);
    slowTimer = setTimeout(function () {
      var el = document.querySelector('#app .loading');
      if (el && !el.querySelector('.slow')) el.appendChild(h('div', { class: 'slow muted small', style: 'margin-top:10px' },
        [writing ? '手続き中です。画面を閉じずにお待ちください（1分ほどかかることがあります）。終わるとこの画面に結果が出ます。' : '通信に時間がかかっています。そのままお待ちください。']));
    }, 6000);
  }
  function sheet(title, options) {
    var panel = h('div', { class: 'panel' }, [h('h4', {}, [title])].concat(options.map(function (o) {
      return h('button', { class: 'opt' + (o.danger ? ' danger' : ''), onclick: function () { close(); o.onclick(); } }, [o.label]);
    })).concat([h('button', { class: 'btn sub', onclick: function () { close(); } }, ['閉じる'])]));
    var overlay = h('div', { class: 'sheet', onclick: function (e) { if (e.target === overlay) close(); } }, [panel]);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.body.appendChild(overlay);
  }

  function showSwitcher() {
    if (S.linked.length <= 1) {   // 1人だけ：切り替える相手がいないので、登録の入口だけ
      sheet('ご兄弟で同じ LINE をお使いの場合', [{ label: '＋ もう1人登録する', onclick: function () { screenRegister(true); } }]);
      return;
    }
    var opts = S.linked.map(function (s) {
      return { label: s.family + ' ' + s.given + ' さん（' + s.course + '・' + s.store + '）' + (s.id === S.current.id ? ' ✓' : ''), onclick: function () {
        S.current = s; try { localStorage.setItem('beyond.student', s.id); } catch (e) { }
        S.book = null; route();
      } };
    });
    opts.push({ label: '＋ もう1人登録する', onclick: function () { screenRegister(true); } });
    sheet('操作する生徒さんを選ぶ', opts);
  }
  /** 三本線のメニュー（ヘッダ）。ホーム以外では「ホームへ」を先頭に */
  function showMenu() {
    var opts = [];
    if (S.page !== 'home') opts.push({ label: '⌂ ホームへ', onclick: goHome });
    opts.push({ label: 'お問い合わせ', onclick: screenContact });
    if (S.linked.length > 1) opts.push({ label: 'お子さんを切り替える（いま：' + given() + 'さん）', onclick: showSwitcher });
    else opts.push({ label: '＋ もう1人登録する（ご兄弟で同じ LINE をお使いの場合）', onclick: function () { screenRegister(true); } });
    sheet('メニュー', opts);
  }

  // ---------- 起動 ----------
  // 注意：GAS の Web アプリへ同時に複数の通信を出さないこと。
  // 同時に出すと Google 側が 404 や数十秒の遅延を返すことを実測で確認している（2026-09-18）。
  // 起動時の「空撃ち」や、本番の呼び出しと重なる先読みはしない。
  function start() {
    var saved = '';
    try { saved = localStorage.getItem('beyond.student') || ''; } catch (e) { }
    if (PAGE === 'book') showCachedTeachers(saved);
    var p = DEV.key ? Promise.resolve() : liff.init({ liffId: CFG.liffId }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return new Promise(function () { }); }
      S.idToken = liff.getIDToken() || '';
    });
    p.then(function () {
      console.log('[app] liff 準備 ' + (Date.now() - T0) + 'ms');
      logApi({ at: Date.now(), action: 'liff.init', bg: false, attempt: 1, fails: [], ms: Date.now() - T0, timing: null, error: '' });
      return api('init', { studentId: saved, page: PAGE });
    }).then(function (r) {
      if (!r.ok) { S.book = null; screenError(r.error); return; }
      S.linked = r.linked; S.current = r.current; S.contactText = r.contactText; S.deadlineText = r.deadlineText;
      if (S.current) { try { localStorage.setItem('beyond.student', S.current.id); } catch (e) { } }
      if (S.book && S.book.provisional) return settleProvisional(r.book);
      route({ book: r.book, list: r.list, count: r.count });
    }).catch(function (e) { S.book = null; screenError('もう一度 LINE から開いてください（' + e.message + '）'); });
  }

  // ---------- 先生一覧の先出し ----------
  // 開いた瞬間に、前回の先生一覧で先生選択を出す。裏で init が返ったら最新の内容に差し替える。
  // 端末に覚えるのは先生の名前・出勤曜日と店舗・ひとことだけ（生徒の氏名・残り回数・希望の先生は覚えない）。
  // ひとことも覚えるのは、最新の内容が届いたときにカードの高さが変わって、選んでいる最中に画面がずれるのを防ぐため。
  // 古い一覧に休止した先生が数秒見えることがあるが、init が返れば消え、予約は GAS 側でも弾かれる。
  var TEACHERS_KEY = 'beyond.teachers.v2';
  function saveTeachersCache(studentId, teachers) {
    try {
      localStorage.setItem(TEACHERS_KEY, JSON.stringify({ studentId: studentId, at: Date.now(),
        teachers: teachers.map(function (t) { return { id: t.id, name: t.name, workdays: t.workdays, stores: t.stores || [], message: t.message || '', hasPhoto: !!t.hasPhoto }; }) }));
    } catch (e) { }
  }
  function showCachedTeachers(savedStudentId) {
    var c = null;
    try { c = JSON.parse(localStorage.getItem(TEACHERS_KEY) || 'null'); } catch (e) { }
    if (!c || !savedStudentId || c.studentId !== savedStudentId || !c.teachers || !c.teachers.length) return;
    if (Date.now() - c.at > 30 * 24 * 3600 * 1000) return;   // 1か月以上前の一覧は使わない
    startBookingState(null);
    S.book.provisional = true;
    S.book.teachers = c.teachers;
    drawTeachers();
  }
  /** init が返ったら、先出しの画面を最新の内容に差し替える。選びかけの先生は残す */
  function settleProvisional(pre) {
    var B = S.book, waiting = B.waiting;
    if (!S.current || S.current.status === '退会' || !pre || !pre.ok || !pre.teachers.length) { S.book = null; return route({ book: pre }); }
    B.provisional = false; B.waiting = false;
    applyTeachers(pre);
    if (waiting && B.teacherIds.length) return screenCalendar();
    drawTeachers();
    prefetchCalendar();
    if (!B.pre) loadPhotos();
  }

  /** pre: init に同梱されていた最初の画面のデータ（あれば往復を省く） */
  function route(pre) {
    pre = pre || {};
    if (PAGE === 'contact') return screenContact();
    if (!S.current) return screenRegister(false);
    if (S.current.status === '退会') return screenError('ご利用できる生徒さんがいません。お問い合わせください。');
    if (PAGE === 'list') return screenList(pre.list);
    if (PAGE === 'book') return startBooking(null, pre.book);
    return screenHome(pre.count);   // home・count・それ以外
  }

  /**
   * keepWho：ヘッダの「○○さんとして操作中／切り替え」を残す。
   * 休会中で予約できない、のように「この生徒だから」出るエラーで使う。ヘッダを消すと、兄弟に切り替える手段がなくなって行き止まりになる
   */
  function screenError(text, keepWho, title) {
    render(title || 'ビヨンド', [msg(text, 'err'), h('button', { class: 'btn sub', onclick: screenContact }, ['お問い合わせ'])], [], { noWho: !keepWho });
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
      additional ? h('button', { class: 'btn sub', onclick: function () { S.book = null; route(); } }, ['← 登録せずに戻る']) : null,
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

  /**
   * 休会中の生徒には、残り回数と予約一覧の上に1行出す（2026-09-20 にん決定）。
   * 回数は休会中も保持される（仕様10章）ので、数字だけ見ると「回数があるのに予約できない」と見えるため。
   * 復帰の申請が入っていれば、再開の月を出す（その月の分からは、休会中でも予約できる）
   */
  function kyukaiNote(s) {
    if (!s || s.status !== '休会') return null;
    if (s.requestKind === '復帰' && s.applyMonth) {
      var m = Number(String(s.applyMonth).split('-')[1]);
      return msg('休会中です。' + m + '月から再開予定です（' + m + '月分からご予約できます。回数は保持されています）。', 'info');
    }
    return msg('休会中です。ご予約は再開後にできます（回数は保持されています）。', 'info');
  }

  // ---------- ホーム（残り回数＋これからの予約＋ボタン2つ。2026-09-24 にん決定。見た目はにんのホーム案） ----------
  var ICON = {
    menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    calPlus: '<svg viewBox="0 0 28 28" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="20" height="18" rx="3"/><path d="M3 11h20M9 3v4M17 3v4"/><circle cx="21" cy="21" r="6" fill="#f28c28" stroke="none"/><path d="M21 18v6M18 21h6" stroke="#fff" stroke-width="2.2"/></svg>',
    cal: '<svg viewBox="0 0 28 28" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="22" height="19" rx="3"/><path d="M3 11h22M9 3v4M19 3v4"/><path d="M8 15h2M13 15h2M18 15h2M8 19h2M13 19h2" stroke-width="2.4"/></svg>',
    calSmall: '<svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="22" height="19" rx="3"/><path d="M3 11h22M9 3v4M19 3v4"/><path d="M8 15h2M13 15h2M18 15h2M8 19h2M13 19h2" stroke-width="2.4"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  };
  function inLine() { try { return !!(window.liff && liff.isInClient && liff.isInClient()); } catch (e) { return false; } }
  function dispDateLong(ymd) { var d = ymdToDate(ymd); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）'; }
  function lastDayOf(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  /**
   * 残り回数の2か月分（2026-09-24 にん）。
   * 当月：残り回数（月末まで。使わなかった分は翌月へ）。翌月（解禁後だけ）：翌月分の正規分 − 翌月分から使った分（繰越は足さず注記だけ。当月の残りがまだ動くため）
   */
  function countRows(r) {
    var s = r.student, thisM = r.thisMonth, nextM = r.nextMonth, mc = Number(s.monthlyCount || 0), adv = Number(s.advance || 0);
    var thisLabel = dispMonth(thisM), nextLabel = dispMonth(nextM), eom = Number(thisM.split('-')[1]) + '/' + lastDayOf(thisM);
    var rows = [h('div', { class: 'cnt' }, [h('span', { class: 'm' }, [thisLabel]), h('span', { class: 'n' }, ['あと ', h('b', {}, [String(s.remaining)]), ' 回'])]),
      h('div', { class: 'muted small' }, ['（' + eom + 'まで' + (s.remaining > 0 ? '。使わなかった分は' + nextLabel + 'へ' : '') + '）'])];
    if (r.nextOpen) {
      var n = Math.max(0, mc - adv);
      var note = adv > mc ? '（' + nextLabel + '分' + mc + '回と、' + thisLabel + 'の残りから ' + (adv - mc) + ' 回を予約済み）'
        : '（' + nextLabel + '分' + mc + '回' + (adv > 0 ? 'のうち' + adv + '回は予約済み' : '') + (s.remaining > 0 ? '。' + thisLabel + 'の残りが繰り越されます' : '') + '）';
      rows.push(h('div', { class: 'sep' }));
      rows.push(h('div', { class: 'cnt' }, [h('span', { class: 'm' }, [nextLabel]), h('span', { class: 'n' }, ['あと ', h('b', {}, [String(n)]), ' 回'])]));
      rows.push(h('div', { class: 'muted small' }, [note]));
    }
    return rows;
  }
  /** 解禁前の一行：「12月分の予約は 11月20日（金）9:00 から受け付けます」（設定の解禁日・時刻から） */
  function releaseNote(r) {
    if (r.nextOpen || !r.releaseDay) return null;
    var p = r.thisMonth.split('-'), rel = p[0] + '-' + p[1] + '-' + ('0' + r.releaseDay).slice(-2);
    return msg(dispMonth(r.nextMonth) + '分の予約は ' + dispDateLong(rel) + ' ' + r.releaseTime.replace(/^0/, '') + ' から受け付けます', 'info');
  }
  function screenHome(pre) {
    S.page = 'home';
    if (!pre) busy('ホーム', '読み込み中…');
    (pre ? Promise.resolve(pre) : api('count', { studentId: S.current.id })).then(function (r) {
      if (!r.ok) return screenError(r.error, true);
      var s = r.student;
      S.page = 'home';
      render('ホーム', [
        kyukaiNote(s),
        h('div', { class: 'card counts' }, countRows(r)),
        h('button', { class: 'btn big', onclick: goBook }, [h('span', { class: 'ic', html: ICON.calPlus }), h('span', { class: 'lbl' }, ['レッスンを予約する']), h('span', { class: 'ic', html: ICON.chev })]),
        h('button', { class: 'btn sub big', onclick: goList }, [h('span', { class: 'ic', html: ICON.cal }), h('span', { class: 'lbl' }, ['予約の確認・振替']), h('span', { class: 'ic', html: ICON.chev })]),
        h('h3', { class: 'sec' }, ['これからの予約']),
        r.upcoming.length ? h('div', {}, r.upcoming.map(function (b, i) {
          return h('div', { class: 'card up' }, [
            i === 0 ? h('span', { class: 'badge' }, ['次回']) : null,
            h('div', { class: 'when' }, [dispDateLong(b.date) + ' ' + hm(b.start)]),
            h('div', { class: 'teacher' }, [b.teacherName + '先生']),
            h('div', { class: 'muted' }, [b.store + '・' + b.course]),
            h('div', { class: 'dl' }, [h('span', { class: 'ic', html: ICON.calSmall }), h('div', {}, [h('div', { class: 'muted small' }, ['振替・キャンセル期限']), h('div', { class: 'dlv' }, [deadlineLong(b.deadline) + 'まで'])])]),
          ]);
        })) : (releaseNote(r) || h('p', { class: 'muted' }, ['予約はありません'])),   // 空で解禁前のときだけ、解禁の一行（にん）
        h('p', { class: 'muted small' }, ['期限を過ぎると、レッスン1回分を消化します。']),
      ]);
    });
  }
  function deadlineLong(dt) { var d = new Date(dt.replace(' ', 'T')); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）' + hm(d.getHours() * 60 + d.getMinutes()); }
  function goHome() { S.book = null; screenHome(); }
  /** ホームの「レッスンを予約する」。前回の先生一覧が端末にあれば先に出し、最新の一覧が届いたら差し替える（p=book で開いたときと同じ速さ） */
  function goBook() {
    var id = S.current.id, c = null;
    try { c = JSON.parse(localStorage.getItem(TEACHERS_KEY) || 'null'); } catch (e) { }
    if (!(c && c.studentId === id && c.teachers && c.teachers.length && Date.now() - c.at <= 30 * 24 * 3600 * 1000)) return startBooking(null);
    startBookingState(null);
    S.book.provisional = true; S.book.teachers = c.teachers;
    drawTeachers();
    api('teachers', { studentId: id, originalId: '' }).then(function (r) {
      if (!r.ok) { S.book = null; return screenError(r.error, r.code === 'status', 'レッスン予約'); }
      if (!r.teachers.length) { S.book = null; return screenError('ご予約いただける先生の出勤がありません。お問い合わせください。', true, 'レッスン予約'); }
      settleProvisional(r);
    });
  }

  // ---------- お問い合わせ ----------
  function screenContact() {
    S.page = 'contact';
    render('お問い合わせ', [
      h('div', { class: 'card', html: (S.contactText || 'ご相談・お問い合わせは、このLINEのトークにメッセージをお送りください。').replace(/\n/g, '<br>') }),
      h('button', { class: 'btn', onclick: function () { if (window.liff && liff.closeWindow) liff.closeWindow(); else history.back(); } }, ['トークに戻る']),
      S.current ? h('button', { class: 'btn sub', onclick: goHome }, ['ホームへ']) : null,
    ], [], { noWho: !S.current });
  }

  // ---------- 予約一覧（画面⑥） ----------
  /** ボタンから一覧を開くときはこちら（onclick に screenList を直接渡すと、クリックの情報が pre に入ってしまう） */
  function goList() { screenList(); }
  function screenList(pre) {
    S.page = 'list';
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
        kyukaiNote(r.student),
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
        busy('予約の確認・振替', 'キャンセルしています…', true);
        api('cancel', { studentId: S.current.id, bookingId: b.id }).then(function (r) {
          if (!r.ok) { render('予約の確認・振替', [msg(r.error, 'err'), h('button', { class: 'btn sub', onclick: goList }, ['一覧に戻る'])]); return; }
          S.current = r.student;
          render('予約の確認・振替', [msg('キャンセルしました。回数は1回戻ります（今月あと ' + r.student.remaining + ' 回）', 'ok'), h('button', { class: 'btn', onclick: goList }, ['一覧に戻る'])]);
        });
      } },
    ]);
  }

  // ---------- 予約の流れ（画面②〜⑤） ----------
  function startBookingState(original) {
    S.page = 'book';
    S.book = { mode: original ? '振替' : '通常', original: original, teacherIds: [], month: '', months: [], wishDates: [], wishBands: [], rows: [], unused: [], n: 0, days: {}, cal: {}, pre: null,
      provisional: false, waiting: false, touched: false };
  }
  function startBooking(original, pre) {
    startBookingState(original);
    screenTeachers(pre);
  }

  function screenTeachers(pre) {
    var B = S.book;
    if (!pre) busy(B.mode === '振替' ? '振替：先生を選ぶ' : 'レッスン予約', '読み込み中…');
    (pre ? Promise.resolve(pre) : api('teachers', { studentId: S.current.id, originalId: B.original ? B.original.id : '' })).then(function (r) {
      if (!r.ok) return screenError(r.error, r.code === 'status', 'レッスン予約');
      if (!r.teachers.length) return screenError('ご予約いただける先生の出勤がありません。お問い合わせください。');
      applyTeachers(r);
      drawTeachers();
      prefetchCalendar();
      if (!B.pre) loadPhotos();
    });
  }
  function applyTeachers(r) {
    var B = S.book;
    B.teachers = r.teachers; B.months = r.months; B.releaseDay = r.releaseDay; B.releaseTime = r.releaseTime;
    if (!B.month) {
      B.month = B.original ? B.original.date.substring(0, 7) : r.months[0];
      // 今月の回数を使い切っていて、来月の受付が始まっているなら、最初から来月を開く（2026-09-20 にん決定）。
      // 今月のままだと「すべて予約済みです」と日付のないカレンダーが出て、› で来月へ進めることに気づきにくい
      if (!B.original && r.months.length > 1 && monthUsedUp(r, r.months[0])) { B.month = r.months[1]; B.autoNext = true; }
    }
    if (r.months.indexOf(B.month) < 0) B.month = r.months[0];
    // 先出しの画面で選びかけていたら、その選択を残す（一覧から消えた先生だけ外す）
    if (B.touched) B.teacherIds = B.teacherIds.filter(function (id) { return r.teachers.some(function (t) { return t.id === id; }); });
    else if (!B.teacherIds.length) B.teacherIds = r.preselected.slice();
    if (!B.original) saveTeachersCache(S.current.id, r.teachers);
    planSet(r.plan);
  }

  /** その月に使える回数が残っていないか。計算用データがあれば GAS と同じ式（bookingLimit）で、なければ残り回数で見る */
  function monthUsedUp(r, month) {
    var st = r.plan && r.plan.student;
    if (st && typeof bookingLimit === 'function') return bookingLimit(month, st) <= 0;
    return !!S.current && Number(S.current.remaining) <= 0;
  }

  // ---------- 空き状況・提案・変更を、端末の中で計算する ----------
  // GAS の入口が不安定なので、GAS を通るのは立ち上げ（先生一覧）と確定だけにする（2026-09-20）。
  // 計算は GAS と同じファイル（web/logic/Teian.js は gas/logic/Teian.js の写し）。材料は先生一覧の応答に同梱されてくる（plan）。
  // 材料は届いた時点の写しなので、10分を過ぎたら使わずに GAS に聞く。確定のときは GAS が最新のデータで再チェックする。
  // URL に ?local=0 を付けると、端末内の計算を使わない（比べるとき用）
  var PLAN_MAX_AGE = 10 * 60 * 1000;
  function addDaysYmd(ymd, n) { var p = ymd.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  /**
   * 使える回数の表示（正規分・繰越の内訳つき。にん 9/23）。今月は「今月あと n 回」、翌月は「○月に使える回数 n 回」
   * 内訳は端末内の材料（plan）があるときだけ。なければ回数だけ
   */
  function countLabel(month, limit) {
    var B = S.book, pst = B.plan && B.plan.student, isCur = month === B.months[0];
    var head = isCur ? '今月あと ' : dispMonth(month) + 'に使える回数 ';
    if (pst && typeof countBreakdown === 'function') {
      var booked = B.plan.bookings.filter(function (b) { return b.studentId === pst.id && b.state === '予約中' && b.date.substring(0, 7) === month; }).length;
      var bd = countBreakdown(month, pst, booked);
      return h('div', { style: 'white-space:nowrap' }, [head, h('b', {}, [String(bd.limit)]), ' 回', h('span', { class: 'muted small' }, ['（正規分 ' + bd.regular + '・繰越 ' + bd.carry + '）'])]);
    }
    var n = limit !== undefined ? limit : S.current.remaining;
    return h('div', { style: 'white-space:nowrap' }, [head, h('b', {}, [String(n)]), ' 回']);
  }
  function sortRows() { if (S.book && S.book.rows) S.book.rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; }); }
  function planSet(plan) {
    var B = S.book;
    B.plan = null;
    if (!plan || !plan.student) return;
    var sid = plan.student.id;
    B.plan = {
      builtAt: plan.builtAt, student: plan.student, teachers: plan.teachers, settings: plan.settings,
      slots: plan.slots.map(function (x) { return { date: x[0], teacherId: x[1], store: x[2], start: x[3], end: x[4] }; }),
      bookings: plan.bookings.map(function (x) { return { id: x[0], studentId: x[1] ? sid : '', teacherId: x[2], date: x[3], start: x[4], end: x[5], state: x[6], store: x[7] || '' }; }),
    };
    B.planAt = Date.now();
  }
  function planOk() {
    var B = S.book;
    return !!(B && B.plan && typeof tnPropose === 'function' && typeof bookingLimit === 'function' && qs.get('local') !== '0' && Date.now() - B.planAt < PLAN_MAX_AGE);
  }
  /** いまの日本時間。端末の時計や時差に頼らず、GAS の時刻＋経過で出す */
  function planNow() {
    var B = S.book;
    var d = new Date(B.plan.builtAt + (Date.now() - B.planAt) + 9 * 3600 * 1000);
    var ymd = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
    return { ymd: ymd, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  function planInput(p) {
    var P = S.book.plan;
    var original = p.originalId ? P.bookings.filter(function (b) { return b.id === p.originalId; })[0] || { id: p.originalId } : null;
    return { mode: original ? '振替' : '通常', student: P.student, teacherIds: p.teacherIds || [], teachers: P.teachers,
      wishDates: p.wishDates || [], wishBands: p.wishBands || [], targetMonth: String(p.month), slots: P.slots, bookings: P.bookings,
      original: original, now: planNow(), settings: P.settings };
  }
  function planRow(r) {
    var t = S.book.plan.teachers.filter(function (x) { return x.id === r.teacherId; })[0];
    return { date: r.date, teacherId: r.teacherId, teacherName: t ? t.name : r.teacherId, store: r.store, start: r.start, end: r.end,
      slotStart: r.slotStart, slotEnd: r.slotEnd, reason: r.reason || '', fromWish: r.fromWish !== false, changed: !!r.changed };
  }
  /** GAS の api/Api.js の calendar・propose・alternatives と同じ結果を、端末の中で作る */
  var PLAN_ACTIONS = {
    calendar: function (p) {
      var input = planInput(p), s = input.student, month = String(p.month);
      var pre = tnPrecheck(input);
      if (pre) return { ok: true, month: month, blocked: pre.message, code: pre.code, days: {}, count: 0 };
      var dates = [], ym = month.split('-'), last = new Date(Number(ym[0]), Number(ym[1]), 0).getDate();
      for (var d = 1; d <= last; d++) dates.push(month + '-' + ('0' + d).slice(-2));
      var hasSlot = {};
      input.slots.forEach(function (sl) { if (input.teacherIds.indexOf(sl.teacherId) >= 0 && (!sl.store || sl.store === s.store)) hasSlot[sl.date] = true; });   // 店舗が空の枠＝指定なし（どこでも）
      var perDay = {};
      tnCandidates(input, dates).forEach(function (c) { perDay[c.date] = (perDay[c.date] || 0) + 1; });
      var days = {}, today = input.now.ymd, st = input.settings;
      var closed = function (dt) { var dl = addDaysYmd(dt, -st.minLeadDays); return today > dl || (today === dl && input.now.minutes >= st.minLeadMinutes); };   // 最短受付（前日10:00）を過ぎた日
      dates.forEach(function (dt) { var n = perDay[dt] || 0; days[dt] = dt < today ? 'past' : closed(dt) ? (hasSlot[dt] ? 'closed' : 'none') : n >= 3 ? 'ok' : n > 0 ? 'few' : hasSlot[dt] ? 'full' : 'none'; });
      return { ok: true, month: month, days: days, count: tnCount(input), limit: bookingLimit(month, s) };
    },
    propose: function (p) {
      var r = tnPropose(planInput(p));
      if (!r.ok) return { ok: false, code: r.code, error: r.message };
      return { ok: true, n: r.n, rows: r.rows.map(planRow), unusedWishDates: r.unusedWishDates, short: r.short, message: r.message, student: S.current };
    },
    alternatives: function (p) {
      var input = planInput(p), rows = p.rows || [], idx = Number(p.index);
      if (p.kind === 'times') return { ok: true, options: tnAltTimes(input, rows, idx).map(planRow) };
      if (p.kind === 'swap') { var r = tnSwapDate(input, rows, idx, String(p.newDate)); return r ? { ok: true, row: planRow(r) } : { ok: false, error: 'この日は空きがありません' }; }
      if (p.kind === 'teachers') return { ok: true, options: tnAltTeachers(input, rows, idx).map(planRow) };
      return { ok: false, error: '不明な変更です' };
    },
  };
  /** 端末の中で計算できればそうする。できなければ（材料がない・古い・計算で例外）GAS に聞く */
  function planApi(action, params, opts) {
    if (!planOk() || !PLAN_ACTIONS[action]) return api(action, params, opts);
    var t0 = Date.now();
    try {
      var res = PLAN_ACTIONS[action](params);
      logApi({ at: Date.now(), action: action + '(端末内)', bg: false, attempt: 1, fails: [], ms: Date.now() - t0, timing: null, error: res.ok ? '' : res.error });
      return Promise.resolve(res);
    } catch (e) {
      console.error('[plan] ' + action + ' を端末内で計算できませんでした。GAS に聞きます', e);
      return api(action, params, opts);
    }
  }

  /** 先生選択の裏で、その月の空き状況を先に取り始める（選び終わるころには届いている） */
  var prefetchTimer = null;
  function calKey() { var B = S.book; return B.teacherIds.slice().sort().join(',') + '|' + B.month + '|' + (B.original ? B.original.id : ''); }
  function prefetchCalendar() {
    var B = S.book;
    if (B.provisional || !B.teacherIds.length) return;
    var key = calKey();
    if (B.pre && B.pre.key === key) return;
    var pre = { key: key, promise: null };
    pre.promise = planApi('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' }, { background: true })
      .catch(function () { if (B.pre === pre) B.pre = null; return null; });
    B.pre = pre;
    pre.promise.then(loadPhotos);   // 写真は空き状況の先読みが終わってから（GAS へ同時に通信を出さない）
  }

  /**
   * 先生の写真。先生選択を出したあと、裏で1回だけ取りに行き、届いたら頭文字のアイコンを写真に差し替える（大きさは同じなので画面は動かない）。
   * 覚えるのは開いている間だけ（sessionStorage）。写真が1枚も登録されていなければ通信しない。
   */
  var photoState = 'none';   // none → loading → done
  function loadPhotos() {
    var B = S.book;
    if (photoState !== 'none' || !B || B.provisional || !S.current) return;
    if (!(B.teachers || []).some(function (t) { return t.hasPhoto; })) return;
    try { var saved = JSON.parse(sessionStorage.getItem('beyond.photos') || 'null'); if (saved) { S.photos = saved; photoState = 'done'; paintPhotos(); return; } } catch (e) { }
    if (fgInflight > 0 || bgCtl) return;   // 他の通信が動いている間は出さない。次の先読みのあとでもう一度試す
    photoState = 'loading';
    api('photos', { studentId: S.current.id }, { background: true }).then(function (r) {
      if (!r || !r.ok) { photoState = 'none'; return; }
      S.photos = r.photos || {}; photoState = 'done';
      try { sessionStorage.setItem('beyond.photos', JSON.stringify(S.photos)); } catch (e) { }
      paintPhotos();
    }).catch(function () { photoState = 'none'; });
  }
  function photoStyle(id) { var u = S.photos && S.photos[id]; return u ? 'background-image:url(' + u + ');background-size:cover;background-position:center;color:transparent' : ''; }
  function paintPhotos() {
    Array.prototype.forEach.call(document.querySelectorAll('.avatar[data-tid]'), function (el) {
      var st = photoStyle(el.getAttribute('data-tid'));
      if (st) el.setAttribute('style', st);
    });
  }
  function schedulePrefetch() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(prefetchCalendar, 400);
  }
  function drawTeachers() {
    var B = S.book;
    var all = B.teachers.every(function (t) { return B.teacherIds.indexOf(t.id) >= 0; });
    // 2026-09-26 にん：カード全体を押せる・四角のチェック・店舗ごとの出勤・ひとことは区切って1〜2行・下の固定ボタンは「空き日程を見る」＋選択状況
    var cards = [h('div', { class: 'card tcard' + (all ? ' sel' : ''), onclick: function () {
      B.touched = true; B.teacherIds = all ? [] : B.teachers.map(function (t) { return t.id; }); drawTeachers(); schedulePrefetch();
    } }, [h('div', { class: 'row' }, [h('div', { class: 'avatar', style: 'background:#5b8bb8' }, ['✦']), h('div', { class: 'grow' }, [h('h3', {}, ['どの先生でもOK']), h('div', { class: 'muted small' }, ['すべての先生の空き日程を表示'])]), h('div', { class: 'check' }, [all ? '✓' : ''])])])];
    B.teachers.forEach(function (t) {
      var on = B.teacherIds.indexOf(t.id) >= 0;
      cards.push(h('div', { class: 'card tcard' + (on ? ' sel' : ''), onclick: function () {
        B.touched = true;
        if (on) B.teacherIds = B.teacherIds.filter(function (x) { return x !== t.id; }); else B.teacherIds.push(t.id);
        drawTeachers(); schedulePrefetch();
      } }, [h('div', { class: 'row' }, [
        h('div', { class: 'avatar', 'data-tid': t.id, style: photoStyle(t.id) }, [t.name.charAt(0)]),
        h('div', { class: 'grow' }, [h('h3', {}, [t.name + '先生']), h('div', { class: 'muted small stores' }, storeLines(t))]),
        h('div', { class: 'check' }, [on ? '✓' : '']),
      ]), t.message ? h('div', { class: 'quote' }, ['「' + t.message + '」']) : null]));
    });
    var body = [h('div', { class: 'row', style: 'gap:8px;margin:2px 0 4px' }, [h('h2', { class: 'h2' }, ['先生を選ぶ']), h('span', { class: 'pill' }, ['複数選択可'])]), h('p', { class: 'muted', style: 'margin:0 0 12px' }, ['選んだ先生の空き日程を表示します。'])].concat(cards);
    if (B.mode === '振替') body.unshift(msg('振替：' + dispDate(B.original.date) + ' ' + hm(B.original.start) + ' ' + B.original.teacherName + '先生 の予約を別の日時に動かします', 'info'));
    var n = B.teacherIds.length;
    render(B.mode === '振替' ? '振替：先生を選ぶ' : 'レッスン予約', body, [
      h('div', { class: 'foot-status' + (n ? '' : ' muted') }, [n ? '先生を' + n + '人選択中' : '先生を選んでください']),
      h('button', { class: 'btn', disabled: !n, onclick: function () {
        // 先出し中（init がまだ返っていない）なら、返るのを待ってからカレンダーへ進む
        if (B.provisional) { B.waiting = true; busy('空き状況', '読み込み中…'); return; }
        screenCalendar();
      } }, ['空き日程を見る', h('span', { class: 'chev' }, ['›'])]),
      B.mode === '振替' ? h('button', { class: 'btn ghost', onclick: goList }, ['← 一覧に戻る']) : null,
    ]);
  }

  /** 先生カードの出勤：店舗ごとに「昭島校：月・金」。古い控え（stores なし）は workdays の文字列で */
  function storeLines(t) {
    if (t.stores && t.stores.length) return t.stores.map(function (x) { return h('div', {}, [x.store + '：' + x.weekdays.join('・')]); });
    return [h('div', {}, [(t.workdays || '') + 'に出勤'])];
  }

  function screenCalendar() {
    var B = S.book;
    var key = calKey();
    var promise = (B.pre && B.pre.key === key) ? B.pre.promise
      : planApi('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' });
    if (!(B.pre && B.pre.key === key)) B.pre = { key: key, promise: promise };
    busy('空き状況', '読み込み中…');
    promise.then(function (r) {
      if (!r) {   // 先読みが中断されていたら本番で取り直す
        B.pre = null;
        return planApi('calendar', { studentId: S.current.id, teacherIds: B.teacherIds.slice(), month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r2) {
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
      var mk = st === 'ok' ? '○' : st === 'few' ? '△' : st === 'full' ? '×' : st === 'closed' ? '−' : '';
      var d = h('div', { class: 'd ' + st + (on ? ' on' : '') + (past ? ' past' : ''), onclick: function () {
        if (st === 'none' || st === 'full' || st === 'closed' || st === 'past' || past) return;
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
      h('div', { class: 'row between', style: 'flex-wrap:wrap' }, [h('div', { style: 'white-space:nowrap' }, ['希望日：', h('b', {}, [String(B.wishDates.length)]), '日を選択中']), countLabel(B.month, r.limit)]),
      r.blocked ? msg(r.blocked, 'warn') : null,
      (B.autoNext && B.month === B.months[1] && !r.blocked) ? msg(dispMonth(B.months[0]) + '分の回数はすべてご予約済みのため、' + dispMonth(B.month) + 'を表示しています。', 'info') : null,
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
      h('div', { class: 'legend' }, ['○ 空きあり　△ 残りわずか　× 満席　− 受付終了　印なし＝出勤なし']),
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
    planApi('propose', { studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
      if (!r.ok) { render('ご提案', [msg(r.error, 'err'), h('button', { class: 'btn sub', onclick: drawCalendar }, ['← 希望日を選び直す'])]); return; }
      B.rows = r.rows; B.unused = r.unusedWishDates; B.n = r.n; B.short = r.message; B.notice = ''; S.current = r.student;
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
          row.changed ? h('div', { class: 'changed' }, [row.auto ? '埋まっていたため入れ替え' : '変更済み']) : null,   // 自分で変えた回と、自動で入れ替わった回を見分ける（にん 9/23）
        ]),
        h('button', { class: 'btn small sub', onclick: function () { changeMenu(i); } }, ['変更']),
      ])]);
    });
    var body = [
      h('button', { class: 'btn ghost', style: 'text-align:left;padding:4px 0', onclick: drawCalendar }, ['← 希望日を選び直す']),
      h('p', {}, [B.mode === '振替' ? '振替先としてこの回をご提案します' : 'ご希望の' + B.wishDates.length + '日から、この' + B.rows.length + '回をご提案します']),
      B.short ? msg(B.short, 'warn') : null,
      B.notice ? msg(B.notice, 'info') : null,
    ].concat(items).concat([h('p', { class: 'muted small' }, ['「変更」を押すと、その日の別の時間・別の先生や、選ばれなかった候補日と入れ替えられます。'])]);
    render('ご提案', body, [h('button', { class: 'btn', disabled: !B.rows.length, onclick: screenConfirm }, [B.mode === '振替' ? 'この回に振り替える' : 'この' + B.rows.length + '回で予約する'])]);
  }

  function changeMenu(i) {
    var B = S.book, row = B.rows[i];
    var opts = [
      { label: 'この日の別の時間', onclick: function () { alternatives('times', i); } },
    ];
    if (B.unused.length) opts.push({ label: '別の候補日と入れ替える', onclick: function () { swapMenu(i); } });
    if (B.teacherIds.length > 1 && hasAltTeachers(i)) opts.push({ label: '別の先生で', onclick: function () { alternatives('teachers', i); } });
    if (B.mode !== '振替') opts.push({ label: 'この回はいらない', danger: true, onclick: function () {
      B.rows.splice(i, 1);
      if (!B.rows.length) { render('ご提案', [msg('予約する回がありません。希望日を選び直してください。', 'warn'), h('button', { class: 'btn', onclick: drawCalendar }, ['← 希望日を選び直す'])]); return; }
      drawProposal();
    } });
    sheet(dispDate(row.date) + ' ' + hm(row.start) + ' を変更', opts);
  }
  /** 端末内で計算できるときは、別の先生の候補があるかを先に見る（なければメニューに出さない）。計算できないときは出す */
  function hasAltTeachers(i) {
    var B = S.book;
    if (!planOk() || !PLAN_ACTIONS.alternatives) return true;
    try { var r = PLAN_ACTIONS.alternatives({ kind: 'teachers', index: i, rows: B.rows, studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }); return !!(r && r.ok && r.options && r.options.length); } catch (e) { return true; }
  }
  /**
   * 確定で埋まっていた回だけを入れ替える（ほかの回の手直しは残す。にん 9/23）。
   * 同じ日の別の時間 → なければ選ばれなかった候補日 → なければ外す。何をどう変えたかを提案の上に出す
   */
  function replaceFailed(failed, sortedRows) {
    var B = S.book, notes = [];
    var common = { studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' };
    var targets = failed.map(function (f) { return sortedRows[f.index]; }).filter(Boolean);
    busy('ご提案', '空いている時間を探しています…');
    var finish = function () {
      sortRows();
      B.notice = notes.length ? '埋まっていた回を入れ替えました：' + notes.join('／') + '。ほかの回はそのままです。' : '';
      if (!B.rows.length) { render('ご提案', [msg('空きがなく、予約する回がなくなりました。希望日を選び直してください。', 'warn'), h('button', { class: 'btn', onclick: drawCalendar }, ['← 希望日を選び直す'])]); return; }
      drawProposal();
    };
    var step = function (k) {
      if (k >= targets.length) return finish();
      var t = targets[k], i = -1;
      B.rows.forEach(function (row, idx) { if (i < 0 && row.date === t.date && row.start === t.start && row.teacherId === t.teacherId) i = idx; });
      if (i < 0) return step(k + 1);
      var label = dispDate(t.date) + ' ' + hm(t.start);
      planApi('alternatives', Object.assign({ kind: 'times', index: i, rows: B.rows }, common)).then(function (r) {
        if (r.ok && r.options && r.options.length) {
          var o = r.options[0]; o.changed = true; o.auto = true; o.reason = '埋まっていたため、この日の別の時間に';
          B.rows[i] = o; notes.push(label + ' → ' + hm(o.start)); return step(k + 1);
        }
        var dates = B.unused.slice().sort();
        var trySwap = function (j) {
          if (j >= dates.length) { B.rows.splice(i, 1); notes.push(label + '：空きがなく外しました'); return step(k + 1); }
          planApi('alternatives', Object.assign({ kind: 'swap', index: i, newDate: dates[j], rows: B.rows }, common)).then(function (r2) {
            if (r2.ok && r2.row) {
              r2.row.changed = true; r2.row.auto = true; r2.row.reason = '埋まっていたため、別の日に';
              B.rows[i] = r2.row; B.unused = B.unused.filter(function (d) { return d !== dates[j]; });
              if (B.wishDates.indexOf(t.date) >= 0 && B.unused.indexOf(t.date) < 0) B.unused.push(t.date);
              notes.push(label + ' → ' + dispDate(r2.row.date) + ' ' + hm(r2.row.start)); return step(k + 1);
            }
            trySwap(j + 1);
          });
        };
        trySwap(0);
      });
    };
    step(0);
  }
  function alternatives(kind, i) {
    var B = S.book;
    busy('ご提案', '別の候補を探しています…');
    planApi('alternatives', { kind: kind, index: i, rows: B.rows, studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
      drawProposal();
      if (!r.ok) { sheet(r.error, []); return; }
      if (!r.options.length) { sheet(kind === 'times' ? 'この日に他の空き時間はありません' : 'この日に空きのある他の先生はいません', []); return; }
      sheet(kind === 'times' ? 'この日の別の時間' : '別の先生で', r.options.map(function (o) {
        return { label: (kind === 'teachers' ? o.teacherName + '先生　' : '') + hm(o.start) + '〜' + hm(o.end) + (o.reason ? '　' + o.reason : ''), onclick: function () {
          var cur = B.rows[i]; if (B.wishDates.indexOf(cur.date) >= 0 && cur.date !== o.date && B.unused.indexOf(cur.date) < 0) B.unused.push(cur.date);
          o.changed = true; B.rows[i] = o; B.unused = B.unused.filter(function (d) { return d !== o.date; }); sortRows(); drawProposal();
        } };
      }));
    });
  }
  function swapMenu(i) {
    var B = S.book;
    sheet('別の候補日と入れ替える', B.unused.slice().sort().map(function (d) {
      return { label: dispDate(d), onclick: function () {
        busy('ご提案', '空きを探しています…');
        planApi('alternatives', { kind: 'swap', index: i, newDate: d, rows: B.rows, studentId: S.current.id, teacherIds: B.teacherIds, wishDates: B.wishDates, wishBands: B.wishBands, month: B.month, originalId: B.original ? B.original.id : '' }).then(function (r) {
          drawProposal();
          if (!r.ok) { sheet(r.error, []); return; }
          var cur = B.rows[i]; if (B.wishDates.indexOf(cur.date) >= 0 && B.unused.indexOf(cur.date) < 0) B.unused.push(cur.date);
          B.rows[i] = r.row; B.unused = B.unused.filter(function (x) { return x !== d; }); sortRows(); drawProposal();
        });
      } };
    }));
  }

  function screenConfirm() {
    var B = S.book;
    var memo = h('textarea', { placeholder: '例：来月から木曜希望です' });
    var rows = B.rows.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; });
    var lines = rows.map(function (r) { return h('div', { style: 'margin:3px 0' }, [h('div', { style: 'white-space:nowrap' }, [dispDate(r.date) + ' ' + hm(r.start) + '〜' + hm(r.end)]), h('div', { class: 'muted small' }, [r.teacherName + '先生・' + r.store])]); });
    // 翌月分は「先使い回数」で消費するので、「残り」ではなく「その月に使える回数」で見せる（今月分は「残り」）
    var m0 = rows[0].date.substring(0, 7), pst = B.plan && B.plan.student;
    var lim0 = (pst && typeof bookingLimit === 'function') ? bookingLimit(m0, pst) : S.current.remaining;
    var countText = (m0 !== todayYmd().substring(0, 7) ? dispMonth(m0) + 'に使える回数 ' : '今月あと ') + lim0 + ' → ' + Math.max(0, lim0 - rows.length);
    var body = [h('p', {}, ['この内容でよろしいですか？'])];
    if (B.mode === '振替') {
      body.push(h('div', { class: 'card' }, [h('div', { class: 'muted small' }, ['元の予約']), h('div', {}, [dispDate(B.original.date) + ' ' + hm(B.original.start) + '　' + B.original.teacherName + '先生']), h('div', { style: 'text-align:center;color:#2b5d8c' }, ['↓']), h('div', { class: 'muted small' }, ['新しい予約']), lines[0]]));
      body.push(h('p', { class: 'muted small' }, ['回数は動きません（1回消えて1回入るため）。']));
    } else {
      body.push(h('div', { class: 'card' }, lines.concat([h('div', { class: 'row between', style: 'margin-top:8px' }, [h('span', { style: 'white-space:nowrap;flex:none' }, ['使う回数']), h('b', { style: 'text-align:right' }, [rows.length + '回（' + countText + '）'])])])));
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
    busy('予約内容の確認', '予約しています…（カレンダーに書き込むため少し時間がかかります）', true);
    api('confirm', { studentId: S.current.id, rows: rows, memo: memoText, originalId: B.original ? B.original.id : '' }).then(function (r) {
      if (!r.ok) {
        var body = [msg(r.error, 'err')];
        var failed = (r.recheck && r.recheck.failed) || [];
        if (failed.length) {
          body.push(h('p', { class: 'muted small' }, ['埋まってしまった回：' + failed.map(function (f) { return rows[f.index] ? dispDate(rows[f.index].date) + ' ' + hm(rows[f.index].start) : ''; }).join('、')]));
          // 端末内の材料に「埋まった枠」を足し、空き状況の先読みを捨てて、提案を出し直す（同じ枠がまた出ないように）
          if (B.plan) failed.forEach(function (f) { var row = rows[f.index]; if (row) B.plan.bookings.push({ id: '', studentId: '', teacherId: row.teacherId, date: row.date, start: row.start, end: row.end, state: '予約中' }); });
          B.cal = {}; B.pre = null;
          body.push(h('button', { class: 'btn', onclick: function () { replaceFailed(failed, rows); } }, ['← 埋まった回だけ入れ替える（ほかの回はそのまま）']));
        } else body.push(h('button', { class: 'btn', onclick: drawProposal }, ['← 提案に戻って選び直す']));
        render('予約内容の確認', body); return;
      }
      S.current = r.student;
      if (r.transfer) {
        render('振替が完了しました', [msg('振替しました。', 'ok'), h('div', { class: 'card' }, [dispDate(r.booking.date) + ' ' + hm(r.booking.start) + '〜' + hm(r.booking.end) + '　' + r.booking.teacherName + '先生・' + r.booking.store]),
          h('button', { class: 'btn', onclick: goList }, ['予約の確認・振替へ']), h('button', { class: 'btn sub', onclick: goHome }, ['ホームへ'])]);
        return;
      }
      var okRows = r.results.filter(function (x) { return x.ok; }), ng = r.results.filter(function (x) { return !x.ok; });
      render('予約が完了しました', [
        okRows.length ? msg(okRows.length + '回分を予約しました。', 'ok') : null,
        h('div', { class: 'card' }, okRows.map(function (x) { var tr = rows.filter(function (q) { return q.date === x.date && q.start === x.start; })[0]; return h('div', {}, [dispDate(x.date) + ' ' + hm(x.start) + '　' + (tr ? tr.teacherName + '先生' : '')]); })),
        ng.length ? msg('登録できなかった回があります：' + ng.map(function (x) { return dispDate(x.date) + ' ' + hm(x.start); }).join('、') + '\nもう一度予約画面からお試しください。', 'warn') : null,
        h('div', { class: 'stat' }, [h('span', {}, ['今月あと']), h('span', {}, [h('b', {}, [String(r.student.remaining)]), ' 回'])]),
        (function () { var m = rows[0].date.substring(0, 7), pst = B.plan && B.plan.student; if (!(pst && typeof bookingLimit === 'function' && m !== todayYmd().substring(0, 7))) return null;
          var lim = bookingLimit(m, { remaining: r.student.remaining, advance: r.student.advance, monthlyCount: r.student.monthlyCount, grantedMonth: pst.grantedMonth });
          return h('div', { class: 'muted small' }, [dispMonth(m) + 'に使える回数：あと ' + lim + ' 回（' + dispMonth(m) + '分は先に使う形で、今月の回数は減りません）']); })(),
        h('button', { class: 'btn', onclick: goHome }, ['ホームへ']),
        h('button', { class: 'btn sub', onclick: goList }, ['予約の確認・振替へ']),
        h('button', { class: 'btn sub', onclick: function () { if (window.liff && liff.closeWindow) liff.closeWindow(); } }, ['閉じる']),
      ]);
    });
  }

  // ?debug=1 のときだけ、端末内の計算と GAS の結果を見比べるための入口を出す（秘密の情報は含まない）
  if (DEBUG) window.__beyond = { planApi: planApi, api: api, state: S };
  slowHint();
  start();
})();
