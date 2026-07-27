還不快救主！v0.10.4 房間直連與存檔救援版
================================================

本工程必須部署成 Render「Web Service」，不是 Static Site。
同一個服務同時提供遊戲網頁、/health 健康檢查與 /ws WebSocket。

【更新既有 Render 服務】
1. 將本資料夾的 index.html、game.html、server.js、package.json、package-lock.json、render.yaml 與 .gitignore 覆蓋到 GitHub 儲存庫根目錄。
2. 提交並推送 GitHub。
3. Render 等待自動部署；或 Manual Deploy → Deploy latest commit。
4. Events 顯示 Live 後，以 Ctrl+F5／手機完整重新整理開啟遊戲。

Render 設定維持：
- Runtime：Node
- Build Command：npm install
- Start Command：npm start
- Health Check Path：/health

【v0.10.4 聯機修正】
- 遊戲固定連向正式伺服器：
  https://ancient-chinese-warfare-td-game.onrender.com
- 即使 /health 顯示 Failed to fetch，建立／加入房間仍會直接嘗試 WebSocket，不再被健康檢查卡死。
- /health 加入跨來源許可，從其他網站或下載版開啟遊戲時也能檢查 Render。
- 自動清除舊版本殘留的 service worker，避免舊快取攔截 /health 或繼續顯示舊版 HTML。
- WebSocket 等待最長 60 秒，房間回覆等待 12 秒。

【房間操作】
1. 雙方開啟遊戲。
2. 輸入相同房間代號。
3. 一方按「建立房間」，另一方按「加入房間」。
4. 雙方按「準備」，倒數 3 秒開始。
5. 兩台裝置都會將自己顯示在下方。

【存檔說明】
- 同一個網站網址下，重新部署不會正常清除 localStorage 存檔。
- localStorage 依網站來源分開：本機 HTML、GitHub Pages、舊 Render 網址與新 Render 網址互相看不到存檔。
- v0.10.4 已修正：正式存檔消失時自動救回 v10 備份、v9 備份或 v9～v2 舊版正式存檔，即使舊遷移標記存在也會重新搜尋。
- 跨網址搬家仍需在舊網址開啟「武將府 → 存檔管理」，複製存檔碼，再到新網址貼上載入。這是瀏覽器同源安全限制，伺服器無法偷讀其他網址的 localStorage。

【目前限制】
- 仍是伺服器排序命令、兩端同步模擬，尚非完整防作弊權威運算。
- Render 重啟／部署會中止房間，暫無斷線重連。
- 房間存於記憶體，服務重啟後會清空。
