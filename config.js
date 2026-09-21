// 公開されても問題のない値だけ置く（秘密情報は GAS のスクリプトプロパティ）
window.BEYOND_CONFIG = {
  liffId: '2011635422-YUCoskrr',
  // GAS Web アプリの URL（clasp deploy 後に差し替える）
  apiUrl: 'https://script.google.com/macros/s/AKfycbyE3QfRX_Z0WGW76FjUiNDhIEt6_n8DuXrHch_53kMGNzbVwlkwQkyt7HnD1elWaJOE/exec',
  // 新しい土台（Supabase の Edge Function。開発用プロジェクト）。URL に ?api=edge を付けたときだけ使う
  edgeApiUrl: 'https://acmshulzlasrflbjsnhw.supabase.co/functions/v1/api',
  schoolName: 'ビヨンド',
};
