/**
 * 在籍・回数の純粋な計算（GAS に依存しない。Node で単体テストする）
 * docs/spec.md 9.6・10章、docs/sheets.md「回数の動かし方」、docs/screen-admin.md 1.3
 */

/** Date → 'yyyy-MM'（ローカル時刻） */
function ymOf(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m;
}

/** 'yyyy-MM' に n か月足す */
function ymAdd(ym, n) {
  var p = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!p) return '';
  return ymOf(new Date(Number(p[1]), Number(p[2]) - 1 + n, 1));
}

/**
 * 休会・退会の適用月（9.6）
 * 申請日の「日」が締め日（初期値10）以下なら翌月、それより後なら翌々月
 */
function applyMonthFor(requestDate, cutoffDay) {
  var cutoff = cutoffDay || 10;
  var base = ymOf(requestDate);
  return ymAdd(base, requestDate.getDate() <= cutoff ? 1 : 2);
}

/**
 * 新規登録時の回数（screen-admin 決定 W）
 * 入会月が今月以前ならその場で付与、来月以降なら付与済み月＝入会月の前月
 */
function initialGrant(joinMonth, thisMonth, monthlyCount) {
  if (joinMonth <= thisMonth) {
    return { remaining: monthlyCount, advance: 0, grantedMonth: thisMonth };
  }
  return { remaining: 0, advance: 0, grantedMonth: ymAdd(joinMonth, -1) };
}

/**
 * 予約で消費する先（sheets.md「回数の動かし方」）
 * 予約日の月 > 回数付与済み月 → '先使い回数'、それ以外 → '残り回数'
 */
function consumeColumn(bookingMonth, grantedMonth) {
  return bookingMonth > String(grantedMonth || '') ? '先使い回数' : '残り回数';
}

/**
 * 使える回数の上限（logic-teian 1章の3）
 * 残り回数 ＋（対象月 > 付与済み月 のとき 月の回数 − 先使い回数）
 */
function bookingLimit(targetMonth, student) {
  var remaining = Number(student.remaining || 0);
  if (targetMonth > String(student.grantedMonth || '')) {
    return remaining + Number(student.monthlyCount || 0) - Number(student.advance || 0);
  }
  return remaining;
}

/**
 * 使える回数の内訳（画面の表示用。2026-09-23 にん）
 * 正規分 ＝ 月の回数 − その月にすでに入っている予約中の件数（0 未満にしない。使える回数を超えない）、繰越 ＝ 使える回数 − 正規分
 * 例：残り4・月4・先使い3（翌月に3件入っている）→ 使える 5、正規分 1、繰越 4
 */
function countBreakdown(targetMonth, student, bookedInMonth) {
  var limit = bookingLimit(targetMonth, student);
  var regular = Math.max(0, Math.min(limit, Number(student.monthlyCount || 0) - Number(bookedInMonth || 0)));
  return { limit: limit, regular: regular, carry: Math.max(0, limit - regular) };
}

/**
 * 毎月の付与（logic-nichiji 3.2）
 * 残り ＝ 残り ＋ 月の回数 − 先使い、先使い ＝ 0。繰越上限があれば min(残り, 上限＋月の回数)
 */
function monthlyGrant(student, carryLimit) {
  var remaining = Number(student.remaining || 0) + Number(student.monthlyCount || 0) - Number(student.advance || 0);
  if (carryLimit !== null && carryLimit !== undefined && carryLimit !== '') {
    remaining = Math.min(remaining, Number(carryLimit) + Number(student.monthlyCount || 0));
  }
  return { remaining: remaining, advance: 0 };
}

if (typeof module !== 'undefined') {
  module.exports = {
    ymOf: ymOf, ymAdd: ymAdd, applyMonthFor: applyMonthFor, initialGrant: initialGrant,
    consumeColumn: consumeColumn, bookingLimit: bookingLimit, countBreakdown: countBreakdown, monthlyGrant: monthlyGrant,
  };
}
