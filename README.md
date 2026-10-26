# AURA Telegram Agent

AURA 是一個用繁體中文溝通的**個人 Telegram AI 助理**，跑在 Cloudflare Workers 上。它把行事曆、長期記憶、任務管理、AI 任務規劃和每日科技新聞整合在同一個對話裡；AI 提出的資料變更都要先預覽，再由使用者確認。

> 這是為單一使用者設計的個人專案，不是多使用者服務。以 [MIT 授權](LICENSE) 公開。

## 設計重點

這個專案最核心的設計是 **AI 提案 → 人工確認 → 交易內驗證 → 執行**：

- AI 只負責提出內容（例如子任務清單），不能決定要寫入哪裡、寫給誰或何時執行。
- 每份預覽都有專屬 ID，綁定擁有者、內容雜湊和資料快照；確認時在同一個資料庫交易內重新檢查，所以重複確認、同時確認或資料已變更時都不會誤寫。
- 確認失敗時會說明原因，日誌只記錄固定的原因代碼，不記錄個人資料。

詳細設計見 [規劃任務的確認](docs/PLAN-CONFIRMATION.md) 與 [修改計畫的確認](docs/PLAN-REVISION-CONFIRMATION.md)。

## 功能

| 功能 | 說明 |
| --- | --- |
| Telegram 對話 | 只回應單一授權使用者的私人對話；webhook 以 secret 驗證；重送的同一則訊息只處理一次 |
| AI 對話 | 以 Gemini 回答問題，並可依問題呼叫任務查詢、行事曆查詢等工具 |
| Google 行事曆 | OAuth 連接；查詢未來七天；用自然語言新增、修改、刪除，先預覽再確認 |
| 長期記憶 | 明確要求才記住；可列出、修改、刪除，修改與刪除先預覽再確認 |
| 任務管理 | 新增、列出、更新狀態、設定優先順序與截止時間（台灣時間） |
| 到期提醒 | 每 5 分鐘檢查一次，任務在一小時內截止時主動提醒，同一個截止時間只提醒一次 |
| AI 任務規劃 | 把任務拆成 1–10 個子任務，預覽附上專屬 ID，確認後才儲存；重複確認不會重複新增 |
| AI 修改計畫 | AI 提出改名或新增步驟，預覽確認後套用；進行中或已完成的步驟不會被改 |
| 進度與分析 | 查看計畫、完成步驟、建議下一步、AI 分析與檢視計畫、AI 分析任務優先順序 |
| 每日科技新聞 | 每天台灣時間 09:00 左右，整理前一天 OpenAI、Google、Apple、NVIDIA 官方來源的新聞；同一天只發一次，漏發時隔天會說明 |

## 使用方式

以下都是在 Telegram 對 AURA 傳送的文字，範例中的名稱都是虛構的。

### 開始與行事曆

| 指令 | 作用 |
| --- | --- |
| `/start` | 顯示歡迎訊息 |
| `/connect` | 取得 Google 行事曆授權連結 |
| `/calendar` | 列出未來七天的行程（最多 20 筆） |

行事曆的新增、修改、刪除直接用自然語言說，例如「明天下午三點和小陳開會一小時」。AURA 會先回覆預覽，再依指示傳：

| 指令 | 作用 |
| --- | --- |
| `確認新增`／`取消新增` | 確認或放棄新增的行程 |
| `確認修改` | 確認修改行程 |
| `確認刪除` | 確認刪除行程 |

預覽 10 分鐘內有效，而且只能確認未來的時間。

### 長期記憶

| 指令 | 作用 |
| --- | --- |
| `記住：示範報告使用繁體中文` | 新增一筆記憶 |
| `查看記憶`（或「列出記憶」「你記得我什麼」） | 列出記憶 |
| `修改記憶：示範報告 => 示範報告使用繁體中文及圖表`，再傳 `確認修改記憶` | 修改記憶 |
| `忘記：示範報告`，再傳 `確認忘記` | 刪除記憶 |

### 任務

