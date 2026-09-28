// Text-model requests from trusted card scripts use the session's background model.
// No provider credentials are exposed to the script or sent to a card URL.
function installTavernBackgroundModel({ window, request }) {
    const base = 'https://dsh-background.invalid/v1';
    const model = '本局后台模型';
    const nativeFetch = window.fetch && window.fetch.bind(window);
    if (nativeFetch) window.fetch = async function (input, init) {
        const url = new URL(typeof input === 'string' ? input : input?.url || String(input), window.location.href);
        const completion = /\/chat\/completions\/?$/.test(url.pathname);
        const models = url.origin === 'https://dsh-background.invalid' && /\/models\/?$/.test(url.pathname);
        if (!completion && !models) return nativeFetch(input, init);
        const signal = init?.signal || input?.signal;
        if (signal?.aborted) throw new window.DOMException('请求已取消', 'AbortError');
        if (models) return new window.Response(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }), { headers: { 'Content-Type': 'application/json' } });
        const raw = init?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : '');
        const config = JSON.parse(raw);
        let abort;
        const aborted = new Promise((_, reject) => {
            abort = () => reject(new window.DOMException('请求已取消', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
        });
        try {
            const result = await Promise.race([request('generateTavernHelperRaw', { completion: config }), aborted]);
            const message = { role: 'assistant', content: result.text };
            const payload = { id: 'dsh-background', object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: 'stop' }] };
            if (config.stream) {
                const chunk = { ...payload, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] };
                const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
                return new window.Response('data: ' + JSON.stringify(chunk) + '\n\ndata: ' + JSON.stringify(end) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
            }
            return new window.Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
        } finally { signal?.removeEventListener('abort', abort); }
    };

    // Legacy phone channels share this public registry. Project the host connection
    // at runtime; preserve saved credentials and functional preferences on disk.
    let channels;
    const attached = new WeakSet();
    function attach(channel) {
        if (!channel || typeof channel !== 'object' || attached.has(channel)) return;
        attached.add(channel);
        let settings;
        const managed = { apiUrl: base, apiKey: 'host-managed', model };
        function wrap(value) {
            const target = value && typeof value === 'object' ? value : {};
            return new Proxy(target, {
                get(object, key) {
                    if (key === 'toJSON') return () => ({ ...object });
                    return Object.hasOwn(managed, key) ? managed[key] : object[key];
                },
                set(object, key, value) {
                    if (!Object.hasOwn(managed, key)) object[key] = value;
                    return true;
                }
            });
        }
        settings = wrap(channel.settings);
        Object.defineProperty(channel, 'settings', { configurable: true, enumerable: true, get: () => settings, set: value => { settings = wrap(value); } });
    }
    Object.defineProperty(window, 'phoneAPI', { configurable: true, get: () => channels, set: value => {
        channels = value;
        for (const channel of Object.values(value || {})) attach(channel);
    } });

    // These stable legacy form IDs exist in both the phone and the parent panel.
    // Leave feature switches and generation parameters available, hide connection fields.
    function adapt(document) {
        // Headless opening runtimes can expose only a partial document facade.
        if (!document?.querySelector || !window.MutationObserver) return;
        const fields = [['api-ch-url', base], ['api-ch-key', 'host-managed'], ['api-ch-model', model], ['yq-api-url', base], ['yq-api-key', 'host-managed'], ['yq-api-model', model]];
        function refresh(root = document) {
            for (const [id, value] of fields) {
                const input = root.id === id ? root : root.querySelector('#' + id);
                if (!input || input.dataset.dshModelManaged) continue;
                input.dataset.dshModelManaged = 'true';
                if (input.tagName === 'SELECT') { const option = document.createElement('option'); option.value = value; option.textContent = value; input.replaceChildren(option); }
                input.value = value;
                const row = id === 'api-ch-key' ? input.parentElement?.parentElement : input.parentElement;
                if (row) row.hidden = true;

            }
            const selector = '.api-ch-fetch-btn,.api-ch-manual-model-btn,.api-ch-copy-chat-btn,.api-ch-sync-all-btn,#yq-api-copy-chat';
            if (root.matches?.(selector)) root.hidden = true;
            for (const button of root.querySelectorAll(selector)) button.hidden = true;
        }
        refresh();
        const observer = new window.MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) refresh(node);
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    }
    adapt(window.document);
    try { if (window.parent !== window && window.parent.document) adapt(window.parent.document); } catch (_) {}
    // Expose the actual host connection through MVU's public settings contract.
    // Serialization keeps the user's stored connection values, not adapter tokens.
    const managedMvu = { 模型来源:'自定义', api地址:base, 密钥:'host-managed', 模型名称:model };
    const views = new WeakMap();
    function projectMvuSettings(value) {
        if (!value || typeof value !== 'object') return value;
        if (views.has(value)) return views.get(value);
        const managed = managedMvu;
        const configViews = new WeakMap();
        const empty = {};
        const proxy = new Proxy(value, { get(target, key) {
            if (key === 'toJSON') return () => ({ ...target });
            if (key !== '额外模型解析配置') return target[key];
            const config = target[key] && typeof target[key] === 'object' ? target[key] : empty;
            if (!configViews.has(config)) configViews.set(config, new Proxy(config, {
                get(object, field) {
                    if (field === 'toJSON') return () => ({ ...object });
                    return Object.hasOwn(managed, field) ? managed[field] : object[field];
                }
            }));
            return configViews.get(config);
        } });
        views.set(value, proxy);
        return proxy;
    }
    function normalizeMvuSettings(next, previous) {
        if (!next || typeof next !== 'object') return next;
        const config = next.额外模型解析配置;
        if (!config || typeof config !== 'object') return next;
        const restored = { ...config };
        for (const [key, value] of Object.entries(managedMvu)) if (restored[key] === value) {
            if (Object.hasOwn(previous?.额外模型解析配置 || {}, key)) restored[key] = previous.额外模型解析配置[key];
            else delete restored[key];
        }
        return { ...next, 额外模型解析配置:restored };
    }
    return { projectMvuSettings, normalizeMvuSettings };

}
