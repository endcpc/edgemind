# 變更紀錄

## 未發布

- **生成與傳輸解耦(P1)**:Netlify 上每個回合都不再於 60 秒的請求裡生成 —— `POST /api/chat` 直接回 202,run 交給 15 分鐘的背景函式,頁面改用新的 `GET /api/runs/:id/stream?after=<seq>`(45 秒 SSE 讀取端,只讀 step log 與 `runs.partial`,附 `id:` 供斷線續讀)。長回覆因此**完全不會被平台切斷、不會重新生成、不會消失**;讀取端每 500ms 轉播一次即時文字,`runs.partial` 寫入節流 400ms。背景函式起不來(舊方案)時自動退回原本的串流分段,不影響可用性。`/runs/:id/stream` 也會接手背景孤兒重啟,並在重啟次數用盡時回 `done: paused` 讓頁面顯示「繼續執行」。
- **背景模式可用瀏覽器端工具**:`code_run` python 以前在背景模式直接報錯;現在會暫停等待開啟中的分頁執行(沒有分頁時 3 分鐘後略過,模型收到錯誤後繼續),因此「一律背景」不會犧牲 Python。
- **聊天斷流/重複輸出(重新修好)**:分段預算改為**從請求到達計時**(`reqStart` 中介層),Netlify 用 34 秒 soft / 42 秒 hard,留 18 秒收尾(以前 57 秒、只留 3 秒,冷啟動時 `continue` 根本送不出去)。被硬時限切斷的模型步驟不再「丟棄後無限重跑」:有背景函式時自動轉背景把同一步做完(前端保留已串出的文字,等背景輸出追上);沒有背景時最多重試 3 次,之後明確失敗並說明原因。剩餘時間不足 18 秒不開新的模型步驟。`STALE_LEASE_MS` 75→30 秒;過期的 run 不再讓新訊息卡在 409 `run_active`。背景模式恢復 `runs.partial` 即時輸出(1 秒節流)與孤兒自動重啟(最多 3 次),死掉的背景執行不再永久轉圈。前端:SSE 閒置 20 秒自動中止並改用 step log 接續(連線階段 30 秒),斷線不再 `load()` 清掉已顯示的內容;`continue` 會清掉被重跑步驟的舊文字並顯示「重新生成(第 N 次)」;自動續跑最多 3 次並有 backoff。
- **還原聊天串流修改**：撤回今天的「60 秒上限自動轉背景」、「背景模式即時輸出／自動重啟」以及 Vercel 長步驟改走背景模式，聊天串流回到之前的行為。保留 migration `0010` 的欄位（未使用，不影響既有資料）。
- **Vercel 部署**：新增 Vercel 部署目標（Build Output API＋Fluid compute，不使用 Vercel AI SDK／AI Gateway），見 `docs/deploy-vercel.md`。
- **排程不再空轉喚醒 Neon**：「下一個到期時間」與排程 token 的 HMAC 另存在物件儲存（`system/scheduler-hint.json`），沒有到期任務的 tick 直接從 S3 回覆，不跑 migration、不查資料庫；只有任務到期、提示遺失或超過 6 小時未更新時才連線 Neon。錯誤 token 也不再喚醒資料庫。排程頁「最近一次觸發」包含閒置 tick。
- **專案對話**：側邊欄點專案會接續該專案最近的對話（沒有對話時開啟專案頁），專案可展開顯示自己的對話（最新的在上）；「最近對話」只列不屬於專案的對話；對話選單新增「移到專案…」與「移出專案」，專案頁新增「繼續最近的對話」、「加入現有對話」與每列的「移出專案」；在專案中開新對話時列出可繼續的專案對話。`GET /api/conversations` 的 `projectId` 不是專案 ID 或 `none` 時回 400（以前會默默列出全部）。
- **密鑰**：名稱與介面使用同一套整理規則（全形、零寬字元、前後空白），不合法的名稱說明是哪個字元；儲存失敗的訊息顯示在對話框中且對話框不會被點外面關掉；清單載入失敗顯示原因與「重試」；儲存後確認清單中確實有它。`http_request` 找不到密鑰時說明是「完全沒有密鑰」還是名稱不符（列出現有名稱與相近名稱）；回應內容為空時加上說明，工具卡片的空結果顯示「（工具沒有回傳任何內容）」。所有 `/api` 回應加上 `Cache-Control: no-store`。
- 開發／測試：`DEV_DB_DRIVER=neon` 讓本機 API 使用正式環境的 Neon HTTP 驅動（搭配 `e2e/support/neon-http-proxy.mjs`），`E2E_DB=neon` 讓 E2E 走同一條路。

## 0.1.0（2026-11-15）

第一個完整版本。

- **第一期**：單人登入（PBKDF2、JWT Cookie、CSRF、速率限制）；供應商設定（LLM／搜尋／Embedding／Rerank／圖片，模型清單與連線測試）；自寫 LLM 適配層（OpenAI 相容 Chat Completions／Responses、Anthropic Messages、Gemini）；Agent Loop（分段續跑、背景模式、權限閘門與五種權限模式、稽核紀錄）；聊天介面（串流 Markdown、分支、重新生成、匯出）；專案與檔案（瀏覽器直傳 S3、分段上傳、版本）；內建工具 web_search、web_fetch、file_*、memory_*、todo、ask_user。
- **第二期**：知識庫 RAG（瀏覽器端解析與切塊、pgvector + 中日韓全文混合檢索、Rerank、背景重建索引）；Skills（zip、線上編輯、GitHub 匯入）；MCP 客戶端（Streamable HTTP、SSE、OAuth 2.1）；自動記憶與對話壓縮。
- **第三期**：code_run（伺服器端 QuickJS JavaScript、瀏覽器端 Pyodide Python）；密鑰保險庫與 http_request；內建 Skills e2b-sandbox、self-hosted-runner；image_generate；subagent；排程任務；用量儀表板與花費上限；PWA。
- **發布準備**：選填環境變數 `S3_FORCE_PATH_STYLE`（支援只接受虛擬主機式網址的服務）；Cloudflare `_routes.json`（只有 `/api/*` 進入 Functions）；`.nvmrc`（Node 22）；部署、設定與部署後檢查文件。
