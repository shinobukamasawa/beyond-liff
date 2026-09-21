/**
 * 提案ロジック（docs/logic-teian.md）。GAS に依存しない。Node で単体テストする。
 *
 * 入力 input:
 *   mode: '通常' | '振替'
 *   student: { id, store, course, courseMinutes, monthlyCount, remaining, advance, grantedMonth,
 *              ngWeekdays:[], timebands:[], status, requestKind, applyMonth }
 *   teacherIds: [選んだ先生ID]
 *   teachers: [{ id, active, courses:[], stores:[] }]
 *   wishDates: ['yyyy-MM-dd']      画面③でタップした日
 *   wishBands: ['午前'|'午後'|'夕方以降']  空＝制限なし
 *   targetMonth: 'yyyy-MM'
 *   slots: [{ date, teacherId, store, start, end }]          枠（分）
 *   bookings: [{ id, studentId, teacherId, date, start, end, state }]
 *   original: 振替の元の予約（bookings の要素と同じ形）| null
 *   now: { ymd, minutes }          現在（日本時間）
 *   settings: { releaseDay, releaseMinutes, rangeMonths, stepMinutes, minLeadDays, minLeadMinutes,
 *               absentFreesSlot, spreadWeekly, gapFirst, earlyFirst }
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
function tnBand_(start) { return start < 720 ? '午前' : start < 1020 ? '午後' : '夕方以降'; }
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
    return input.slots.some(function (sl) { return sl.teacherId === t.id && sl.store === s.store && sl.date.substring(0, 7) === input.targetMonth; });
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
  var s = input.student;
  var booked = input.bookings.filter(function (b) {
    return b.studentId === s.id && b.state === '予約中' && b.date.substring(0, 7) === input.targetMonth;
  }).length;
  return Math.min(tnLimit_(input.targetMonth, s), Math.max(1, s.monthlyCount - booked));
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
  // 生徒自身：同じ日に予約中があれば弾く（決定 D：1日1回。時間が重ならなくても）
  var hitSelf = input.bookings.some(function (b) {
    return b.studentId === input.student.id && b.date === c.date && b.state === '予約中' && !tnIsOriginal_(input, b);
  });
  if (hitSelf) return '同じ日に予約がある';
  return null;
}

/** 3.4 の 4〜6：曜日NG、名簿の希望時間帯、画面の時間帯 */
function tnRejectPrefs_(input, c) {
  var s = input.student;
  if ((s.ngWeekdays || []).indexOf(tnWeekday_(c.date)) >= 0) return '曜日NG';
  var band = tnBand_(c.start);
  if ((s.timebands || []).length && s.timebands.indexOf(band) < 0) return '名簿の希望時間帯';
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
        if (sl.date !== date || sl.teacherId !== tid || sl.store !== s.store) return;
        for (var st = sl.start; st + s.courseMinutes <= sl.end; st += step) {
          var c = { date: date, teacherId: tid, store: sl.store, start: st, end: st + s.courseMinutes, slotStart: sl.start, slotEnd: sl.end };
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

  var prevMonth = tnMonthAdd_(input.targetMonth, -1);
  var wd = tnWeekday_(c.date);
  var last = 0;
  input.bookings.forEach(function (b) {
    if (b.studentId !== input.student.id || b.state !== '予約中' || b.date.substring(0, 7) !== prevMonth) return;
    if (tnWeekday_(b.date) === wd && b.start === c.start) last = Math.max(last, b.teacherId === c.teacherId ? 2 : 1);
  });
  return { conn: conn, connBooking: connBooking, last: last };
}

/** 4.3：比べる順。a が先なら負 */
function tnCompare_(a, b, settings, useDistance) {
  var keys = settings.gapFirst ? ['conn', 'last'] : ['last', 'conn'];
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

function tnConflictsSelected_(c, selected) {
  return selected.some(function (r) {
    return r.date === c.date || (r.teacherId === c.teacherId && r.date === c.date && tnOverlap_(c.start, c.end, r.start, r.end));
  });
}

function tnReason_(ev, weekAlreadyUsed) {
  if (ev.last >= 1) return '先月と同じ曜日・時間';
  if (ev.connBooking === 2) return '先生の空き時間がつながります';
  if (ev.connBooking === 1) return '前後の予約とつながります';
  if (weekAlreadyUsed) return '希望日が集中しているため同じ週から';
  return '希望日の中で早い日';
}

/**
 * 4.4：候補から need 件を選ぶ。selected（選択済み）に足していく。
 * opts: { useDistance, reasonFn(c, ev, weekAlreadyUsed) }
 */
function tnPick_(input, cands, need, selected, opts) {
  var st = input.settings;
  var weekCount = {};
  selected.forEach(function (r) { var w = tnWeekKey_(r.date); weekCount[w] = (weekCount[w] || 0) + 1; });
  var k = st.spreadWeekly ? 0 : 99;
  var picked = [];
  while (picked.length < need) {
    var avail = cands.filter(function (c) {
      return !tnConflictsSelected_(c, selected) && (weekCount[tnWeekKey_(c.date)] || 0) <= k;
    });
    if (!avail.length) { k++; if (k > 31) break; continue; }
    avail.forEach(function (c) { c.ev = tnEvaluate_(input, c, selected); });
    avail.sort(function (a, b) { return tnCompare_(a, b, st, opts && opts.useDistance); });
    var best = avail[0];
    var w = tnWeekKey_(best.date);
    var used = (weekCount[w] || 0) > 0;
    var row = {
      date: best.date, teacherId: best.teacherId, store: best.store, start: best.start, end: best.end,
      slotStart: best.slotStart, slotEnd: best.slotEnd,
      reason: (opts && opts.reasonFn) ? opts.reasonFn(best, best.ev, used) : tnReason_(best.ev, used),
      fromWish: !(opts && opts.useDistance), changed: false,
    };
    selected.push(row); picked.push(row);
    weekCount[w] = (weekCount[w] || 0) + 1;
  }
  return picked;
}

/** 提案の本体（1〜5章） */
function tnPropose(input) {
  var pre = tnPrecheck(input);
  if (pre) return { ok: false, code: pre.code, message: pre.message };
  var n = tnCount(input);
  var wish = input.wishDates.slice().sort();

  var C = tnCandidates(input, wish);
  var selected = [];
  tnPick_(input, C, n, selected, null);

  // 5章：足りない分は希望日以外から
  if (selected.length < n) {
    var hasCand = {};
    C.forEach(function (c) { hasCand[c.date] = true; });
    var days = [];
    var first = input.targetMonth + '-01';
    for (var d = first; d.substring(0, 7) === input.targetMonth; d = tnAddDays_(d, 1)) {
      if (wish.indexOf(d) < 0 && d >= input.now.ymd) days.push(d);
    }
    var dist = {};
    days.forEach(function (d) { dist[d] = Math.min.apply(null, wish.map(function (w) { return tnDiffDays_(d, w); })); });
    var near = days.filter(function (d) { return dist[d] <= 3; });
    var C2 = tnCandidates(input, near);
    if (!C2.length) C2 = tnCandidates(input, days);
    C2.forEach(function (c) { c.distance = dist[c.date]; });
    tnPick_(input, C2, n - selected.length, selected, {
      useDistance: true,
      reasonFn: function (c) {
        var w = tnWeekKey_(c.date);
        var full = wish.filter(function (x) { return tnWeekKey_(x) === w && !hasCand[x]; });
        return '希望日以外からのおすすめ' + (full.length ? '（' + full.map(tnShort_).join('・') + 'は満席のため）' : '');
      },
    });
  }

  if (!selected.length) return { ok: false, code: 'empty', message: '選んだ日に空きがありません' };
  selected.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; });
  var usedDates = selected.map(function (r) { return r.date; });
  return {
    ok: true, n: n, rows: selected,
    unusedWishDates: wish.filter(function (d) { return usedDates.indexOf(d) < 0; }),
    short: selected.length < n,
    message: selected.length < n ? '希望日に空きが少ないため ' + selected.length + ' 回分の提案です。希望日を増やすと提案が増えます' : '',
  };
}

