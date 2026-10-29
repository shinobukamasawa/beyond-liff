/**
 * 提案ロジック（docs/logic-teian.md）。GAS に依存しない。Node で単体テストする。
 *
 * 入力 input:
 *   mode: '通常' | '振替'
 *   student: { id, store, course, courseMinutes, monthlyCount, remaining, advance, grantedMonth,
 *              ngWeekdays:[], timebands:[], status, requestKind, applyMonth }
 *   teacherIds: [選んだ先生ID]
 *   teachers: [{ id, active, courses:[], stores:[] }]
 *   wishDates: ['yyyy-MM-dd']      画面③でタップした日（2026-10-21 から 1 日だけ。10章）
 *   wishBands: ['午前'|'午後'|'夕方'|'夜']  空＝制限なし（2026-10-21 から 4 区分：〜12:00／12:00〜16:00／16:00〜18:00／18:00〜。1〜2 つ）
 *   targetMonth: 'yyyy-MM'
 *   slots: [{ date, teacherId, store, start, end }]          枠（分）。store が空＝指定なし（担当店舗のどこでも）。その枠の候補の店舗は生徒の店舗
 *   bookings: [{ id, studentId, teacherId, date, start, end, state, store }]
 *   original: 振替の元の予約（bookings の要素と同じ形）| null
 *   now: { ymd, minutes }          現在（日本時間）
 *   settings: { releaseDay, releaseMinutes, rangeMonths, stepMinutes, minLeadDays, minLeadMinutes,
 *               absentFreesSlot, spreadWeekly, gapFirst, earlyFirst,
 *               travel: { '店舗A|店舗B': 分 } }   店舗間の移動時間（2026-09-25。ない組は 0）
 */

var TN_WEEK_ = ['日', '月', '火', '水', '木', '金', '土'];
var tnLimitFn_ = (typeof module !== 'undefined' && typeof require !== 'undefined') ? require('./Membership.js').bookingLimit : null;

function tnP2_(n) { return (n < 10 ? '0' : '') + n; }
function tnDate_(ymd) { var p = ymd.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function tnYmd_(d) { return d.getFullYear() + '-' + tnP2_(d.getMonth() + 1) + '-' + tnP2_(d.getDate()); }
function tnAddDays_(ymd, n) { var d = tnDate_(ymd); d.setDate(d.getDate() + n); return tnYmd_(d); }
function tnDiffDays_(a, b) { return Math.abs(Math.round((tnDate_(a) - tnDate_(b)) / 86400000)); }
function tnWeekday_(ymd) { return TN_WEEK_[tnDate_(ymd).getDay()]; }
/** 月曜始まりの週のキー（その週の月曜の日付） */
function tnWeekKey_(ymd) { var d = tnDate_(ymd); var back = (d.getDay() + 6) % 7; return tnAddDays_(ymd, -back); }
/** 時間帯の区分（決定 B。2026-10-21 に 4 区分へ：境界 12:00・16:00・18:00。10/16 までは 12:00・17:00 の 3 区分） */
function tnBand_(start) { return start < 720 ? '午前' : start < 960 ? '午後' : start < 1080 ? '夕方' : '夜'; }
function tnOverlap_(aS, aE, bS, bE) { return aS < bE && bS < aE; }
function tnMonthAdd_(ym, n) { var p = ym.split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1); return d.getFullYear() + '-' + tnP2_(d.getMonth() + 1); }
function tnShort_(ymd) { var p = ymd.split('-'); return Number(p[1]) + '/' + Number(p[2]); }
function tnLimit_(targetMonth, student) { return (tnLimitFn_ || bookingLimit)(targetMonth, student); }

