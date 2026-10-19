import { chunkBook, buildIndex, searchChunks, makePrompt, injectionPlacement, rebuildBook, chunkLabel } from './core.js';
import { cursorFor, readWindow, sequentialPrompt, advancePosition, offsetFor, recordRead, nextReadPosition, locatePassage, novelTools } from './reader.js';
import { saveBook, loadBook, deleteBook, listBooks } from './storage.js';

const PROMPT_KEY = 'novel-pocket-reference-v1';
const PREF_KEY = 'novel-pocket-settings-v1';
const defaults = { count: 5, maxChars: 4500, injectionMode: 'background', sequenceCount: 2, deliveryVersion:1, chatBindings: {} };
let preferences = readPreferences();
let active = null; // Single active book cached in memory, never sent to a remote API.
let activeIndex = null;
let initialized = false;
let toolsRegistered = false;
let toolRegistrationError = null;
let lastMatches = [];
let lastTitle = '';
let browseSelection = null;
let pendingRebuildId = null;
let toolTurn = null;
const el = id => document.getElementById(id);

function readPreferences() {
    try {
        const parsed = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        const safeBudget = parsed.deliveryVersion === 1 ? parsed.maxChars : Math.min(Number(parsed.maxChars) || 4500,4500);
        return { ...defaults, ...parsed, maxChars: Math.max(400,Math.min(8000,Number(safeBudget)||4500)), deliveryVersion:1, chatBindings: parsed.chatBindings || {} };
    } catch { return { ...defaults, chatBindings: {} }; }
}
function persist() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(preferences)); }
    catch (e) { report('浏览器未允许保存偏好：' + e.message, true); }
}
function context() { return globalThis.SillyTavern?.getContext?.(); }
function chatKey() {
    const ctx = context();
    if (!ctx) return null;
    const chatId = ctx.chatId || ctx.getCurrentChatId?.();
    if (!chatId) return null;
    const owner = ctx.groupId ? `group:${ctx.groupId}` : `character:${ctx.characters?.[ctx.characterId]?.avatar || ctx.characterId}`;
    return `${owner}:${chatId}`;
}
function currentBinding() {
    const key = chatKey();
    return key ? preferences.chatBindings[key] : undefined;
}
function bindingForCurrent(create = false) {
    const key = chatKey();
    if (!key) return null;
    if (create && !preferences.chatBindings[key]) preferences.chatBindings[key] = { bookId: '', enabled: false, chapter: null, readMode: 'sequence', cursor: 0, offset:0, viewed: [], viewedRanges:{}, batchHistory:[], allowTools: true };
    return preferences.chatBindings[key] || null;
}
function report(message, isError = false) {
    const status = el('np-status');
    if (status) { status.textContent = message; status.dataset.error = isError ? 'true' : 'false'; }
    if (isError) console.warn('[Novel Pocket]', message);
}
async function clearInjection() {
    try { await context()?.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false, 0); }
    catch (error) { console.warn('[Novel Pocket] Failed to clear prompt', error); }
}
async function openBook(id) {
    if (!id) { active = null; activeIndex = null; return null; }
    if (active?.id === id && activeIndex) return active;
    const book = await loadBook(id);
    if (!book) { active = null; activeIndex = null; return null; }
    const index = buildIndex(book.chunks);
    active = book;
    activeIndex = index;
    return book;
}
function chatQuery(messages) {
    const recent = (Array.isArray(messages) ? messages : [])
        .filter(item => item && !item.is_system && typeof item.mes === 'string' && item.mes.trim())
        .slice(-5);
    // Prioritize the player's recent action, while keeping character/person names from nearby dialogue.
    const pieces = recent.map(item => item.mes.replace(/<[^>]*>/g, ' ').slice(-450));
    const lastPlayer = [...recent].reverse().find(item => item.is_user);
    if (lastPlayer) pieces.push(lastPlayer.mes.slice(-500), lastPlayer.mes.slice(-500));
    return pieces.join(' ').slice(-1500);
}

