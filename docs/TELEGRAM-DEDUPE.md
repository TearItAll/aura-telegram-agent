# Telegram 重送去重

Webhook 會先回 200，再在背景處理訊息。Telegram 沒有及時收到 200 時（逾時或網路問題），會重送同一個 `update_id`。如果不處理，重送會被當成新訊息再跑一次，可能多產生一份計畫預覽，或多花一次 Gemini 呼叫。確認動作本身已有交易保護，不會重複寫入。

## 做法

- **資料表**：`migrations/0006_telegram_updates.sql` 新增 `aura_telegram_updates(update_id INTEGER PRIMARY KEY, received_at INTEGER)`。只存數字 `update_id` 與收到的時間，不存訊息內容、chat 或使用者 ID。
- **流程**（`worker.js`）：通過 webhook secret、授權使用者與私人對話檢查後，在背景處理前先執行 `INSERT … ON CONFLICT(update_id) DO NOTHING`。
  - 寫入成功：照常處理，並順手刪除 7 天前的紀錄（Telegram 最多重試約 24 小時）。
  - 已經存在：略過這則訊息，只記一行不含 ID 的日誌。
- **失敗時照常處理（fail open）**：缺少 `update_id`、資料表不存在或 D1 出錯時，訊息照常處理，行為就和沒有去重時一樣，並記一行固定文字。所以程式和 migration 可以任意順序上線；migration 執行之前，去重只是暫時沒有作用。
- 陌生人和群組訊息在檢查階段就被擋下，不會寫入這張表。

## 保證範圍

- **D1 保證的**：同一個 `update_id` 只會有一次 INSERT 成功，並行重送也一樣，因為主鍵衝突是原子的。
- **不保證的**：這不是 exactly-once。去重紀錄寫入後、處理途中 Worker 中斷的話，Telegram 已經收到 200 不會重送，那則訊息就不會完成。D1 故障時，會退回「可能重複處理」。

## 測試

- `tests/security.test.mjs`：並行與事後重送都只處理一次；其他使用者與群組不寫入；7 天前的紀錄會被刪除；沒有資料表或沒有 `update_id` 時照常處理，而且日誌不含 ID。
- `tests/workerd.integration.mjs`：在 workerd 的 D1 上重送同一個 `update_id`，只回覆一次。
- 測試用的訊息產生器每次都使用新的 `update_id`，避免一般測試被誤判成重送。