/** 1章：前提チェック。問題なければ null、あれば { code, message } */
function tnPrecheck(input) {
  var s = input.student, st = input.settings, now = input.now;
  var thisMonth = now.ymd.substring(0, 7);

  // 1) 在籍
  var applies = s.applyMonth && s.applyMonth <= input.targetMonth;
  if (s.status === '在籍') {
    if ((s.requestKind === '休会' || s.requestKind === '退会') && applies) {
      return { code: 'status', message: s.applyMonth.substring(5) * 1 + '月から' + s.requestKind + 'のため、この月の予約はできません' };
    }
  } else if (s.status === '休会' && s.requestKind === '復帰' && applies) {
    // 復帰の適用月以降は予約可
  } else {
    return { code: 'status', message: s.status + '中のため予約できません' };
  }

  // 2) 対象月
  if (input.targetMonth < thisMonth) return { code: 'month', message: '過去の月は予約できません' };
  if (input.targetMonth > thisMonth) {
    if (input.targetMonth > tnMonthAdd_(thisMonth, st.rangeMonths)) return { code: 'month', message: 'この月の予約はまだ受け付けていません' };
    if (input.targetMonth === tnMonthAdd_(thisMonth, 1)) {
      var day = Number(now.ymd.substring(8));
      var open = day > st.releaseDay || (day === st.releaseDay && now.minutes >= st.releaseMinutes);
      if (!open) return { code: 'month', message: '翌月分の予約は ' + st.releaseDay + '日 ' + tnP2_(Math.floor(st.releaseMinutes / 60)) + ':' + tnP2_(st.releaseMinutes % 60) + ' から受け付けます' };
    }
  }

  // 3) 上限（振替では見ない）
  if (input.mode !== '振替' && tnLimit_(input.targetMonth, s) <= 0) {
    return { code: 'limit', message: '今月の回数はすべて予約済みです' };
  }

  // 4) 先生
  var ok = tnEligibleTeachers_(input).some(function (t) {
    return input.slots.some(function (sl) { return sl.teacherId === t.id && tnSlotFits_(sl, s) && sl.date.substring(0, 7) === input.targetMonth; });
  });
  if (!ok) return { code: 'teacher', message: '選んだ先生はこの月に出勤がありません' };
  return null;
}

/** 3.1：使える先生 */
function tnEligibleTeachers_(input) {
  var s = input.student;
  return input.teachers.filter(function (t) {
    return input.teacherIds.indexOf(t.id) >= 0 && t.active && t.courses.indexOf(s.course) >= 0 && t.stores.indexOf(s.store) >= 0;
  });
}

/** 2章：提案回数 N */
function tnCount(input) {
  if (input.mode === '振替') return 1;
  // 使える回数（その月の正規分＋繰越）をまとめて提案する（決定 A の変更。2026-09-23 にん。それまでは「月の回数まで」）
  return Math.max(1, tnLimit_(input.targetMonth, input.student));
}

/** 枠が生徒の店舗に合うか（枠の店舗が空＝指定なし＝どこでも） */
function tnSlotFits_(sl, s) { return !sl.store || sl.store === s.store; }

/** 店舗間の移動時間（分）。同じ店舗・不明な店舗・設定のない組は 0 */
function tnTravel_(settings, a, b) {
  if (!a || !b || a === b) return 0;
  var t = (settings && settings.travel) || {};
  var v = t[a + '|' + b]; if (v === undefined) v = t[b + '|' + a];
  return v === undefined ? 0 : Number(v) || 0;
}

/**
 * 3.6：店舗間の移動時間。同じ先生の同じ日の予約（塞ぐ状態のもの）と店舗が違うとき、間に移動時間以上の空きが要る。足りなければ理由。
 * オンラインの予約（b.online、または振替元がオンライン）は店舗を移動しないので見ない（2026-10-01）
 */
function tnRejectTravel_(input, c) {
  if (c.online || (input.original && input.original.online)) return null;
  var blocking = tnBlockingStates_(input);
  for (var i = 0; i < input.bookings.length; i++) {
    var b = input.bookings[i];
    if (b.teacherId !== c.teacherId || b.date !== c.date || blocking.indexOf(b.state) < 0 || tnIsOriginal_(input, b)) continue;
    if (!b.store || b.store === c.store || b.online) continue;
    var need = tnTravel_(input.settings, b.store, c.store);
    if (!need) continue;
    if (b.end <= c.start && c.start - b.end < need) return '店舗間の移動時間';
    if (c.end <= b.start && b.start - c.end < need) return '店舗間の移動時間';
  }
  return null;
}

function tnBlockingStates_(input) { return input.settings.absentFreesSlot ? ['予約中'] : ['予約中', '期限後欠席']; }
function tnIsOriginal_(input, b) { return !!(input.original && b.id === input.original.id); }

