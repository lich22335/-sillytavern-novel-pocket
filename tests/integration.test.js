import test from 'node:test';
import assert from 'node:assert/strict';

test('管理窗口、原生工具、进度保存与跨聊天隔离串联验证', async () => {
    const nodes = new Map();
    class Element {
        constructor() { this.handlers={}; this.children=[]; this.dataset={}; this.hidden=false; this.open=false; this.value=''; }
        set innerHTML(text) { for (const [,id] of text.matchAll(/id="([^"]+)"/g)) nodes.set(id,new Element()); }
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
        async fire(name) { for(const fn of this.handlers[name] || []) await fn({target:this}); }
        append(...items) { this.children.push(...items); }
        add(item) { this.children.push(item); }
        replaceChildren() { this.children=[]; }
        showModal() { this.open=true; }
        close() { this.open=false; }
        click() { return this.fire('click'); }
    }
    globalThis.document={readyState:'complete',body:new Element(),createElement:()=>new Element(),getElementById:id=>nodes.get(id)};
    const values=new Map();
    globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
    const book={id:'book-one',title:'测试书',chapters:[{title:'第一章'}],chunks:[
        {chapter:0,part:0,text:'苏青走进古堡。'}, {chapter:0,part:1,text:'管家递上一封密信。'.repeat(150)}, {chapter:0,part:2,text:'苏青在北门发现骑士。'},
    ],charCount:30};
    const books=new Map([[book.id,book]]);
    function request(fn) { const req={}; queueMicrotask(()=>{req.result=fn(); req.onsuccess?.();}); return req; }
    const database={transaction:()=>({objectStore:()=>({get:id=>request(()=>books.get(id)),getAll:()=>request(()=>[...books.values()]),put:b=>request(()=>books.set(b.id,b)),delete:id=>request(()=>books.delete(id))})})};
    globalThis.indexedDB={open:()=>request(()=>database)};
    const tools=new Map(), prompts=new Map();
    const ctx={chatId:'chat-A',characterId:0,characters:[{avatar:'card.png'}],chat:[{is_user:true,mes:'进入古堡'}],
        registerFunctionTool:def=>tools.set(def.name,def),isToolCallingSupported:()=>true,
        setExtensionPrompt:(key,text,position,depth,scan,role)=>prompts.set(key,{text,position,depth,role}),
    };
    globalThis.SillyTavern={getContext:()=>ctx};
    values.set('novel-pocket-settings-v1',JSON.stringify({chatBindings:{'character:card.png:chat-A':{bookId:book.id,enabled:true,chapter:0}}}));
    await import('../index.js');
    assert.equal(tools.size,2);
    await globalThis.NovelPocket_openManager();
    assert.equal(nodes.get('np-panel').open,true);
    assert.equal(nodes.get('np-books').value,book.id);
    assert.ok(nodes.has('np-upload-btn') && nodes.has('np-close-bottom'));
    await globalThis.NovelPocket_beforeGeneration([],10000,null,'normal');
    let prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    const readingId=prefs.chatBindings['character:card.png:chat-A'].readerId;
    const injection=prompts.get('novel-pocket-reference-v1');
    assert.equal(injection.position,1);
    assert.equal(injection.depth,ctx.chat.length);
    assert.match(injection.text,/第 1 \/ 3 段/);
    assert.match(injection.text,/第 2 \/ 3 段/);
    const read=tools.get('novel_pocket_read'), advance=tools.get('novel_pocket_advance');
    const result=await read.action({reading_id:readingId,block:3,count:1});
    assert.equal(result.blocks[0].block,3); assert.equal(result.current_block,1); assert.equal(result.progress_changed,false);
    assert.equal((await advance.action({reading_id:readingId,current_block:1,to_block:2})).current_block,2);
    assert.match((await advance.action({reading_id:readingId,current_block:1,to_block:2})).error,/进度已变化/);
    await globalThis.NovelPocket_beforeGeneration([],10000,null,'normal');
    assert.match(prompts.get('novel-pocket-reference-v1').text,/当前剧情进度：第 2/);
    ctx.chatId='chat-B';
    assert.equal(read.shouldRegister(),false);
    await globalThis.NovelPocket_openManager();
    nodes.get('np-books').value=book.id; await nodes.get('np-books').fire('change');
    assert.equal(read.shouldRegister(),true);
    assert.match((await advance.action({reading_id:readingId,current_block:1,to_block:2})).error,/会话已改变/);
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    assert.equal(prefs.chatBindings['character:card.png:chat-A'].cursor,1);
    assert.equal(prefs.chatBindings['character:card.png:chat-B'].cursor,0);
    await nodes.get('np-next').click();
    assert.equal(nodes.get('np-block-preview').textContent,book.chunks[1].text);
    assert.ok(nodes.get('np-block-preview').textContent.length > 1200);
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    assert.equal(prefs.chatBindings['character:card.png:chat-B'].cursor,0);
    await nodes.get('np-anchor-apply').click();
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    assert.equal(prefs.chatBindings['character:card.png:chat-B'].cursor,1);
    assert.equal(prefs.chatBindings['character:card.png:chat-A'].cursor,1);
    nodes.get('np-block').value='3'; await nodes.get('np-jump').click();
    assert.equal(nodes.get('np-block-preview').textContent,book.chunks[2].text);
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    assert.equal(prefs.chatBindings['character:card.png:chat-B'].cursor,1);
    await nodes.get('np-current').click();
    assert.equal(nodes.get('np-block-preview').textContent,book.chunks[1].text);
    // Upgrade a legacy book through the same file picker, without duplicating library entries.
    await nodes.get('np-rechunk').click();
    const raw = '第一章\n'+book.chunks[0].text+book.chunks[1].text.repeat(6)+book.chunks[2].text+'\n第二章\n新的完整剧情。';
    const bytes = new TextEncoder().encode(raw);
    nodes.get('np-upload').files=[{name:'测试书.txt',size:bytes.length,arrayBuffer:async()=>bytes.buffer}];
    await nodes.get('np-upload').fire('change');
    assert.equal(books.size,1);
    assert.equal(books.get(book.id).chunkVersion,2);
    assert.equal(books.get(book.id).sourceText,raw);
    assert.equal(books.get(book.id).chunks.length,2);
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    assert.equal(prefs.chatBindings['character:card.png:chat-A'].bookId,book.id);
    assert.equal(prefs.chatBindings['character:card.png:chat-A'].cursor,0);
    assert.equal(prefs.chatBindings['character:card.png:chat-B'].cursor,0);
    assert.match((await read.action({reading_id:readingId,block:1})).error,/会话已改变/);
    await globalThis.NovelPocket_beforeGeneration([],10000,null,'normal');
    assert.ok(prompts.get('novel-pocket-reference-v1').text.includes(book.chunks[1].text));
    const fullChapter=books.get(book.id).chunks[0].text;
    assert.equal(nodes.get('np-block-preview').textContent,fullChapter);
    assert.equal(prefs.maxChars,4500);
    assert.ok(!prompts.get('novel-pocket-reference-v1').text.includes(fullChapter));
    await nodes.get('np-batch-next').click();
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    const moved=prefs.chatBindings['character:card.png:chat-B'];
    assert.equal(moved.cursor,0); assert.ok(moved.offset>0);
    assert.equal(nodes.get('np-block-preview').textContent,fullChapter);
    await nodes.get('np-batch-prev').click();
    await globalThis.NovelPocket_beforeGeneration([],10000,null,'normal');
    prefs=JSON.parse(values.get('novel-pocket-settings-v1'));
    const session=prefs.chatBindings['character:card.png:chat-B'].readerId;
    const more=await read.action({reading_id:session,count:3});
    assert.ok(more.blocks.reduce((sum,b)=>sum+b.text.length,0)<=4500);
    assert.equal(more.progress_changed,false);
    const again=await read.action({reading_id:session,count:3});
    assert.match(again.error,/额度已用完|小说末尾/);
    await nodes.get('np-close-bottom').click(); assert.equal(nodes.get('np-panel').open,false);
});