/** 6.1：この日の別の時間（rows[index] と同じ日・同じ先生） */
function tnAltTimes(input, rows, index) {
  var cur = rows[index];
  var others = rows.filter(function (_, i) { return i !== index; });
  return tnCandidates(input, [cur.date], [cur.teacherId])
    .filter(function (c) { return c.start !== cur.start && !tnOverlapSelected_(c, others); })
    .sort(function (a, b) { return a.start - b.start; });
}

function tnOverlapSelected_(c, others) {
  return others.some(function (r) { return r.teacherId === c.teacherId && r.date === c.date && tnOverlap_(c.start, c.end, r.start, r.end); });
}

/** 6.2：別の候補日と入れ替える。見つからなければ null */
function tnSwapDate(input, rows, index, newDate) {
  var others = rows.filter(function (_, i) { return i !== index; });
  if (others.some(function (r) { return r.date === newDate; })) return null;
  var cands = tnCandidates(input, [newDate]).filter(function (c) { return !tnOverlapSelected_(c, others); });
  if (!cands.length) return null;
  cands.forEach(function (c) { c.ev = tnEvaluate_(input, c, others); });
  cands.sort(function (a, b) { return tnCompare_(a, b, input.settings, false); });
  return tnRowFrom_(cands[0]);
}

/** 6.3：別の先生で。先生ごとの最良1件 */
function tnAltTeachers(input, rows, index) {
  var cur = rows[index];
  var others = rows.filter(function (_, i) { return i !== index; });
  var out = [];
  tnEligibleTeachers_(input).forEach(function (t) {
    if (t.id === cur.teacherId) return;
    var cands = tnCandidates(input, [cur.date], [t.id]).filter(function (c) { return !tnOverlapSelected_(c, others); });
    if (!cands.length) return;
    cands.forEach(function (c) { c.ev = tnEvaluate_(input, c, others); });
    cands.sort(function (a, b) { return tnCompare_(a, b, input.settings, false); });
    out.push(tnRowFrom_(cands[0]));
  });
  return out;
}

function tnRowFrom_(c) {
  return { date: c.date, teacherId: c.teacherId, store: c.store, start: c.start, end: c.end, slotStart: c.slotStart, slotEnd: c.slotEnd,
    reason: tnReason_(c.ev, false), fromWish: true, changed: true };
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
    tnPrecheck: tnPrecheck, tnCount: tnCount, tnCandidates: tnCandidates, tnPropose: tnPropose,
    tnAltTimes: tnAltTimes, tnSwapDate: tnSwapDate, tnAltTeachers: tnAltTeachers, tnRecheck: tnRecheck,
  };
}