| 指令 | 作用 |
| --- | --- |
| `新增任務：準備示範簡報` | 新增任務 |
| `任務清單`（或「查看任務」「列出任務」） | 列出任務（最多 20 筆） |
| `更新任務狀態：準備示範簡報 => 進行中` | 狀態可用：尚未開始、進行中、已完成 |
| `設定任務優先順序：準備示範簡報 => 高` | 優先順序可用：低、一般、高 |
| `設定任務截止日期：準備示範簡報 => 2027-01-15 18:00` | 以台灣時間設定；改成 `清除` 可移除截止時間 |

任務指令會直接寫入，沒有第二次確認。

### AI 任務規劃

| 指令 | 作用 |
| --- | --- |
| `規劃任務：準備示範簡報` | AI 產生子任務預覽（還沒儲存） |
| `確認計畫 <計畫ID>` | 儲存預覽中的子任務；請複製預覽裡的完整指令 |
| `取消計畫 <計畫ID>` | 放棄這份預覽 |
| `查看計畫：準備示範簡報` | 列出子任務與進度 |
| `完成步驟：準備示範簡報 => 1` | 把第 1 個子任務標成已完成 |
| `設定步驟狀態：準備示範簡報 => 2 => 進行中` | 設定某個子任務的狀態 |
| `建議下一步：準備示範簡報` | 依步驟狀態建議下一步（不呼叫 AI） |
| `AI 分析下一步：準備示範簡報` | 由 AI 分析下一步（不寫入資料） |
| `AI 檢視計畫：準備示範簡報` | 由 AI 檢視計畫，只提供意見（不寫入資料） |
| `AI 修改計畫：準備示範簡報` | AI 提出修改預覽（最多三項改名或新增） |
| `確認修改計畫 <修改ID>`／`取消修改計畫 <修改ID>` | 套用或放棄修改預覽 |

規則：

- 每份預覽都有自己的 ID，10 分鐘內有效。同時有多份預覽時，只會套用你確認的那一份。
- 只傳 `確認計畫` 而不帶 ID，不會寫入任何資料，只會提示正確格式。
- 同一個 ID 重複確認，只會儲存一次，第二次會回覆「本次沒有重複新增」。
- 確認失敗時會說明原因：已取消或失效、已超過 10 分鐘、預覽後任務或步驟已變更，或原因不明（可在 10 分鐘內用同一個 ID 重試）。詳見 [原因代碼](docs/CONFIRM-REASON-CODES.md)。
- 已經有子任務的任務不能再用「規劃任務」，請改用「AI 修改計畫」。

### 自然語言

不符合上面任何指令的訊息會交給 Gemini 回答。

- **任務分析**：訊息同時提到「任務／待辦／計畫／步驟」和「分析／建議／優先／排序」時，AURA 會讀取任務與子任務後分析，例如「幫我分析目前任務的優先順序」。
- **工具**：Gemini 可以查詢任務清單和行事曆，也可以準備行事曆的新增、修改、刪除預覽，但真正寫入一定要等你確認。

### 每日科技新聞

- 每天台灣時間 09:00–09:59 的第一個排程，會整理**前一天**（台灣時間 00:00–23:59）的新聞並主動傳給你。
- 來源是 OpenAI、Google、Apple Newsroom、NVIDIA Developer 的官方 RSS，以關鍵字篩選，最多五則。這不是全網查核。
- 預設只送原文標題、簡介、日期和連結。可以另外開啟 Gemini 繁中摘要（見「設定」）。
- 同一天只發一次；傳送結果不明時不會重送，避免重複。前一天沒有完整送達時，當天速報的第一則會說明，但不會補發。
- 手動預覽指令 `昨日科技新聞`、`科技新聞 YYYY-MM-DD`，只有在 `DAILY_NEWS_PREVIEW_ENABLED=true` 時才有作用。

## 安全設計

