/**
 * Novel Pocket bootstrap: always exposes a launcher even if main module import fails.
 * This is intentionally dependency-free so users on mobile can report startup errors.
 */
(() => {
    const BOOT_ID = 'np-boot-open';
    const MENU_ID = 'np-boot-settings';
    let loadError = null;
    let loadPromise = null;

    function loadApp() {
        if (!loadPromise) {
            loadPromise = import('./index.js').catch(error => {
                loadError = error;
                console.error('[Novel Pocket] Main module failed to load:', error);
                throw error;
            });
        }
        return loadPromise;
    }
    async function launch() {
        try {
            await loadApp();
            const original = document.getElementById('np-open');
            if (!original) throw new Error('主模块已加载，但没有创建窗口入口（np-open）。');
            original.click();
        } catch (error) {
            const message = (loadError || error)?.stack || String(loadError || error);
            alert('小说随身库加载失败，请截图这段错误信息：\n\n' + message.slice(0, 1200));
        }
    }
    function addButton() {
        if (!document.body || document.getElementById(BOOT_ID)) return;
        const button = document.createElement('button');
        button.id = BOOT_ID;
        button.type = 'button';
        button.textContent = '小说';
        button.title = '打开小说随身库';
        button.setAttribute('aria-label', '打开小说随身库');
        // Inline styling is intentional: if style.css fails, this button is still visible.
        Object.assign(button.style, {
            display: 'block', position: 'fixed', right: '12px',
            bottom: 'calc(125px + env(safe-area-inset-bottom, 0px))',
            zIndex: '2147483000', background: '#355e83',
            color: 'white', border: '1px solid #c3d0dd',
            borderRadius: '24px', padding: '10px 14px',
            fontSize: '15px', lineHeight: '20px',
            boxShadow: '0 4px 15px #0009',
            visibility: 'visible', opacity: '1', pointerEvents: 'auto',
        });
        button.addEventListener('click', launch);
        document.body.appendChild(button);
    }
    function addSettingsShortcut() {
        const settings = document.getElementById('extensions_settings');
        if (!settings || document.getElementById(MENU_ID)) return;
        const box = document.createElement('div');
        box.id = MENU_ID;
        box.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #8888;border-radius:8px;';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '小说随身库 · 打开管理窗口';
        button.style.cssText = 'width:100%;min-height:38px;cursor:pointer;padding:8px;';
        button.addEventListener('click', launch);
        box.appendChild(button);
        settings.prepend(box);
    }
    function start() {
        addButton();
        addSettingsShortcut();
        // Most versions build extensions_settings before extension modules load.
        // Retry briefly for versions that create this settings node later.
        let tries = 0;
        const poll = setInterval(() => {
            addSettingsShortcut();
            if (++tries >= 25 || document.getElementById(MENU_ID)) clearInterval(poll);
        }, 400);
        // Start the main module eagerly so auto retrieval remains active on saved chats.
        void loadApp().catch(() => {});
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else start();
})();