/** 3.4 の 1〜3：過去・締切、先生の予約、生徒自身の予約。弾く理由を返す（弾かなければ null） */
function tnRejectBasic_(input, c) {
  var st = input.settings, now = input.now;
  if (c.date < now.ymd) return '過去';
  var deadline = tnAddDays_(c.date, -st.minLeadDays);
  if (now.ymd > deadline || (now.ymd === deadline && now.minutes >= st.minLeadMinutes)) return '受付締切';
  // 振替：元の予約とまったく同じ枠（同じ日・同じ開始時刻・同じ先生）は振替先にしない（7章）
  var o = input.original;
  if (o && c.date === o.date && c.start === o.start && c.teacherId === o.teacherId) return '元の予約と同じ枠';
  var blocking = tnBlockingStates_(input);
  var hitTeacher = input.bookings.some(function (b) {
    return b.teacherId === c.teacherId && b.date === c.date && blocking.indexOf(b.state) >= 0 && !tnIsOriginal_(input, b) && tnOverlap_(c.start, c.end, b.start, b.end);
  });
  if (hitTeacher) return '先生の予約と重なる';
  var travel = tnRejectTravel_(input, c);
  if (travel) return travel;
  // 生徒自身：同じ日に予約中があれば弾く（決定 D：1日1回。時間が重ならなくても）
  var hitSelf = input.bookings.some(function (b) {
    return b.studentId === input.student.id && b.date === c.date && b.state === '予約中' && !tnIsOriginal_(input, b);
  });
  if (hitSelf) return '同じ日に予約がある';
  return null;
}

/**
 * 3.4 の 6：画面の時間帯。
 * 3.4 の 4・5（名簿の曜日NG・希望時間帯）は 2026-10-29 に判定から外した：10/16 に運営の画面から外して入れられなくなった列で、
 * 古い値（旧 3 区分の「夕方以降」など）が残っていると 4 区分の判定で候補を全部弾いてしまうため
 */
function tnRejectPrefs_(input, c) {
  var band = tnBand_(c.start);
  if ((input.wishBands || []).length && input.wishBands.indexOf(band) < 0) return '時間帯の希望';
  return null;
}

/** 3章：候補を作る。dates＝対象の日付、teacherIds＝対象の先生（省略時は使える先生全員） */
function tnCandidates(input, dates, teacherIds) {
  var s = input.student, step = input.settings.stepMinutes;
  var teachers = tnEligibleTeachers_(input).map(function (t) { return t.id; });
  if (teacherIds) teachers = teachers.filter(function (id) { return teacherIds.indexOf(id) >= 0; });
  var out = [];
  dates.forEach(function (date) {
    teachers.forEach(function (tid) {
      input.slots.forEach(function (sl) {
        if (sl.date !== date || sl.teacherId !== tid || !tnSlotFits_(sl, s)) return;
        for (var st = sl.start; st + s.courseMinutes <= sl.end; st += step) {
          var c = { date: date, teacherId: tid, store: s.store, start: st, end: st + s.courseMinutes, slotStart: sl.start, slotEnd: sl.end };   // 指定なしの枠でも、予約の店舗は生徒の店舗
          if (tnRejectBasic_(input, c) || tnRejectPrefs_(input, c)) continue;
          out.push(c);
        }
      });
    });
  });
  return out;
}

/** 4.2：評価値 */
function tnEvaluate_(input, c, selected) {
  var blocking = tnBlockingStates_(input);
  var schedule = input.bookings.filter(function (b) {
    return b.teacherId === c.teacherId && b.date === c.date && blocking.indexOf(b.state) >= 0 && !tnIsOriginal_(input, b);
  }).concat(selected.filter(function (r) { return r.teacherId === c.teacherId && r.date === c.date; }));
  var prevB = schedule.some(function (x) { return x.end === c.start; });
  var nextB = schedule.some(function (x) { return x.start === c.end; });
  var conn = ((prevB || c.start === c.slotStart) ? 1 : 0) + ((nextB || c.end === c.slotEnd) ? 1 : 0);
  var connBooking = (prevB ? 1 : 0) + (nextB ? 1 : 0);
  // 移動が減る方向：その日の先生の予約がみな同じ店舗（または店舗なし）なら 1、別の店舗の予約があれば 0（2026-09-25）
  var stay = schedule.some(function (x) { return x.store && x.store !== c.store; }) ? 0 : 1;

  var prevMonth = tnMonthAdd_(input.targetMonth, -1);
  var wd = tnWeekday_(c.date);
  var last = 0;
  input.bookings.forEach(function (b) {
    if (b.studentId !== input.student.id || b.state !== '予約中' || b.date.substring(0, 7) !== prevMonth) return;
    if (tnWeekday_(b.date) === wd && b.start === c.start) last = Math.max(last, b.teacherId === c.teacherId ? 2 : 1);
  });
  return { conn: conn, connBooking: connBooking, last: last, stay: stay };
}