/** Official SillyTavern generation interceptor: invoked before prompt assembly. */
globalThis.NovelPocket_beforeGeneration = async function (_chat, _contextSize, _abort, type) {
    await clearInjection();
    const key = chatKey();
    const binding = key && preferences.chatBindings[key];
    if (!binding?.enabled || !binding.bookId || type === 'quiet' || type === 'impersonate') return;
    try {
        const book = await openBook(binding.bookId);
        if (!book || key !== chatKey() || preferences.chatBindings[key]?.bookId !== binding.bookId) return;
        ensureReaderId(binding);
        registerReaderTools();
        const sequential = binding.readMode !== 'keyword';
        const matches = sequential
            ? readWindow(book, cursorFor(book, binding), preferences.sequenceCount, preferences.maxChars, offsetFor(book,binding))
            : searchChunks(activeIndex, book.chunks, chatQuery(context()?.chat), {
                limit: preferences.count, chapter: Number.isInteger(binding.chapter) ? binding.chapter : null,
            });
        const prompt = sequential ? sequentialPrompt(book, binding, matches) : makePrompt(book, matches, preferences.maxChars);
        if (sequential) rememberViewed(binding, matches);

        if (!prompt) return;
        // Clear and replace our own reference only; preset and chat messages stay intact.
        if (key !== chatKey() || !preferences.chatBindings[key]?.enabled) return;
        const placement = injectionPlacement(preferences.injectionMode, context()?.chat);
        await context()?.setExtensionPrompt?.(PROMPT_KEY, prompt, placement.position, placement.depth, false, placement.role);
        lastMatches = matches;
        lastTitle = book.title;
        renderLastMatches();
    } catch (error) {
        report('检索失败：' + (error?.message || error), true);
        await clearInjection();
    }
};

