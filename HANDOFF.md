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

## v0.1.3 原文插入位置（2026-10-14）

默认改为 BEFORE_PROMPT 背景参考，在主提示词之前，不再以 depth=0 的末尾系统消息注入。既有用户无此设置时自动采用新默认；不改变小说库、聊天绑定、已有预设或聊天消息。可选「最近玩家发言之前」：IN_CHAT + USER，按最近 is_user 消息计算深度，提供单独参考消息，不拼改用户原话。去掉原文前缀中的剧情控制、写作和隐瞒检索要求，仅保留资料类型标注。实际位置仍受 ST 提示词管理器控制，可在 Prompt Inspector 核对。

## v0.2.0 顺序小说阅读与原生工具（2026-10-14）

本节覆盖旧版“不会自动推进”等说明。用户要让角色卡参考原著连续推进，AI 判断当前段结束并索取后续。实现最小闭环：

- 新增 reader.js：cursorFor、readWindow、sequentialPrompt、advanceCursor、locatePassage、novelTools。顺序从现有 chunks 索引派生，用户看到 1-based 段号，内部 cursor 为 0-based。旧 IndexedDB 数据不迁移、不重切。章节默认锚点兼容。
- index.js：默认顺序模式，既有 binding.readMode 缺省也采用顺序；关键词模式可切回。每聊天绑定持久化 cursor/viewed/readerId/allowTools/readMode。窗口显示版本、段号、前后切换、手动跳转、粘贴原文候选定位、每轮1至3连续段；上方强调复用旧书。
- 通过 ctx.registerFunctionTool（ST release 1.19 官方 st-context.js 导出，tool-calling.js ToolManager）注册 novel_pocket_read 和 novel_pocket_advance。shouldRegister 动态检查当前绑定、enabled、readMode、allowTools。
- read 默认读当前下一段，可指定全文段号及count(1..3)，返回当前进度和原文，不推进。advance 只允许 current+1、下一段已读取、expected current相符；reading_id 防换聊天/换书误提交。重复推进、跳段、书尾、错误会话返回错误结果。
- 原文注入继续沿用 v0.1.3 背景默认 BEFORE_PROMPT；不改用户原话/预设。顺序头仅标当前/预读状态，工具行为规则放工具描述，不给额外写作格式要求。
- 工具调用属于正常聊天生成，结果可能保留在酒馆工具记录中、增加上下文和正常模型用量。不要声称零工具token或工具结果自动替换。手动模式及原文注入仍替换自身extension prompt、不永久追加小说消息。
- UI 读取 ctx.isToolCallingSupported 提示本地开关状态，不验证中转。ST canPerformToolCalls 排除 continue/quiet/impersonate，建议正常发送。工具未开启或模型不调用时手动推进，不自动反复重试、不额外轮询模型。
- 16项Node自动测试通过，包括模拟DOM/IndexedDB/酒馆注册接口的串联测试。已进行所有 JS 语法检查。没有真实手机浏览器布局或用户中转端到端测试。后续先验证一次正常发送是否出现读原文/推进工具记录，再根据实际连接处理。
