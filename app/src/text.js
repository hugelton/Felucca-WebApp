// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The page's words, English and Japanese. Labels are the device's (upper case, as on its screen); there is
// no explanatory text in the page: names, values and short status messages only.

import { store } from "./dom.js";

const TEXT = {
  en: {
    connect: "Connect", disconnect: "Disconnect", connecting: "Connecting", nomidi: "No MIDI in this browser",
    denied: "MIDI access denied", nodevice: "No Felucca found", noreply: "No reply", lost: "Device lost",
    disconnected: "Disconnected", ready: "Ready", reading: "Reading", steps: "Steps", error: "Error",
    live: "LIVE", polling: "POLLING", offline: "OFFLINE", loaded: "Loaded", unsaved: "Applied, not saved",
    pending: "After playback stops", rejected: "Refused",
    sound: "SOUND", seq: "SEQ", mix: "MIX", library: "LIBRARY", project: "PROJECT", settings: "Settings",
    track: "Track", tracks: "Tracks", engine: "Engine", preset: "Preset", prev: "Prev", next: "Next", init: "Init",
    initQ: "INIT SOUND?", yes: "Yes", no: "No", close: "Close", messages: "Messages", flash: "Flash", free: "free",
    empty: "empty", presetsU: "User presets", projects: "Projects", fm6bank: "FM6 bank",
    global: "Global", device: "Device", editor: "Editor", system: "System", display: "Display", system_: "SYSTEM",
    dark: "DARK", light: "LIGHT", textSize: "Text size", language: "Language", theme: "Theme", font: "Font",
    monitor: "MIDI monitor", regular: "REGULAR", bold: "BOLD", off: "OFF", events: "EVENTS", notes: "NOTES",
    firmware: "Firmware", sync: "Sync", engines: "Engines", stepsN: "Steps", samples: "Samples", userBank: "User bank",
    slots: "slots", licences: "Licences", page: "Page", wave: "Wave",
    load: "Load", keep: "Keep", kept: "Kept", imported: "Imported", skipped: "skipped", audition: "Audition", badEngine: "Not on this device:",
    overwrite: "OVERWRITE", delete: "Delete", search: "Search", sort: "Sort", sort_modified: "MODIFIED", sort_created: "CREATED",
    sort_name: "NAME", sort_engine: "ENGINE", toSlot: "To slot", rename: "Rename", duplicate: "Duplicate", export: "Export",
    import: "Import", exportAll: "Export all", memoryOnly: "NOT SAVED", store: "Store", toLibrary: "To library", erase: "Erase",
    ok: "OK", cancel: "Cancel",
    saved: "Saved", save: "Save", restore: "Restore", restored: "Restored", backupSaved: "Backup saved", tooLarge: "too large",
    sent: "Sent", fromTrack: "From track", toTrack: "To track", voices: "voices",
    fm6BadSum: "a checksum was wrong", fm6Short: "some data was cut short", fm6NoVoice: "no 6-operator voices",
    fm6NotSysex: "not a SysEx file", fm6Is4op: "4-operator voices", fm6OtherBlocks: "no voices (other data of the format)",
    fm6OtherMaker: "another manufacturer's SysEx", fm6Universal: "universal SysEx",
    files: "Files", recInput: "Input", recFull: "The slot is full", recDenied: "No input:", recSilent: "Nothing came in",
  },
  ja: {
    connect: "接続", disconnect: "切断", connecting: "接続中", nomidi: "このブラウザは MIDI に未対応",
    denied: "MIDI が許可されていません", nodevice: "Felucca が見つかりません", noreply: "応答なし", lost: "接続が切れました",
    disconnected: "切断しました", ready: "準備完了", reading: "読み込み中", steps: "ステップ", error: "エラー",
    live: "LIVE", polling: "POLLING", offline: "OFFLINE", loaded: "読み込み", unsaved: "反映済み・未保存",
    pending: "停止後に反映", rejected: "拒否されました",
    sound: "SOUND", seq: "SEQ", mix: "MIX", library: "LIBRARY", project: "PROJECT", settings: "設定",
    track: "トラック", tracks: "トラック", engine: "エンジン", preset: "プリセット", prev: "前", next: "次", init: "初期化",
    initQ: "音を初期化しますか？", yes: "はい", no: "いいえ", close: "閉じる", messages: "メッセージ", flash: "フラッシュ", free: "空き",
    empty: "空", presetsU: "ユーザープリセット", projects: "プロジェクト", fm6bank: "FM6 バンク",
    global: "全体", device: "本体", editor: "エディタ", system: "システム", display: "表示", system_: "OS に合わせる",
    dark: "ダーク", light: "ライト", textSize: "文字の大きさ", language: "言語", theme: "テーマ", font: "フォント",
    monitor: "MIDI モニター", regular: "標準", bold: "太字", off: "オフ", events: "イベント", notes: "押鍵",
    firmware: "ファームウェア", sync: "同期", engines: "エンジン", stepsN: "ステップ数", samples: "サンプル", userBank: "ユーザーバンク",
    slots: "スロット", licences: "ライセンス", page: "ページ", wave: "波形",
    load: "読み込み", keep: "残す", kept: "ライブラリに追加", imported: "取り込み", skipped: "件スキップ", audition: "試聴", badEngine: "この本体にないエンジン:",
    overwrite: "上書き", delete: "削除", search: "検索", sort: "並び", sort_modified: "更新順", sort_created: "作成順",
    sort_name: "名前順", sort_engine: "エンジン順", toSlot: "スロットへ", rename: "名前", duplicate: "複製", export: "書き出し",
    import: "取り込み", exportAll: "全部書き出し", memoryOnly: "保存されません", store: "保存", toLibrary: "ライブラリへ", erase: "消去",
    ok: "OK", cancel: "やめる",
    saved: "保存済み", save: "保存", restore: "復元", restored: "復元しました", backupSaved: "バックアップを保存しました", tooLarge: "大きすぎます",
    sent: "送りました", fromTrack: "トラックから", toTrack: "トラックへ", voices: "音色",
    fm6BadSum: "チェックサムの違いあり", fm6Short: "途中で切れたデータあり", fm6NoVoice: "6 オペレーターの音色なし",
    fm6NotSysex: "SysEx ではありません", fm6Is4op: "4 オペレーターの音色です", fm6OtherBlocks: "音色なし（同じ形式のほかのデータ）",
    fm6OtherMaker: "ほかのメーカーの SysEx", fm6Universal: "ユニバーサル SysEx",
    files: "ファイル", recInput: "入力", recFull: "スロットがいっぱいです", recDenied: "入力が使えません:", recSilent: "音が入っていません",
  },
};
export const LANGS = ["en", "ja"];
const KEY = "felucca-editor-lang";
let lang = (() => { const s = store.get(KEY); return LANGS.includes(s) ? s : /^ja\b/i.test(globalThis.navigator?.language || "") ? "ja" : "en"; })();
export function setLang(l) { if (!LANGS.includes(l)) return; lang = l; store.set(KEY, l); document.documentElement.lang = l; }
export const getLang = () => lang;
export const t = (k) => TEXT[lang][k] ?? TEXT.en[k] ?? k;
export { TEXT };
