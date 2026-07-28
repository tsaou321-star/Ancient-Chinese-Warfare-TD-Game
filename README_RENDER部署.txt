還不快救主！v0.10.18 AI攻速與武將特效優化版

【完整工程包內容】
- index.html：完整遊戲頁，已內嵌黃忠煙火素材。
- server.js：Node WebSocket 房間伺服器。
- package.json / package-lock.json：Node 啟動設定。
- render.yaml：Render Web Service 自動部署設定。
- .gitignore：Git 忽略規則。
- 修改測試說明.md：本版修改與測試項目。

【Render 部署】
1. 把本資料夾內所有檔案上傳到 GitHub 儲存庫根目錄。
2. Render 會依 render.yaml 建立 Node Web Service。
3. Build Command：npm install
4. Start Command：npm start
5. Health Check：/health
6. 遊戲頁與 WebSocket 使用同一個 Render 網址。

【本版主要修改】
- 所有 AI 攻速倍率統一為 1.00，只保留傷害倍率差異。
- 劉備技能期間，己方單位文字變色並發光。
- 趙雲改為 CD 7 秒、2 秒內來回衝殺最多 7 名敵人，每名承受 150% 傷害兩次。
- 黃忠使用玩家提供並已去背的爆光素材，素材已嵌入 HTML。

部署時請使用完整工程包，不要只替換 HTML。
