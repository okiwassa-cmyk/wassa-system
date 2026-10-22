# WASSA SYSTEM

沖縄・大宜味村の小さな宿（3室）フルスタック管理システム。
夫婦2名＋アルバイト2名で運営。FileMaker → 独自Webシステムに移行中。
メインオペレーター：**Risa**（「ユーザー」と呼ばずに名前で呼ぶ）
オーナー：**Yuji & Risa Mizokawa**（「Mizogawa」は誤り）

## 主要ファイル

- `wassa-guestbook.html` — スタッフ用管理画面（約6200行）
- `wassa-checkin.html` — ゲスト用チェックインフォーム
- `GAS/emailImport.gs` — OTA予約メール自動取り込み（GAS）
- `GAS/scheduledEmails.gs` — サンキューメール自動送信（GAS）
- `GAS/コード.gs` — GASメイン（CONFIG含む）
- ※GASファイルは全て `GAS/` フォルダに集約

## インフラ

- **Supabase** project: `mtsdhheqddrckksiqlim`
- **GAS (Google Apps Script)** — メール取り込み・自動送信・カレンダー連携
- **GitHub Pages** — wassa-checkin.html / wassa-guestbook.html をホスト
  - リポジトリ: `github.com/okiwassa-cmyk` → `wassa-system`

## 部屋

| ID | 名前 |
|----|------|
| S01 | スーペリアツイン01 |
| S02 | スーペリアツイン02 |
| DX | デラックス |

- スーペリア2室とも空きの場合は **S02を優先** して埋める

## DB 主要テーブル

- `reservations` — 予約（billing JSONB列に明細配列）
- `wassa_customers` — 顧客マスタ（family_id: 家族グループの共通ID）
- `reservation_companions` — 同室者（rel列: 続柄）
- `price_common` — 食事単価・スタッフPIN設定
- `quotes` — 見積書

## 作業ルール

- ファイルは `/Users/mizo/Desktop/WASSA SYSTEM/` に保存（Downloadsではない）
- **wassa-guestbook.html もGitHub Pagesで公開**しているため、変更後はGitHubへのアップが必要 → Risaに伝える
- GASファイル変更後:
  - `コード.gs` → GASエディタに全文コピペ → 「新しいバージョン」としてデプロイ
  - `emailImport.gs` / `scheduledEmails.gs` → GASエディタで貼り替え → 保存のみでOK

## 重要な仕様

### billing（明細）
- `reservations.billing` JSONB列に行配列を保存
- `is_ref:true` = 参考行（グレー表示、合計に含まない）
- OTA取り込み時はGASが自動生成 → `autoGenBillingRows()` は復元のみ
- 手動入力（直予約）のみ空白行を生成

### source（予約経路）の値
`楽天` / `じゃらん` / `一休` / `Booking.com` / `Agoda` / `公式HP` / `直予約`

- `公式HP` = R-WITHや489banなどの予約システム経由（OTA扱い、billingあり）
- `直予約` = 電話・対面など（billing手動入力）

### 宿泊税
- 沖縄県宿泊税: **2027年2月1日の宿泊分から**施行（施行前は課税しない）
- 計算：**1人1泊の素泊まり料金（税抜・朝夕食を除く）の1,000円未満を切り捨て → ×2% → 上限2,000円**
  - **免税点も最低額も無い**。「¥1,000 floor（最低¥1,000）」は誤り（2026/10/22訂正）
  - 例：税抜¥13,000 → ¥13,000×2% = **¥260**／税抜¥9,800 → ¥9,000×2% = **¥180**
  - 切り捨ては**1人あたりの金額**で行う（部屋代を人数で割ったあと）
- 大宜味村は**県税2%のみ**。県と市町村で分けるのは宮古島市・石垣市・恩納村・北谷町・本部町だけ
- コード側の定数：`wassa-guestbook.html` の `LODGING_TAX_START='2027-02-01'`

### スタッフPIN
- `price_common` テーブルの `pin_owner` / `pin_staff` 列に保存（localStorageは使わない）

### family_id
- 続柄が「子・息子・娘・長男・長女・次男・次女・三男・三女」の場合は顧客レコードを作らない

## システムの役割・位置づけ

- OTAの在庫管理（サイトコントローラー）は**あすなろ/すけさんが担当** → WASSAシステムは操作しない
- WASSAシステムの目的: **直予約**と**あすなろ経由の予約**を可視化・管理する