function renderLastMatches() {
    const region = el('np-last-matches');
    if (!region) return;
    region.replaceChildren();
    if (!lastMatches.length) {
        region.textContent = '还没有检索记录。开始聊天后会显示实际送出的原文片段。';
        return;
    }
    const meta = document.createElement('div');
    meta.className = 'np-small';
    meta.textContent = `${lastTitle} · 最近检索到 ${lastMatches.length} 段`;
    region.append(meta);
    for (const item of lastMatches) {
        const part = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `第 ${(item.id ?? item.part) + 1} / ${active?.chunks.length || '?'} 段 · ${active ? chunkLabel(active,item) : '正文'} · ${item.text.length} 字`;
        const content = document.createElement('p');
        content.textContent = item.text.slice(0, 1200);
        part.append(summary, content);
        region.append(part);
    }
}
function fillOptions(select, items, placeholder) {
    select.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = placeholder; select.add(empty);
    for (const [value, title] of items) {
        const opt = document.createElement('option'); opt.value = String(value); opt.textContent = title; select.add(opt);
    }
}
async function syncPanel() {
    const key = chatKey();
    const binding = currentBinding();
    const books = await listBooks();
    fillOptions(el('np-books'), books.map(item => [item.id, `${item.title} (${item.chapters}章)`]), '选择一本已导入的小说');
    el('np-books').value = binding?.bookId || '';
    el('np-enabled').checked = Boolean(binding?.enabled);
    el('np-count').value = String(preferences.count);
    el('np-budget').value = String(preferences.maxChars);
    el('np-injection-mode').value = preferences.injectionMode === 'user' ? 'user' : 'background';
    el('np-chat-label').textContent = key ? '当前聊天：可单独绑定小说' : '请先打开一个已保存的角色聊天';
    for (const id of ['np-books', 'np-enabled', 'np-chapter', 'np-read-mode', 'np-tools-enabled']) el(id).disabled = !key;
    const book = binding?.bookId ? await openBook(binding.bookId) : null;
    if (key !== chatKey()) return;
    syncReaderControls(book, binding);
    fillOptions(el('np-chapter'), (book?.chapters || []).map(item => [item.id, item.title]), '自动检索全部章节');
    el('np-chapter').value = binding?.chapter != null ? String(binding.chapter) : '';
    if (!book && binding?.bookId) report('当前聊天绑定的小说已不存在，请重新选择。', true);
    else if (book) report(`已准备：${book.title}，${book.chunks.length} 个片段；${binding?.enabled ? '自动检索已开启' : '自动检索未开启'}`);
    else report('上传 TXT 小说，选中后打开自动检索。');
    renderLastMatches();
}
async function importFile(file) {
    const replaceId = pendingRebuildId; pendingRebuildId = null;
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { report('首版只支持 TXT / Markdown。EPUB 请先转为 TXT。', true); return; }
    if (file.size > 20 * 1024 * 1024) { report('单个文件上限 20 MB。请分卷导入。', true); return; }
    try {
        report('正在读取并拆分小说……');
        const buffer = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { text = new TextDecoder('gb18030').decode(buffer); }
        if (text.trim().length < 100) throw new Error('文本太短或文件编码不正确');
        if (replaceId) {
            const previous = await loadBook(replaceId);
            if (!previous) throw new Error('待更新的小说已不存在，请重新选择小说');
            await applyRebuild(previous, text);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        const title = file.name.replace(/\.(txt|md|markdown)$/i, '');
        const result = chunkBook(text);
        const id = `np-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const book = { id, title, ...result, createdAt: Date.now() };
        await saveBook(book);
        active = null; activeIndex = null;
        const bind = bindingForCurrent(true);
        if (bind) { bind.bookId = id; bind.chapter = null; bind.enabled = true; bind.readMode = 'sequence'; bind.cursor = 0; bind.offset=0; bind.viewed = []; bind.viewedRanges={}; bind.batchHistory=[]; bind.readerId = ''; persist(); }
        await syncPanel();
        report(`导入成功：${title}，${result.chapters.length} 章、${result.chunks.length} 段。${bind ? '已在当前聊天启用。' : '请先打开聊天再绑定。'}`);
    } catch (error) { report('导入失败：' + (error?.message || error), true); }
    finally { if (el('np-upload')) el('np-upload').value = ''; }
}
async function applyRebuild(previous, sourceText) {
    report('正在按章节重新切分……');
    const result = rebuildBook(previous, preferences.chatBindings, sourceText);
    await saveBook(result.book);
    // Replace bindings only after the source and new chunks have been saved.
    preferences.chatBindings = result.bindings;
    persist(); active = null; activeIndex = null; browseSelection = null; lastMatches = []; lastTitle = '';
    await clearInjection(); await syncPanel();
    report(`已更新《${result.book.title}》：${result.book.chapters.length} 章、${result.book.chunks.length} 段。已对应各聊天的进度，请看预览确认起点。`);
}

async function runPreview() {
    const binding = currentBinding();
    if (!binding?.bookId) { report('请先为当前聊天选择小说。', true); return; }
    try {
        const book = await openBook(binding.bookId);
        if (!book) throw new Error('小说不存在');
        const query = el('np-query').value.trim() || chatQuery(context()?.chat);
        lastMatches = searchChunks(activeIndex, book.chunks, query, {
            limit: preferences.count,
            chapter: Number.isInteger(binding.chapter) ? binding.chapter : null,
        });
        lastTitle = book.title;
        renderLastMatches();
        report(`测试检索完成：${lastMatches.length} 段。这只是预览，不会调用大模型。`);
    } catch (error) { report('测试失败：' + error.message, true); }
}
async function removeBook() {
    const binding = currentBinding();
    if (!binding?.bookId) return;
    const book = await loadBook(binding.bookId);
    if (!confirm(`确定删除《${book?.title || '这本小说'}》吗？所有使用它的聊天都将失去这份资料。`)) return;
    const id = binding.bookId;
    await deleteBook(id);
    for (const entry of Object.values(preferences.chatBindings)) {
        if (entry.bookId === id) { entry.bookId = ''; entry.enabled = false; entry.chapter = null; entry.cursor = 0; entry.viewed = []; }
    }
    persist(); active = null; activeIndex = null; lastMatches = [];
    await clearInjection(); await syncPanel();
    report('小说已删除。');
}

function ensureReaderId(binding) {
    if (binding && !binding.readerId) { binding.readerId = `reading-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; persist(); }
}
function rememberViewed(binding, blocks) {
    recordRead(binding,blocks);
    binding.viewed = [...new Set([...(binding.viewed || []), ...blocks.filter(b=>b.complete && b.offset===0).map(b=>b.block)])].slice(-24);
    persist();
}
function toolAllowance() {
    const user = [...(context()?.chat || [])].reverse().find(m=>m?.is_user);
    const key = chatKey();
    if (!toolTurn || toolTurn.key!==key || toolTurn.user!==user || toolTurn.mes!==user?.mes) toolTurn={key,user,mes:user?.mes,used:0};
    return toolTurn;
}

function syncReaderControls(book, binding) {
    ensureReaderId(binding);
    const sequential = binding?.readMode !== 'keyword';
    el('np-read-mode').value = sequential ? 'sequence' : 'keyword';
    el('np-reader-controls').hidden = false;
    el('np-sequence-count').value = String(preferences.sequenceCount);
    el('np-tools-enabled').checked = binding?.allowTools !== false;
    const cursor = cursorFor(book, binding);
    el('np-progress').textContent = book ? `当前进度：第 ${cursor + 1} / ${book.chunks.length} 段 · ${book.chapters[book.chunks[cursor].chapter]?.title || '正文'}` : '先在上方选择已导入的小说';
    fillOptions(el('np-browse-chapter'), (book?.chapters || []).map(c => [c.id,c.title]), '按章节浏览');
    const key = chatKey();
    if (!book) browseSelection = null;
    else if (browseSelection?.key !== key || browseSelection?.bookId !== book.id) browseSelection = { key, bookId: book.id, index: cursor };
    for (const id of ['np-prev','np-next','np-block','np-jump','np-anchor','np-locate','np-browse-chapter','np-current','np-anchor-apply']) el(id).disabled = !book;
    renderBrowsePreview(book);
    el('np-batch-prev').disabled = !book || (cursor===0 && offsetFor(book,binding)===0);
    el('np-batch-next').disabled = !book;
    if (book) {
        const part=readWindow(book,cursor,1,preferences.maxChars,offsetFor(book,binding))[0];
        el('np-batch-info').textContent = `AI 当前从章内第 ${part.offset+1} 字开始，本批到第 ${part.endOffset} 字 / 共 ${part.totalChars} 字；每次原文最多 ${preferences.maxChars} 字符。完整原文仍在下面预览。`;
    } else el('np-batch-info').textContent='';
    el('np-rechunk').disabled = !book;
    el('np-rechunk').textContent = book?.sourceText ? '按章节重新切分' : '更新旧书分段（重新选原 TXT）';
    el('np-chunk-info').textContent = !book ? '新导入小说优先一章一段。' : book.chunkVersion === 2 ? '章节原文完整保存；发给 AI 时按自然段分批，超长自然段优先在句末断开，保留后续位置。' : '这本书仍是旧版碎片，更新插件不会自动改动它。用下面按钮重新选择原 TXT，保持同一本书和聊天绑定。';
    const supported = context()?.isToolCallingSupported?.();
    el('np-tool-status').textContent = toolRegistrationError ? `工具接口未就绪：${toolRegistrationError}；手动切换仍可用。`
        : !toolsRegistered ? '工具接口未就绪，手动切换可用。'
        : supported ? '酒馆工具接口已就绪；中转是否转发工具请求需实际聊天验证。'
        : '酒馆当前未启用工具调用。请在聊天补全设置开启「工具调用 / Function calling」，或手动切换。';
}
function setProgress(cursor) {
    const b = currentBinding();
    if (!b?.bookId || active?.id !== b.bookId) return report('先选择小说。', true);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= active.chunks.length) return report('段号超出小说范围。', true);
    b.cursor = cursor; b.chapter = active.chunks[cursor].chapter; b.viewed = []; b.viewedRanges={}; b.offset=0; b.batchHistory=[]; b.readerId=''; b.readMode = 'sequence';
    browseSelection = { key:chatKey(), bookId:active.id, index:cursor };
    persist(); clearInjection();
    syncReaderControls(active, b);
    report(`当前进度已设为第 ${cursor + 1} 段，下次回复生效。`);
}
function moveBatch(direction) {
    const b=currentBinding(); if (!active || active.id!==b?.bookId) return report('先选择小说。',true);
    let cursor=cursorFor(active,b), offset=offsetFor(active,b);
    const history=b.batchHistory || [];
    if (direction>0) {
        const part=readWindow(active,cursor,1,preferences.maxChars,offset)[0];
        if(part.complete) { if(cursor+1>=active.chunks.length) return report('已到最后一批。'); cursor++; offset=0; }
        else offset=part.endOffset;
        b.batchHistory=[...history,{cursor:cursorFor(active,b),offset:offsetFor(active,b)}].slice(-100);
    } else if(history.length) {
        const previous=history.at(-1); cursor=previous.cursor; offset=previous.offset;
        b.batchHistory=history.slice(0,-1);
    } else {
        if(offset===0) { if(cursor===0) return; cursor--; offset=active.chunks[cursor].text.length; }
        let start=0, previous=0;
        while(start<offset) { previous=start; const part=readWindow(active,cursor,1,preferences.maxChars,start)[0]; start=part.endOffset; }
        offset=previous;
    }
    b.cursor=cursor; b.offset=offset; b.chapter=active.chunks[cursor].chapter; b.readerId='';
    b.readMode='sequence'; b.viewedRanges={}; b.viewed=[];
    persist(); clearInjection(); syncReaderControls(active,b);
    report(`AI 进度已设为第 ${cursor+1} 段，章内第 ${offset+1} 字开始，下次回复生效。`);
}

