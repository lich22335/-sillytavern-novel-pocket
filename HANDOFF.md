# 小说随身库 v0.1.0 — 项目技术交接

2026-10-14；定位：SillyTavern 原生 UI 扩展，可本地复制安装。目标用户希望把数十万 Token 的小说导入，在小说世界中随意聊天；只要偶尔能检索相关原著段落即可，不需要昂贵的整本大模型预处理。

## 已完成

- `manifest.json` + `index.js` + `style.css`：酒馆原生扩展结构，有可在手机宽度下使用的浮动按钮、弹窗、上传/选书/章节选择/检索预览/删除。
- `core.js`：按章节切分；950字符片段、110重叠；中文 bigram / 英文词 BM25 倒排索引；去除连续重复片段；选择当前章节时提供该章原文兜底。
- `storage.js`：小说全文与片段存浏览器 IndexedDB，偏好和聊天绑定信息存 localStorage。小说不放 SillyTavern 的 server settings.json，以免超大文件污染配置。
- 官方 `generate_interceptor`（全局函数 `NovelPocket_beforeGeneration`） + `getContext().setExtensionPrompt` 在每轮消息发送前注入原著参考，默认为聊天 depth=0 / system role，拦截 `quiet` / `impersonate`，可一键关闭。
- 上传 TXT/MD；优先 UTF-8，失败回退 GB18030；20MB 文件上限；没有 Ollama、额外 API 调用或 Node 服务依赖。
- 5条 Node 单元测试通过、ESM 语法检查通过，约70万字符、300章的模拟文本中成功执行索引。

## 尚未完成/需注意

1. **没有接入用户真实运行中的 SillyTavern 做端到端测试**；请优先做安装烟测：上传小说 → 当前聊天启用 → 发送问题 → 打开酒馆 Prompt Itemization / Prompt Inspector，确认原文确实被注入。
2. 目前**不是 Embedding 向量检索**。用户明确接受娱乐用途、较低准确度，故最小可用版采用本地关键词/BM25；将来如用户觉得命中率差，再补 Ollama bge-m3 并注意浏览器跨域限制，或适配 ST server 现有 vectors API。
3. 小说存于浏览器，不在酒馆服务器共享。不同设备/浏览器相互看不到。若需要跨设备共享，优先通过 ST 服务端附件 API 管理小说，再为当前角色聊天绑定该服务端文件 ID；不要把几 MB 原文写入 extensionSettings。
4. EPUB 暂未实现。优先基于酒馆现有转换接口或打包 EPUB 解析库，不要直接把 ZIP 当 UTF-8 读入。
5. 用户没有 GitHub 仓库的地址，所以这里提供 ZIP 复制安装。上传扩展文件到用户自己的 GitHub 仓库根目录后，才能通过酒馆 Install Extension 输入 URL 安装。
6. 当前章节不自动前进。检索按最后几条聊天内容自动匹配；用户可以手动改章。保存的是按聊天 ID 的绑定，依赖 `ctx.chatId` 或 `ctx.getCurrentChatId()`；无已保存聊天时不会自动注入。
7. 还没有做真实 ST 的自动化集成测试。不要声称运行已验证。

## 验证命令

在目录下 `npm test`（Node 18+）以及 `node --check index.js`，均无需下载 npm 包。

## 后续建议顺序

1. 真实 ST 安装、最小对话烟测；定位注入事件时机或样式冲突。
2. 支持 TXT 更复杂章标题、EPUB 导入、文件大小和浏览器储存配额提示。
3. 若用户实际体验认为检索不相关，给查询提取增加中文分词 / Ollama embedding 可选项；不要预先耗费大量模型 Token 摘要整本小说。
4. 允许用户按段落（而不是只有按章）手动锚定开局；增加导出导入 IndexedDB 备份功能。


## v0.1.1 bootstrap 修复

- `manifest.json` 的 `js` 入口改为 `bootstrap.js`，此文件不使用静态 import，先创建高层级悬浮入口。
- `bootstrap.js` 再动态 import 原来的 `index.js`；点击入口时打开原面板，导入失败时显示精确错误。
- 扩展设置中增加备用按钮；旧内部 `#np-open` 隐藏，但保留 click 事件，供 bootstrap 调用。
- 注意：未在真实 SillyTavern 移动端完成验证。

## v0.1.2 手机窗口修复（2026-10-14）

用户已确认 1.19.0、扩展 0.1.1 已启用、设置快捷入口可见。修复窗口层级与移动端操作：管理窗口改用原生 dialog.showModal 进入浏览器顶层，避免被酒馆现有弹窗盖住；上传改为明确 button；顶部与底部各有文字关闭按钮，头尾固定、内容独立滚动；bootstrap 直接调用管理窗口函数。没有改动小说存储格式、检索算法及已有数据。实际用户设备尚需验证。
