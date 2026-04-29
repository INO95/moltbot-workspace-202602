# Moltbot Workspace

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md)

Moltbot Workspace は、Telegram から届いた依頼を役割別のボットとローカル自動化に振り分けて処理する、個人用の運用ワークスペースです。

このリポジトリには、コード、設定テンプレート、テスト、運用ドキュメントを置きます。トークン、認証ファイル、ログ、個人記録などの機密情報はコミットせず、ローカルまたは非公開の場所で管理します。

## 主な役割

- Telegram ブリッジ: `단어:`, `작업:`, `점검:`, `운영:` のような入力を適切な処理に送ります。
- OpenClaw ランタイム: `dev`, `anki`, `research`, `daily`, `codex` などの役割ボットを管理します。
- 運用キュー: ファイル操作、再起動、外部ツール実行など注意が必要な作業を承認フローで処理します。
- 個人自動化: 家計、ToDo、ルーティン、運動、コンテンツ、場所の記録を扱います。
- 学習とレポート: Anki 単語処理、ニュース収集、レポート作成、モデルルーティング確認を支援します。
- 安全チェック: 機密情報スキャン、コンテナ分離、ランタイムファイル追跡防止、運用回帰テストを実行します。

## フォルダ構成

- `scripts/`: ブリッジ、ボット運用、テスト、自動化スクリプト。
- `scripts/lib/`: ブリッジと運用フローの共通ロジック。
- `packages/`: 共通ポリシー、ルーティング、運用モジュール。
- `contracts/`: OpenClaw プロファイルテンプレートなどの契約ファイル。
- `data/config.json`: ルーティングと機能ポリシーの基本設定。
- `ops/`: 運用キュー、アラート、実行状態を扱う領域。
- `notes/`: 意思決定、運用手順、セキュリティポリシー文書。
- `docs/`: 長めの実行ガイドと変更マップ文書。
- `.github/workflows/`: GitHub のチェックフロー。

## クイックスタート

必要なパッケージをインストールします。

```bash
npm ci
```

基本の回帰テストを実行します。

```bash
npm run -s test:v1-release
npm run -s test:ops
```

OpenClaw のライブコンテナを起動・停止します。

```bash
npm run -s openclaw:up
npm run -s openclaw:down
```

運用状態を確認します。

```bash
npm run -s ops:daily:health
node scripts/bridge.js auto "운영: 액션: 상태; 대상: daily"
```

注意: このプロジェクトの `npm test` は実際のテスト一式ではありません。上のような名前付きのテストコマンドを使います。

## よく使うコマンド

ブリッジ自動ルーティング:

```bash
node scripts/bridge.js auto "단어: absorb"
node scripts/bridge.js auto "작업: 요청: 브릿지 라우팅 점검; 대상: scripts/bridge.js; 완료기준: 테스트 통과"
```

OpenClaw の認証と設定:

```bash
npm run -s openclaw:auth:sync
npm run -s openclaw:config:sync:check
npm run -s openclaw:approvals:status
```

安全チェック:

```bash
npm run -s check:container-isolation-refs
npm run -s check:runtime-artifact-tracking
npm run -s check:openclaw-profile-templates
npm run -s check:secrets-scan-workflow
```

OpenClaw バックアップ:

```bash
npm run -s backup:openclaw
npm run -s backup:openclaw:verify
```

## 安全ルール

- リポジトリ直下に `.env` を作りません。
- ランタイム環境値は `$HOME/.config/moltbot/runtime.env` に置きます。
- `configs/**/auth-profiles.json`, `data/secure/*`, `logs/`, `memory/`, `reports/` は Git に入れません。
- API キー、Telegram トークン、OAuth セッション、個人データはコミットしません。
- 高リスクの運用作業は承認トークンフローを通します。
- OpenClaw コンテナはローカルバインドと分離設定を維持します。

## GitHub チェック

PR と `main` には次のチェックがあります。

- `core-regression`: コアルーティング、個人自動化、運用フローのテスト。
- `gitleaks`: 機密情報パターンのスキャン。
- `trufflehog`: 履歴内の機密情報スキャン。
- `guard`: コンテナ分離基準のチェック。

## 詳しいドキュメント

- 運用手順: `notes/OPERATIONS_PLAYBOOK.md`
- OpenClaw ルーティング: `notes/OPENCLAW_ROUTING.md`
- ランタイム実行ガイド: `docs/openclaw_runtime_runbook.md`
- 公開/非公開分離ポリシー: `notes/PRIVACY_SPLIT_PLAYBOOK.md`
- OpenClaw ロックダウンポリシー: `notes/OPENCLAW_LOCKDOWN_RUNBOOK.md`
- 最近の OpenClaw 更新記録: `notes/OPENCLAW_UPDATE_2026-04-29.md`
