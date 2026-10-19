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

## v0.2.1 浏览与确认起点分离（2026-10-14）

用户反馈选段不清楚、预览挤在一起。新增独立浏览态 browseSelection={key,bookId,index}，仅保存在内存；按章节、段号、上一段/下一段和原文候选都只更新预览。np-anchor-apply统一确认选段，写入cursor并切换顺序模式。np-current回到已保存进度；跨聊天/书检查防止旧预览误应用。全文原文预览使用textContent、无1200字符截断；不计入AI已预读viewed，也不污染上一轮参考记录。原np-chapter移到高级设置，只做关键词优先。

窗口主控件分层，设置/导入/记录/删除折叠；.np-body > * flex-shrink:0修复主滚动容器中子项压缩，预览独立滚动，16px/1.85行高。16项测试通过，串联测试新增浏览不修改cursor、确认才推进、超过1200字符显示完整以及返回当前进度；没有真机布局验证。bootstrap/存储/工具接口未改。

## v0.2.2 预设后、正文前（2026-10-14）

用户明确要求原文在前置预设后、聊天正文前。核对 ST 1.19 openai.js：BEFORE_PROMPT映射start，IN_PROMPT映射end（不能保证聊天前）；改用IN_CHAT/SYSTEM，depth=max(1,ctx.chat.length)，在每轮请求里动态插到聊天历史开头，避免固定depth随着消息增长而落到历史中间。不重排用户预设；预设自身的历史后条目仍不改变。background旧偏好直接采用新位置，保留最近用户发言前选项。更新核心位置测试和串联位置断言，16项通过。

## v0.3.0 章节优先与旧书重切（2026-10-19）

用户希望章节/自然段保持完整，而非950字切碎。core.chunkBook改为chapterLimit=12000：不超过则一章一个chunk；超长章使用原文换行边界把完整自然段分组到paragraphTarget=6000，绝不段内硬切，无重叠；单自然段超限仍完整保留。chunkVersion=2、sourceText保存原始全文，chunk附unit/section/sections便于标记。parseChapters新增Markdown、带空格中文、英文大小写与方括号标题。buildIndex扫描整章全文，makePrompt关键词模式同样只取完整chunk、不slice截断；预算为软预算，首章完整保留。

rebuildBook纯函数必须获得原文，不拼接推测旧重叠块。保持bookID、createdAt及绑定，按旧进度原文开头100个非空白字符+同章标题匹配映射所有关联聊天，失败回退同章开头；清空viewed和readerId避免旧工具误提交。index新增分段管理按钮：有sourceText直接重切，旧书通过pendingRebuildId请求重新选原TXT，调用同一本书更新路线，不重复导入。普通上传/取消清除pending。先保存新书，再应用新绑定；切完清理索引、预览与参考状态。不要声称旧书仅更新插件就自动变整章，用户需重新选原文件并确认定位。

23项Node自动测试和全JS语法通过，覆盖超长章只段落边界、长自然段不切、预算不截断、长章开头检索、源文保存与ID保持、旧书实际文件导入串联、不重复书、各聊天进度映射、旧工具会话拒绝。模拟DOM/IndexedDB接口不是手机端到端验证。保留源文会额外占用浏览器存储；本轮未改底层数据库名/版本。

## v0.3.1 严格限量发送与章内进度（2026-10-19）

用户担心完整长章撑爆上下文，授权把存储/浏览与发送分离。本轮不改chunkBook和已有书/编号，不要求重传。core.boundedText严格限制原文字符，优先换行、再句末、再无标点硬限额（避开surrogate pair）；返回offset/endOffset/complete，后文不丢失。makePrompt关键词模式也限量并标部分参考。reader.readWindow新增offset参数，共享整窗口预算，不再首章超额；标注章内位置。默认maxChars4500；deliveryVersion=1升级把旧设置上限收至4500、更小保留，后续主动选6200/8000仍允许。

binding新增offset/viewedRanges/batchHistory。recordRead合并连续已提供字符区间，nextReadPosition找当前进度之后首个未读位置；advancePosition检查current_block/current_offset及目标位置，禁止越过当前章未读区间，跨章要当前章剩余已读且下一章开头已读。旧整段viewed数字不用于证明整章已读。工具schema新增offset及推进的current_offset/to_offset，原生read缺省接已提供原文末尾。每条最新玩家消息（对象+mes+chatkey）累计工具取文最多maxChars；普通注入独立maxChars。额度<400拒绝进一步取文；每轮不会无限追加，旧工具历史仍可能占上下文。重试同条玩家消息不重置quota，换发言重置。

UI完整预览不截断，增加本批文字范围及AI上一批/下一批手动发送进度，与整章浏览分开。手动切换清旧阅读ID、viewedRanges，防正在执行的旧工具误提交；历史上限100个，旧历史不足则按分批边界计算上一批。新书/换书/重切/手动章节起点清章内偏移。默认注入位置仍预设后、正文前。

27项Node测试及语法通过。新测试覆盖单巨段严格上限、段落/句末边界、所有批拼接无字符丢失重复、emoji边界、完整预览与有界发送分离、章内推进与未读缺口拒绝、手动前后批返回、工具单次与累计上限。没有真实手机/中转端到端验证。原文限额不含少量标记/JSON，不是token限额，更不能代替酒馆整请求预算。