function renderBrowsePreview(book = active) {
    const selected = browseSelection;
    if (!book || selected?.bookId !== book.id || selected.key !== chatKey()) {
        el('np-preview-title').textContent = '选择一本小说后，在这里阅读完整片段';
        el('np-block-preview').textContent = '';
        el('np-anchor-apply').textContent = '从这里开始';
        return;
    }
    const index = selected.index;
    const chunk = book.chunks[index];
    el('np-block').value = String(index + 1); el('np-block').max = String(book.chunks.length);
    el('np-browse-chapter').value = String(chunk.chapter);
    el('np-prev').disabled = index === 0; el('np-next').disabled = index === book.chunks.length - 1;
    el('np-preview-title').textContent = `预览第 ${index + 1} / ${book.chunks.length} 段 · ${chunkLabel(book,chunk)} · ${chunk.text.length} 字符`;
    el('np-block-preview').textContent = chunk.text;
    el('np-block-preview').scrollTop = 0;
    el('np-anchor-apply').textContent = `从预览的第 ${index + 1} 段开始`;
}
function browseBlock(index) {
    const b = currentBinding();
    if (!active || active.id !== b?.bookId) return report('先选择小说。', true);
    if (!Number.isInteger(index) || index < 0 || index >= active.chunks.length) return report('段号超出小说范围。', true);
    browseSelection = {key:chatKey(),bookId:active.id,index};
    renderBrowsePreview(active);
}
function movePreview(step) {
    if (active) browseBlock((browseSelection?.index ?? cursorFor(active,currentBinding())) + step);
}