- **單一使用者**：只接受設定的 Telegram 使用者 ID，而且只限私人對話；其他訊息一律忽略。
- **先預覽、後確認**：AI 提出的計畫、修改、行事曆與記憶變更都要人工確認。規劃任務與修改計畫的確認在同一個 D1 交易內檢查與寫入。
- **重送去重**：Telegram 重送的同一則訊息只處理一次，詳見 [重送去重](docs/TELEGRAM-DEDUPE.md)。
- **憑證保護**：Google refresh token 以 AES-GCM 加密後才存放；所有憑證都存成 Worker secrets，不寫在程式或設定檔裡。
- **日誌**：不記錄訊息內容、上游錯誤內容、ID 或 token；確認失敗只記錄固定的原因代碼。
- **外部資料不可信**：新聞內容和模型輸出都不會被當成指令；新聞的連結和日期由程式從官方來源取得，不由模型產生。
- **用量控制**：新聞 AI 摘要每天最多呼叫一次，輸入上限 6,000 tokens、輸出上限 2,000 tokens；失敗時退回來源簡介，不自動重試。

## 架構

```
Telegram ──webhook──▶ Cloudflare Worker（worker.js）
                        ├─ src/task-plan-actions.js    規劃任務的預覽與確認
                        ├─ src/task-plan-revisions.js  修改計畫的預覽與確認
                        ├─ src/daily-news.js           每日新聞的收集、整理與發送
                        └─ src/news-ai.js              新聞 AI 摘要的用量上限
                        │
                        ├─ Gemini API                  對話、規劃、分析、新聞摘要
                        ├─ Google Calendar API         行事曆（OAuth）
                        ├─ D1  AURA_TASKS_DB           任務、子任務、確認紀錄、新聞紀錄、去重紀錄
                        ├─ KV  AURA_AUTH_STORE         加密 token、OAuth state、行事曆與記憶的待確認預覽
                        └─ KV  AURA_MEMORY_STORE       長期記憶
Cron（每 5 分鐘）──▶ scheduled()：到期提醒、每日新聞
```

## 專案結構

| 路徑 | 用途 |
| --- | --- |
| `worker.js` | Worker 入口：webhook、指令路由、Gemini、行事曆、記憶、任務、提醒 |
| `src/` | 規劃任務、修改計畫、每日新聞、新聞 AI 用量的模組 |
| `migrations/` | D1 migration 0001–0006，只新增資料表與 trigger |
| `scripts/build-local.mjs` | 把入口與模組打包成單檔 `dist/worker.js`（不納入 Git） |
| `scripts/security-scan.mjs` | 離線敏感資料掃描，只輸出檔案、行號和規則 |
| `tests/` | Node 單元測試與 workerd 整合測試 |
| `examples/` | 資料表結構範例，沒有任何資料 |
| `wrangler.example.json`、`.dev.vars.example` | 設定範例，所有值都是占位符 |
| `docs/` | 設計文件 |

## 架設自己的 AURA

### 1. 準備

- Telegram bot（向 BotFather 申請）與你自己的 Telegram 使用者 ID
- Gemini API key
- Google Cloud OAuth client（啟用 Calendar API，redirect URI 指向 Worker 的 `/oauth/callback`）
- Cloudflare 帳號：一個 Worker、一個 D1 資料庫、兩個 KV namespace

### 2. 資料庫

`tasks`、`task_steps` 兩張基本資料表的結構見 `examples/schema.local.sql`。建立後依序套用 `migrations/0001`～`0006`：

| 檔案 | 內容 |
| --- | --- |
| `0001_task_plan_actions.sql` | 規劃任務的確認紀錄，以及「內容不可修改」的 trigger |
| `0002_task_plan_revisions.sql` | 修改計畫的確認紀錄 |
| `0003_task_plan_status_final.sql` | 確認紀錄的狀態只能從 pending 改一次 |
| `0004_daily_news.sql` | 每日新聞發送紀錄 |
| `0005_daily_news_ai_budget.sql` | 新聞 AI 用量紀錄 |
| `0006_telegram_updates.sql` | Telegram 重送去重紀錄（保留 7 天） |

### 3. 設定

**Secrets**：

| 名稱 | 用途 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot 憑證 |
| `WEBHOOK_SECRET` | 驗證 Telegram webhook；也保護 `/test-gemini` 診斷端點 |
| `ALLOWED_USER_ID` | 唯一允許的 Telegram 使用者 ID |
| `GEMINI_API_KEY` | Gemini API 憑證 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Google OAuth client |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes 隨機金鑰的 Base64，用來加密 refresh token。**更換後，既有 token 會無法解密** |

