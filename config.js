// 公開されても問題のない値だけ置く（秘密情報は GAS のスクリプトプロパティ）
window.BEYOND_CONFIG = {
  liffId: '2011635422-YUCoskrr',
  // 旧環境：GAS Web アプリの URL（?api=gas を付けたときだけ使う。引退予定）
  apiUrl: 'https://script.google.com/macros/s/AKfycbyE3QfRX_Z0WGW76FjUiNDhIEt6_n8DuXrHch_53kMGNzbVwlkwQkyt7HnD1elWaJOE/exec',
  // 新しい土台（Supabase の Edge Function。開発用プロジェクト）。既定の向き先（2026-09-23 に切り替え）
  edgeApiUrl: 'https://acmshulzlasrflbjsnhw.supabase.co/functions/v1/api',
  schoolName: 'ビヨンド',
};