function locateCurrentScene() {
    try {
        const b = currentBinding(); if (!active || active.id !== b?.bookId) throw new Error('先选择小说');
        const hits = locatePassage(active, el('np-anchor').value);
        if (!hits.length) throw new Error('没有找到，请粘贴更完整的原文或手动输入段号');
        const select = el('np-anchor-results'); select.replaceChildren();
        for (const hit of hits) {
            const opt = document.createElement('option'); opt.value = String(hit.id);
            opt.textContent = `${hit.exact ? '原文匹配' : '近似匹配'} · 第 ${hit.id + 1} 段 · ${active.chapters[active.chunks[hit.id].chapter]?.title || '正文'} · ${active.chunks[hit.id].text.slice(0, 25)}`;
            select.add(opt);
        }
        select.dataset.bookId = active.id;
        select.value = String(hits[0].id); select.hidden = false;
        browseBlock(hits[0].id);
        report('已显示匹配段落的完整预览。可切换候选，确认后点「从这里开始」。');
    } catch (e) { report(e.message, true); }
}
function toolsAllowed() {
    const b = currentBinding();
    return Boolean(b?.enabled && b.bookId && b.readMode !== 'keyword' && b.allowTools !== false);
}
async function toolBook(readingId) {
    if (!toolsAllowed()) throw new Error('当前聊天未启用小说顺序阅读工具');
    const key = chatKey(), binding = currentBinding(), id = binding.bookId;
    if (!readingId || readingId !== binding.readerId) throw new Error('阅读会话已改变，请读取当前聊天的小说参考');
    const book = await openBook(id);
    if (!book || key !== chatKey() || currentBinding() !== binding || binding.bookId !== id || !toolsAllowed()) throw new Error('聊天或小说绑定已改变，请重新读取');
    return { book, binding };
}
function registerReaderTools() {
    if (toolsRegistered) return;
    const ctx = context();
    if (typeof ctx?.registerFunctionTool !== 'function') { toolRegistrationError = '此酒馆没有 registerFunctionTool 接口'; return; }
    try {
        const definitions = novelTools({ enabled: toolsAllowed,
            read: async (p = {}) => {
                try {
                    const { book, binding } = await toolBook(p.reading_id);
                    const next = p.block == null && p.offset == null ? nextReadPosition(book,binding) : {block:p.block ?? cursorFor(book,binding)+1,offset:p.offset ?? 0};
                    if (!next) throw new Error('已读取到小说末尾');
                    const count = p.count ?? 1;
                    if (!Number.isInteger(next.block) || !Number.isInteger(next.offset) || !Number.isInteger(count) || count < 1 || count > 3) throw new Error('段号、偏移和count必须是合法整数，count为1至3');
                    const quota = toolAllowance();
                    const remaining = preferences.maxChars - quota.used;
                    if (remaining < 400) throw new Error('本条玩家消息的额外取文额度已用完；请发送下一条消息再继续读取，或手动切换批次');
                    const blocks = readWindow(book, next.block - 1, count, remaining, next.offset);
                    if (!blocks.length) throw new Error('该位置没有原文，请使用上一批end_offset继续读取');
                    quota.used += blocks.reduce((sum,b)=>sum+b.text.length,0);
                    rememberViewed(binding, blocks);
                    return { book: book.title, current_block: cursorFor(book,binding)+1, current_offset:offsetFor(book,binding), total_blocks:book.chunks.length, progress_changed:false, remaining_tool_chars:preferences.maxChars-quota.used, blocks:blocks.map(({block,chapterTitle,text,offset,endOffset,complete,totalChars})=>({block,chapter:chapterTitle,text,offset,end_offset:endOffset,complete,total_chars:totalChars})) };
                } catch (e) { return { error: e.message }; }
            },
            advance: async (p = {}) => {
                try {
                    const { book, binding } = await toolBook(p.reading_id);
                    const position=advancePosition(book,binding,p.current_block,p.current_offset ?? 0,p.to_block,p.to_offset ?? 0);
                    binding.batchHistory=[...(binding.batchHistory||[]),{cursor:cursorFor(book,binding),offset:offsetFor(book,binding)}].slice(-100);
                    binding.cursor=position.cursor; binding.offset=position.offset;
                    binding.chapter = book.chunks[binding.cursor].chapter; persist();
                    if (el('np-panel')?.open) syncReaderControls(book, binding);
                    await clearInjection();
                    return { current_block: binding.cursor + 1, current_offset:binding.offset, total_blocks: book.chunks.length, progress_changed: true };
                } catch (e) { return { error: e.message }; }
            },
        });
        for (const definition of definitions) ctx.registerFunctionTool(definition);
        toolsRegistered = true; toolRegistrationError = null;
    } catch (e) { toolRegistrationError = e.message; }
}