/** 4.3：比べる順。a が先なら負 */
function tnCompare_(a, b, settings, useDistance) {
  var keys = settings.gapFirst ? ['conn', 'last', 'stay'] : ['last', 'conn', 'stay'];
  for (var i = 0; i < keys.length; i++) if (a.ev[keys[i]] !== b.ev[keys[i]]) return b.ev[keys[i]] - a.ev[keys[i]];
  if (useDistance && a.distance !== b.distance) return a.distance - b.distance;
  if (settings.earlyFirst) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
  }
  if (a.teacherId !== b.teacherId) return a.teacherId < b.teacherId ? -1 : 1;
  if (a.start !== b.start) return a.start - b.start;
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/** 4.5：理由の一言。2026-10-21 から 1 日の候補なので「同じ週から」「早い日」は出さない（当てはまらなければ空） */
function tnReason_(ev, weekAlreadyUsed) {
  if (ev.last >= 1) return '先月と同じ曜日・時間';
  if (ev.connBooking === 2) return '先生の空き時間がつながります';
  if (ev.connBooking === 1) return '前後の予約とつながります';
  return '';
}

/**
 * 10章（2026-10-21 社長確定）：1 日・時間帯 1〜2 つの候補を、おすすめ順に limit 件まで出す。生徒はこの中から 1 件を選ぶ。
 * 並びは 4.3（つながり度・先月同枠・移動なし・早さ）。選択済みは空（先生の既存予約だけを予定とする）。
 * 間引き（Q-M にん承認）：同じ先生では、開始がコースの長さ以上離れた候補だけを採る（15:00 を採ったら 15:15・15:30 は飛ばし、15:45 は採る）。
 * 先生が 2 人以上なら、先生ごとの最良を先に 1 件ずつ出してから残りを並べる。limit に満たなければ、飛ばした候補を順に足す。
 * 戻り値：[{ date, teacherId, store, start, end, slotStart, slotEnd, reason }]（おすすめ順）
 */
function tnTopCandidates(input, date, bands, limit) {
  var inp = {};
  for (var k in input) inp[k] = input[k];
  inp.wishDates = [date]; inp.wishBands = bands || [];
  var n = limit || 6;
  var cands = tnCandidates(inp, [date]);
  cands.forEach(function (c) { c.ev = tnEvaluate_(inp, c, []); });
  cands.sort(function (a, b) { return tnCompare_(a, b, inp.settings, false); });
  var gap = inp.student.courseMinutes || 45;
  var picked = [], skipped = [], seen = {};
  var fits = function (c) {
    return picked.every(function (p) { return p.teacherId !== c.teacherId || Math.abs(p.start - c.start) >= gap; });
  };
  // 先生ごとの最良を先に（並びの先頭から、先生ごとに最初の 1 件）
  cands.forEach(function (c) { if (picked.length < n && !seen[c.teacherId]) { seen[c.teacherId] = true; picked.push(c); } });
  cands.forEach(function (c) {
    if (picked.indexOf(c) >= 0) return;
    if (picked.length < n && fits(c)) picked.push(c); else skipped.push(c);
  });
  skipped.forEach(function (c) { if (picked.length < n) picked.push(c); });
  return picked.map(function (c) {
    return { date: c.date, teacherId: c.teacherId, store: c.store, start: c.start, end: c.end, slotStart: c.slotStart, slotEnd: c.slotEnd,
      reason: tnReason_(c.ev, false), fromWish: true, changed: false };
  });
}

/**
 * 8章：確定時の再チェック。
 * 戻り値 { ok, limitShort: bool, limit, failed: [{ index, why }] }
 */
function tnRecheck(input, rows) {
  var limit = tnLimit_(input.targetMonth, input.student);
  var limitShort = input.mode !== '振替' && limit < rows.length;
  var failed = [];
  rows.forEach(function (r, i) {
    var inSlot = input.slots.some(function (sl) {
      return sl.date === r.date && sl.teacherId === r.teacherId && sl.start <= r.start && r.end <= sl.end;
    });
    var why = inSlot ? tnRejectBasic_(input, r) : '出勤時間外';
    if (why) failed.push({ index: i, why: why });
  });
  return { ok: !limitShort && !failed.length, limitShort: limitShort, limit: limit, failed: failed };
}

if (typeof module !== 'undefined') {
  module.exports = {
    tnPrecheck: tnPrecheck, tnCount: tnCount, tnCandidates: tnCandidates, tnTopCandidates: tnTopCandidates, tnRecheck: tnRecheck, tnBand_: tnBand_,
  };
}
