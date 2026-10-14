import { chunkBook, buildIndex, searchChunks, makePrompt, injectionPlacement } from './core.js';
import { saveBook, loadBook, deleteBook, listBooks } from './storage.js';

const PROMPT_KEY = 'novel-pocket-reference-v1';
const PREF_KEY = 'novel-pocket-settings-v1';
const defaults = { count: 5, maxChars: 6200, injectionMode: 'background', chatBindings: {} };
let preferences = readPreferences();
let active = null; // Single active book cached in memory, never sent to a remote API.
let activeIndex = null;
let initialized = false;
let lastMatches = [];
let lastTitle = '';
const el = id => document.getElementById(id);

function readPreferences() {
    try {
        const parsed = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        return { ...defaults, ...parsed, chatBindings: parsed.chatBindings || {} };
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
    if (create && !preferences.chatBindings[key]) preferences.chatBindings[key] = { bookId: '', enabled: false, chapter: null };
    return preferences.chatBindings[key] || null;
}
function report(message, isError = false) {
    const status = el('np-status');
    if (status) { status.textContent = message; status.dataset.error = isError ? 'true' : 'false'; }
    if (isError) console.warn('[Novel Pocket]', message);
}
async function clearInjection() {
    try { await context()?.setExtensionPrompt?.(PROMPT_KEY, '', 2, 0, false, 0); }
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
        const query = chatQuery(context()?.chat);
        const matches = searchChunks(activeIndex, book.chunks, query, {
            limit: preferences.count,
            chapter: Number.isInteger(binding.chapter) ? binding.chapter : null,
        });
        const prompt = makePrompt(book, matches, preferences.maxChars);
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
        summary.textContent = `${active?.chapters[item.chapter]?.title || '正文'} · ${item.text.length} 字`;
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
    for (const id of ['np-books', 'np-enabled', 'np-chapter']) el(id).disabled = !key;
    const book = binding?.bookId ? await openBook(binding.bookId) : null;
    if (key !== chatKey()) return;
    fillOptions(el('np-chapter'), (book?.chapters || []).map(item => [item.id, item.title]), '自动检索全部章节');
    el('np-chapter').value = binding?.chapter != null ? String(binding.chapter) : '';
    if (!book && binding?.bookId) report('当前聊天绑定的小说已不存在，请重新选择。', true);
    else if (book) report(`已准备：${book.title}，${book.chunks.length} 个片段；${binding?.enabled ? '自动检索已开启' : '自动检索未开启'}`);
    else report('上传 TXT 小说，选中后打开自动检索。');
    renderLastMatches();
}
async function importFile(file) {
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
        await new Promise(resolve => setTimeout(resolve, 0));
        const title = file.name.replace(/\.(txt|md|markdown)$/i, '');
        const result = chunkBook(text);
        const id = `np-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const book = { id, title, ...result, createdAt: Date.now() };
        await saveBook(book);
        active = null; activeIndex = null;
        const bind = bindingForCurrent(true);
        if (bind) { bind.bookId = id; bind.chapter = null; bind.enabled = true; persist(); }
        await syncPanel();
        report(`导入成功：${title}，${result.chapters.length} 章、${result.chunks.length} 段。${bind ? '已在当前聊天启用。' : '请先打开聊天再绑定。'}`);
    } catch (error) { report('导入失败：' + (error?.message || error), true); }
    finally { if (el('np-upload')) el('np-upload').value = ''; }
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
        if (entry.bookId === id) { entry.bookId = ''; entry.enabled = false; entry.chapter = null; }
    }
    persist(); active = null; activeIndex = null; lastMatches = [];
    await clearInjection(); await syncPanel();
    report('小说已删除。');
}
function injectUI() {
    const container = document.createElement('div');
    container.id = 'np-root';
    container.innerHTML = `
      <button id="np-open" type="button" title="小说随身库">小说</button>
      <div id="np-overlay" hidden></div>
      <dialog id="np-panel" aria-label="小说随身库">
        <header class="np-header"><div><strong>小说随身库</strong><div class="np-small">零额外模型调用 · 本地原文检索</div></div><button type="button" id="np-close" aria-label="关闭小说随身库">关闭</button></header>
        <div class="np-body">
          <p class="np-hint" id="np-chat-label"></p>
          <button type="button" class="np-filebtn" id="np-upload-btn">＋ 上传小说（TXT / Markdown）</button>
          <input type="file" id="np-upload" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden />
          <label for="np-books">本聊天使用的小说</label>
          <select id="np-books"></select>
          <label class="np-toggle"><input type="checkbox" id="np-enabled" /> <span>聊天时自动检索并注入原文</span></label>
          <label for="np-injection-mode">原文插入位置</label>
          <select id="np-injection-mode"><option value="background">背景资料（主提示词之前，默认）</option><option value="user">最近玩家发言之前（单独的用户参考消息）</option></select>
          <p class="np-hint">原文单独提供，不改你的发言或预设；最终顺序受酒馆提示词管理器设置影响。</p>
          <label for="np-chapter">当前剧情所在章节（可不选）</label>
          <select id="np-chapter"></select>
          <div class="np-grid">
            <div><label for="np-count">每轮片段数</label><select id="np-count"><option value="3">3段</option><option value="4">4段</option><option value="5">5段</option><option value="6">6段</option><option value="8">8段</option></select></div>
            <div><label for="np-budget">每轮原文字数上限</label><select id="np-budget"><option value="3000">3000字</option><option value="4500">4500字</option><option value="6200">6200字</option><option value="8000">8000字</option></select></div>
          </div>
          <hr />
          <label for="np-query">检索测试（可留空，用当前聊天内容）</label>
          <div class="np-search"><input type="text" id="np-query" placeholder="输入人名、事件、地点……" /><button type="button" id="np-search-btn">查找</button></div>
          <div id="np-last-matches" class="np-results"></div>
          <button type="button" class="np-danger" id="np-delete">删除选中小说</button>
          <p class="np-hint">资料保存在当前浏览器的 IndexedDB；换设备、清除网站数据需要重新导入。不会调用额外 AI，也不自动推进章节。</p>
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
    el('np-upload-btn').addEventListener('click', () => el('np-upload').click());
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
        b.bookId = event.target.value; b.chapter = null; b.enabled = Boolean(b.bookId);
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
        persist(); report(b.chapter === null ? '改为自动检索所有章节' : '已选择当前章节，下次回复生效。');
    });
    el('np-count').addEventListener('change', e => { preferences.count = Number(e.target.value); persist(); });
    el('np-budget').addEventListener('change', e => { preferences.maxChars = Number(e.target.value); persist(); });
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
    const ctx = context();
    if (ctx?.eventSource && ctx?.event_types?.CHAT_CHANGED) {
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
            lastMatches = []; lastTitle = ''; active = null; activeIndex = null;
            clearInjection();
            if (el('np-panel')?.open) syncPanel().catch(err => report(err.message, true));
        });
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