function injectUI() {
    const container = document.createElement('div');
    container.id = 'np-root';
    container.innerHTML = `
      <button id="np-open" type="button" title="小说随身库">小说</button>
      <div id="np-overlay" hidden></div>
      <dialog id="np-panel" aria-label="小说随身库">
        <header class="np-header"><div><strong>小说随身库 <small>0.3.1</small></strong><div class="np-small">顺序阅读 / 原文检索 · 本地小说库</div></div><button type="button" id="np-close" aria-label="关闭小说随身库">关闭</button></header>
        <div class="np-body">
          <p class="np-hint" id="np-chat-label"></p>
          <label for="np-books">本聊天使用的小说</label><select id="np-books"></select>
          <details class="np-fold"><summary>导入小说 / 小说库说明</summary>
            <p class="np-hint">换角色只需选已有小说。新导入优先一章一段，超长章节只按自然段拆开。</p>
            <button type="button" class="np-filebtn" id="np-upload-btn">＋ 上传小说（TXT / Markdown）</button>
            <input type="file" id="np-upload" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden />
          </details>
          <section id="np-reader-controls" class="np-reader">
            <strong id="np-progress">尚未选择小说</strong><p id="np-chunk-info" class="np-hint"></p><p id="np-batch-info" class="np-hint"></p><div class="np-browse-nav"><button type="button" id="np-batch-prev">AI 上一批</button><button type="button" id="np-batch-next">AI 下一批</button></div>
            <p class="np-hint">先浏览原文，选好后点「从这里开始」。浏览不会改变剧情进度。</p>
            <label for="np-browse-chapter">按章节找片段</label><select id="np-browse-chapter"></select>
            <div class="np-browse-nav"><button type="button" id="np-prev">上一段</button><button type="button" id="np-next">下一段</button><button type="button" id="np-current">回到当前进度</button></div>
            <div class="np-block-jump"><label for="np-block">段号</label><input type="number" id="np-block" min="1" aria-label="片段编号" /><button type="button" id="np-jump">查看</button></div>
            <div class="np-preview-heading" id="np-preview-title"></div>
            <div id="np-block-preview" tabindex="0" aria-label="完整原文预览"></div>
            <button type="button" id="np-anchor-apply" class="np-apply">从这里开始</button>
            <details class="np-fold"><summary>用原文查找位置</summary>
              <p class="np-hint">粘贴场景结尾的一两句原文，查找后会显示完整预览。</p>
              <textarea id="np-anchor" rows="3" placeholder="粘贴原文"></textarea><button type="button" id="np-locate">查找位置</button>
              <select id="np-anchor-results" aria-label="定位候选片段" hidden></select>
            </details>
          </section>
          <details class="np-fold" id="np-options"><summary>阅读设置 / AI 自动推进</summary>
            <label class="np-toggle"><input type="checkbox" id="np-enabled" /><span>向当前聊天提供小说原文</span></label>
            <label for="np-read-mode">阅读方式</label><select id="np-read-mode"><option value="sequence">顺序剧情</option><option value="keyword">关键词检索（自由探索）</option></select>
            <label for="np-sequence-count">顺序模式最多参考章节/段数（受字符限额约束）</label><select id="np-sequence-count"><option value="1">只参考当前章/段</option><option value="2">最多当前 + 下一章/段</option><option value="3">最多连续 3 章/段</option></select>
            <label class="np-toggle"><input type="checkbox" id="np-tools-enabled" /><span>允许 AI 读取后续并推进一段</span></label><p id="np-tool-status" class="np-hint"></p>
            <p class="np-hint">工具记录与后续回复会增加用量；不能调用时，浏览下一段后点「从这里开始」。</p>
            <label for="np-injection-mode">原文插入位置</label><select id="np-injection-mode"><option value="background">预设之后、聊天正文之前（默认）</option><option value="user">最近玩家发言之前</option></select>
            <label for="np-chapter">关键词检索优先章节</label><select id="np-chapter"></select>
            <label for="np-count">关键词检索片段数</label><select id="np-count"><option value="3">3段</option><option value="4">4段</option><option value="5">5段</option><option value="6">6段</option><option value="8">8段</option></select>
            <label for="np-budget">每次发送原文字符上限（严格限制，不是 Token 数）</label><select id="np-budget"><option value="3000">3000字</option><option value="4500">4500字</option><option value="6200">6200字</option><option value="8000">8000字</option></select>
          </details>
          <details class="np-fold"><summary>查看参考记录 / 检索测试</summary>
            <label for="np-query">关键词（留空用当前对话）</label><div class="np-search"><input type="text" id="np-query" placeholder="人名、事件、地点" /><button type="button" id="np-search-btn">查找</button></div>
            <div id="np-last-matches" class="np-results"></div>
          </details>
          <details class="np-fold"><summary>分段管理 / 小说数据</summary><p class="np-hint">保存在当前浏览器；不要为了更新清除网站数据。</p><button type="button" id="np-rechunk">按章节重新切分</button><p class="np-hint">旧版未存全文时，需重新选择原 TXT，小说库不会生成重复书；分段后的进度会按原文尽量对应，完成后请看预览确认。</p><button type="button" class="np-danger" id="np-delete">删除选中小说</button></details>
        </div>
        <footer class="np-footer"><div id="np-status" aria-live="polite">准备就绪</div><button type="button" id="np-close-bottom">关闭窗口</button></footer>
      </dialog>`;
    document.body.append(container);
    const close = () => { el('np-panel').close(); };
    const open = async () => {
        const panel = el('np-panel');
        if (!panel.open) panel.showModal();
        try { await syncPanel(); } catch (error) { report('读取失败：' + error.message, true); }
    };
    globalThis.NovelPocket_openManager = open;
    el('np-open').addEventListener('click', open);
    el('np-close-bottom').addEventListener('click', close);
    el('np-upload-btn').addEventListener('click', () => { pendingRebuildId = null; el('np-upload').click(); });
    el('np-upload').addEventListener('cancel', () => { pendingRebuildId = null; });
    el('np-rechunk').addEventListener('click', () => {
        const b = currentBinding();
        if (!active || active.id !== b?.bookId) return report('先选择小说。',true);
        if (typeof active.sourceText === 'string') {
            applyRebuild(active, active.sourceText).catch(e => report('重新切分失败：'+e.message,true));
        } else {
            pendingRebuildId = active.id;
            report('请重新选择这本书的原始 TXT，更新分段，不会重复导入。');
            el('np-upload').click();
        }
    });
    el('np-panel').addEventListener('click', event => {
        if (event.target !== el('np-panel')) return;
        const rect = event.target.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    el('np-close').addEventListener('click', close);
    el('np-overlay').addEventListener('click', close);
    el('np-upload').addEventListener('change', event => importFile(event.target.files?.[0]));
    el('np-books').addEventListener('change', async event => {
        const b = bindingForCurrent(true);
        if (!b) return;
        b.bookId = event.target.value; b.chapter = null; b.enabled = Boolean(b.bookId); b.cursor = 0; b.offset=0; b.viewed = []; b.viewedRanges={}; b.batchHistory=[]; b.readerId = '';
        el('np-anchor-results').hidden = true;
        persist(); active = null; activeIndex = null; await clearInjection(); await syncPanel();
    });
    el('np-enabled').addEventListener('change', async event => {
        const b = bindingForCurrent(true);
        if (!b) return;
        b.enabled = Boolean(event.target.checked && b.bookId);
        persist(); if (!b.enabled) await clearInjection(); await syncPanel();
    });
    el('np-chapter').addEventListener('change', event => {
        const b = bindingForCurrent(true); if (!b) return;
        b.chapter = event.target.value === '' ? null : Number(event.target.value);
        persist(); clearInjection(); syncPanel().catch(e => report(e.message, true));
    });
    el('np-read-mode').addEventListener('change', e => {
        const b = bindingForCurrent(true); if (!b) return;
        b.readMode = e.target.value === 'keyword' ? 'keyword' : 'sequence';
        persist(); clearInjection(); syncPanel().catch(err => report(err.message, true));
    });
    el('np-tools-enabled').addEventListener('change', e => {
        const b = bindingForCurrent(true); if (!b) return;
        b.allowTools = e.target.checked; persist(); syncReaderControls(active, b);
    });
    el('np-sequence-count').addEventListener('change', e => { preferences.sequenceCount = Number(e.target.value); persist(); clearInjection(); });
    el('np-batch-prev').addEventListener('click', () => moveBatch(-1));
    el('np-batch-next').addEventListener('click', () => moveBatch(1));
    el('np-prev').addEventListener('click', () => movePreview(-1));
    el('np-next').addEventListener('click', () => movePreview(1));
    el('np-jump').addEventListener('click', () => browseBlock(Number(el('np-block').value) - 1));
    el('np-locate').addEventListener('click', locateCurrentScene);
    el('np-anchor-results').addEventListener('change', () => {
        if (el('np-anchor-results').dataset.bookId !== currentBinding()?.bookId) return report('小说已更换，请重新查找位置。',true);
        browseBlock(Number(el('np-anchor-results').value));
    });
    el('np-browse-chapter').addEventListener('change', e => {
        if (!active || e.target.value === '') return;
        browseBlock(active.chunks.findIndex(c => c.chapter === Number(e.target.value)));
    });
    el('np-current').addEventListener('click', () => { if (active) browseBlock(cursorFor(active,currentBinding())); });
    el('np-anchor-apply').addEventListener('click', () => {
        if (browseSelection?.key !== chatKey() || browseSelection?.bookId !== currentBinding()?.bookId) return report('聊天或小说已更换，请重新浏览。',true);
        setProgress(browseSelection.index);
    });
    el('np-count').addEventListener('change', e => { preferences.count = Number(e.target.value); persist(); });
    el('np-budget').addEventListener('change', e => { preferences.maxChars = Number(e.target.value); preferences.deliveryVersion=1; persist(); clearInjection(); syncReaderControls(active,currentBinding()); });
    el('np-injection-mode').addEventListener('change', e => {
        preferences.injectionMode = e.target.value === 'user' ? 'user' : 'background';
        persist();
        clearInjection().catch(error => report(error.message, true));
        report('插入位置已保存，下次回复生效。');
    });
    el('np-search-btn').addEventListener('click', runPreview);
    el('np-query').addEventListener('keydown', e => { if (e.key === 'Enter') runPreview(); });
    el('np-delete').addEventListener('click', () => removeBook().catch(err => report(err.message, true)));
}
function initialize() {
    if (initialized) return;
    initialized = true;
    injectUI();
    registerReaderTools();
    const ctx = context();
    if (ctx?.eventSource && ctx?.event_types?.CHAT_CHANGED) {
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            lastMatches = []; lastTitle = ''; active = null; activeIndex = null;
            registerReaderTools();
            el('np-anchor-results').hidden = true;
            clearInjection();
            if (el('np-panel')?.open) syncPanel().catch(err => report(err.message, true));
        });
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