**Bindings**：`AURA_TASKS_DB`（D1）、`AURA_AUTH_STORE`（KV）、`AURA_MEMORY_STORE`（KV）。範例見 `wrangler.example.json` 與 `.dev.vars.example`。

**每日新聞變數**（類型為 Text；只有一字不差的 `true` 才算開啟，預設全部關閉）：

| 名稱 | 用途 |
| --- | --- |
| `DAILY_NEWS_ENABLED` | 開啟每天 9 點的新聞 |
| `DAILY_NEWS_USE_AI` | 使用 Gemini 產生繁中摘要 |
| `DAILY_NEWS_AI_FREE_VERIFIED` | 你已確認 Gemini 用量在免費方案內的聲明；`USE_AI` 必須搭配它才會呼叫 AI |
| `DAILY_NEWS_PREVIEW_ENABLED` | 開啟手動預覽指令 |

**Cron**：每 5 分鐘一次（`*/5 * * * *`）。至少要有一次排程落在台灣時間 9 點那一小時內。

### 4. 部署

1. `npm run build:local` 產生單檔 `dist/worker.js`，並記下印出的 SHA-256。
2. 先在測試用的 Worker 與 D1 驗證，再部署到正式環境。
3. 設定 Telegram webhook 指向 Worker 的 `/telegram`，並帶上 `WEBHOOK_SECRET` 作為 secret token。

如果 Worker 的變數、Cron 是在 Cloudflare Dashboard 管理的，請注意 `wrangler deploy` 會用設定檔覆蓋它們。

## 開發與測試

需要 Node.js 22.13 以上（建議 24 LTS）。測試會攔截所有網路請求，只使用虛構資料，不會呼叫真實的 Google、Gemini、Telegram 或 Cloudflare。

```sh
npm run check            # 語法檢查
npm test                 # 單元測試（181 項）
npm run security:scan    # 離線敏感資料掃描
```

workerd 整合測試與單檔打包，需要先安裝鎖定版本的開發套件：

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm run build:local                      # 產生 dist/worker.js 並印出 SHA-256
npm run test:runtime                     # workerd 模組模式（23 個情境）
AURA_TEST_BUNDLE=1 npm run test:runtime  # 同樣的情境，改用單檔成品
npm run test:news-runtime                # 每日新聞的 workerd 測試（9 項）
```

## 已知限制

- 單一使用者；Google token 使用全域 KV key，不能直接當成多使用者服務。
- 行事曆與記憶的確認仍是較早的 KV 流程，沒有專屬 ID，也不是原子操作。
- Telegram 去重不是 exactly-once：處理途中 Worker 中斷時，那則訊息不會完成，Telegram 也不會重送；D1 故障時會退回「可能重複處理」。
- 行事曆最多顯示 20 筆。記憶只讀取第一頁最多 50 筆，再取其中最近 10 筆，不保證是全部記憶中最新的 10 筆。
- 新聞只依 RSS 簡介整理，「技術差異」通常寫素材不足；來源只有四家官方 RSS。
- 使用 AI 時，訊息、部分記憶、任務或行事曆內容可能會送到 Gemini，請不要輸入真實密鑰。

## 文件

| 文件 | 內容 |
| --- | --- |
| [PLAN-CONFIRMATION.md](docs/PLAN-CONFIRMATION.md) | 規劃任務的指定 ID 預覽、確認與交易 |
| [PLAN-REVISION-CONFIRMATION.md](docs/PLAN-REVISION-CONFIRMATION.md) | 修改計畫的確認、快照與交易 |
| [CONFIRM-REASON-CODES.md](docs/CONFIRM-REASON-CODES.md) | 確認失敗的原因代碼 |
| [TELEGRAM-DEDUPE.md](docs/TELEGRAM-DEDUPE.md) | Telegram 重送去重 |

## 授權

[MIT](LICENSE)
