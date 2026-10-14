import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChapters, chunkBook, buildIndex, searchChunks, makePrompt, injectionPlacement } from '../core.js';

const novel = [
    '第一章 雾中的城堡',
    '苏青和沈月来到雾岭城堡，城堡外的钟楼每天午夜都会敲十三下。'.repeat(18),
    '第二章 被隐藏的信',
    '沈月在图书馆找到一封祖母留下的密信，信封上写着不要相信管家。'.repeat(18),
    '第三章 夜色里的约定',
    '苏青在湖边见到黑衣骑士，他们约定明天晚上打开古堡的北门。'.repeat(18),
].join('\n');

test('章节识别和文本完整拆分', () => {
    const chapters = parseChapters(novel);
    assert.equal(chapters.length, 3);
    assert.equal(chapters[1].title, '第二章 被隐藏的信');
    const book = chunkBook(novel, { size: 400, overlap: 50 });
    assert.equal(book.chapters.length, 3);
    assert.ok(book.chunks.length >= 3);
    assert.ok(book.chunks.every(c => c.text.length > 0));
    assert.ok(book.chunks.some(c => c.chapter === 2 && c.text.includes('黑衣骑士')));
});

test('中文关键词匹配正确章节，不调用模型', () => {
    const book = chunkBook(novel, { size: 460, overlap: 60 });
    const index = buildIndex(book.chunks);
    const results = searchChunks(index, book.chunks, '沈月在图书馆找到的祖母密信写了什么？', { limit: 3 });
    assert.ok(results.length);
    assert.ok(results.some(r => r.chapter === 1));
    assert.ok(results.some(r => r.text.includes("不要相信管家")));
});

test('指定章节对简单「继续」查询提供章节锚点', () => {
    const book = chunkBook(novel);
    const matches = searchChunks(buildIndex(book.chunks), book.chunks, '继续', { chapter: 2, limit: 4 });
    assert.ok(matches.some(m => m.chapter === 2));
});

test('提示词字数预算生效且不写入整本小说', () => {
    const book = { title: '雾岭之夜', ...chunkBook(novel, { size: 450, overlap: 40 }) };
    const hits = searchChunks(buildIndex(book.chunks), book.chunks, '城堡图书馆密信管家', { limit: 5 });
    const prompt = makePrompt(book, hits, 1200);
    assert.ok(prompt.length < 1300);
    assert.match(prompt, /原著参考/);
    assert.match(prompt, /原文片段/);
    assert.ok(prompt.length < novel.length);
});

test('无章节的小说作为全文检索', () => {
    const book = chunkBook('文字内容很丰富。'.repeat(140));
    assert.equal(book.chapters.length, 1);
    assert.ok(book.chunks.length > 1);
});

test('背景资料默认在主提示词之前，旧设置也使用新默认', () => {
    assert.deepEqual(injectionPlacement(undefined), { position: 2, depth: 0, role: 0 });
    assert.deepEqual(injectionPlacement('background'), { position: 2, depth: 0, role: 0 });
});
test('用户参考定位在最近玩家发言之前，不更改消息', () => {
    const chat = [{ is_user: true, mes: '去城堡' }, { is_user: false, mes: '到达城堡' }];
    const original = JSON.stringify(chat);
    assert.deepEqual(injectionPlacement('user', chat), { position: 1, depth: 2, role: 1 });
    assert.equal(JSON.stringify(chat), original);
    assert.equal(injectionPlacement('user', [{ is_user: true }]).depth, 1);
});
test('原文参考不再附加写作和剧情控制要求', () => {
    const book = { title: '测试', chapters: [{title:'第一章'}], chunks: [{chapter:0,part:0,text:'城堡坐落在山顶。'}] };
    const p = makePrompt(book, [{chapter:0,text:'城堡坐落在山顶。'}]);
    assert.match(p, /非对话指令/);
    assert.doesNotMatch(p, /以当前聊天为准|不要向玩家提及|参考人物、背景与事件/);
});
