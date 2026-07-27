還不快救主！v0.10.7 同源直連 AI 隨機帽版

本工程同時包含遊戲網頁與 WebSocket 房間伺服器，必須部署成 Render「Web Service」，不是 Static Site。

【本機測試】
1. 解壓縮工程包。
2. 在工程資料夾執行 npm install。
3. 執行 npm start。
4. 瀏覽器開啟 http://localhost:8787。
5. 遊戲會自動連線 ws://localhost:8787/ws。

直接雙擊 index.html 時，因 file:// 沒有主機名稱，聯機也只會嘗試 localhost:8787，不會呼叫任何 Render 網址；但仍建議用 npm start 後從 localhost 開啟。

【Render 部署】
- Runtime：Node
- Build Command：npm install
- Start Command：npm start
- Health Check Path：/health

部署在 https://任何名稱.onrender.com 時，遊戲會自動連線 wss://同一個網址/ws。更換 Render 專案名稱或自訂網域，不需要修改 HTML。

【v0.10.7 修改】
- 移除複雜的網址覆寫與 URL 解析流程。
- WebSocket 直接使用 location.host；本機就是本機，Render 就是目前 Render。
- 聯機畫面不再顯示「正在喚醒 Render」，統一稱作房間伺服器。
- 單機 AI 每場隨機選用一頂帽子，所有帽子等機率。
- 已確認 AI 武將原本就是每場從完整武將名單隨機抽四名且不重複，本版保留。

注意：localhost、file:// 與各個網站網域的 localStorage 彼此隔離，存檔不會自動共用。
