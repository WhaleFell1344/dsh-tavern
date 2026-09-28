// Legacy card pages submit through these SillyTavern DOM IDs. Keep the
// adapter inside its owning frame so it cannot target another conversation.
function installLegacyTavernComposer() {
  if (document.getElementById('send_textarea') || document.getElementById('send_but')) return;
  const controls = document.createElement('div');
  controls.hidden = true;
  const area = document.createElement('textarea');
  area.id = 'send_textarea';
  const button = document.createElement('button');
  button.id = 'send_but';
  button.type = 'button';
  controls.append(area, button);
  document.body.append(controls);
  area.addEventListener('input', function () {
    if (typeof window.submitTavernInput === 'function') return;
    Promise.resolve().then(function () {
      if (typeof window.triggerSlash !== 'function') throw new Error('当前对话输入框尚未就绪');
      return window.triggerSlash('/setinput ' + String(area.value || ''));
    }).catch(function (error) {
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = '开场文字填入失败：' + String(error && error.message || error);
      document.body.append(notice);
    });
  });
  let pending = false;
  button.addEventListener('click', function () {
    const text = String(area.value || '').trim();
    if (pending || !text) return;
    if (typeof window.submitTavernInput !== 'function' && typeof window.triggerSlash !== 'function') throw new Error('当前对话发送入口尚未就绪');
    pending = true;
    button.disabled = true;
    Promise.resolve().then(function () {
      return typeof window.submitTavernInput === 'function' ? window.submitTavernInput(text) : window.triggerSlash('/send ' + text + '|/trigger');
    }).then(function () {
      if (area.value.trim() === text) area.value = '';
    }, function (error) {
      // A DOM click cannot return an asynchronous rejection to legacy callers.
      // Surface it in the card itself, retaining the payload for a retry.
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = '开局消息发送失败：' + String(error && error.message || error);
      document.body.append(notice);
      console.error('[DSH Tavern] 开局消息发送失败', error);
    }).finally(function () { pending = false; button.disabled = false; });
  });
}

// Preparation pages address the parent DOM. Own these controls only while that
// preview is mounted; they must never forward a submission to the current chat.
function installOpeningHostComposer(hostDocument, submit, report) {
  if (hostDocument.getElementById('send_textarea') || hostDocument.getElementById('send_but')) return function () {};
  const controls = hostDocument.createElement('div');
  controls.hidden = true;
  const area = hostDocument.createElement('textarea');
  area.id = 'send_textarea';
  const button = hostDocument.createElement('button');
  button.id = 'send_but'; button.type = 'button';
  controls.append(area, button);
  hostDocument.body.append(controls);
  let active = true, pending = false, completed = false;
  button.addEventListener('click', function () {
    const text = String(area.value || '').trim();
    if (!active || pending || completed || !text) return;
    pending = true; button.disabled = true;
    Promise.resolve().then(function () { return submit(text); }).then(function () {
      completed = true; area.value = '';
    }, report).finally(function () { pending = false; button.disabled = completed; });
  });
  return function () { active = false; controls.remove(); };
}

// Parent DOM IDs are shared, but the focused iframe identifies the sender even
// after document.write replaces its document. Never fall back to the active chat.
const tavernHostComposers = new WeakMap();
function installFrameHostComposer(doc, ownsFrame, submit, report) {
  let state = tavernHostComposers.get(doc);
  if (!state) {
    if (doc.getElementById('send_textarea') || doc.getElementById('send_but')) return function () {};
    const controls = doc.createElement('div');
    controls.hidden = true;
    const area = doc.createElement('textarea'), button = doc.createElement('button');
    area.id = 'send_textarea'; button.id = 'send_but'; button.type = 'button';
    controls.append(area, button); doc.body.append(controls);
    state = { controls, owners: new Set() };
    tavernHostComposers.set(doc, state);
    button.addEventListener('click', function () {
      const owners = Array.from(state.owners).filter(function (owner) { return owner.ownsFrame(doc.activeElement); });
      if (owners.length !== 1) throw new Error('无法确定开局消息所属的卡片，请重新点击卡片内的开始按钮');
      const owner = owners[0], text = String(area.value || '').trim();
      if (owner.pending || !text) return;
      owner.pending = true;
      Promise.resolve().then(function () {
        if (!state.owners.has(owner)) throw new Error('卡片已关闭，请重新打开');
        return owner.submit(text);
      }).then(function () { if (area.value === text) area.value = ''; }, owner.report)
        .finally(function () { owner.pending = false; });
    });
  }
  const owner = { ownsFrame, submit, report, pending: false };
  state.owners.add(owner);
  return function () {
    state.owners.delete(owner);
    if (!state.owners.size) { state.controls.remove(); tavernHostComposers.delete(doc); }
  };
}

// Give each module a view of the host DOM whose standard ST composer controls
// belong to that module's sandbox. Never install a shared, focus-routed sender.
function createTavernComposerWindow(frame, host = frame.parent) {
  const ids = new Set(['send_textarea', 'send_but']);
  const documents = new WeakMap(), windows = new WeakMap();
  const jq = frame.jQuery;
  const anchors = new Map();
  let observedViewport = null;
  const layoutObserver = host?.ResizeObserver ? new host.ResizeObserver(function () {
    const rect = observedViewport?.getBoundingClientRect();
    if (!rect) return;
    // Legacy scripts observe their layout anchor's style/class changes.
    for (const node of anchors.values()) {
      const value = `--dsh-layout:${rect.left},${rect.top},${rect.width},${rect.height}`;
      if (node.getAttribute('style') !== value) node.setAttribute('style', value);
    }
  }) : null;
  if (layoutObserver) frame.addEventListener?.('pagehide', () => layoutObserver?.disconnect(), {once:true});
  function layoutAnchor(id) {
    if (!['sheld', 'top-settings-holder'].includes(id)) return null;
    const doc = host.document;
    function viewport() {
      let node = doc.querySelector('.dsh-tavern-assistant');
      for (; node && node !== doc.body; node = node.parentElement) {
        const style = host.getComputedStyle(node);
        if (/auto|scroll/.test(style.overflowY) && node.getBoundingClientRect().height > 0) {
          if (layoutObserver && observedViewport !== node) {
            layoutObserver.disconnect(); observedViewport = node; layoutObserver.observe(node);
          }
          return node;
        }
      }
      return null;
    }
    if (!viewport()) return null;
    if (!anchors.has(id)) {
      const node = doc.createElement('div');
      node.id = id;
      node.getBoundingClientRect = function () {
        const rect = viewport()?.getBoundingClientRect();
        if (!rect) return new host.DOMRect();
        return id === 'sheld' ? rect : new host.DOMRect(rect.left, 0, rect.width, rect.top);
      };
      anchors.set(id, node);
    }
    return anchors.get(id);
  }
  function lookup(doc, id) {
    return ids.has(id) ? frame.document.getElementById(id) : doc.getElementById(id) || layoutAnchor(id);
  }

  function documentView(doc) {
    if (documents.has(doc)) return documents.get(doc);
    const proxy = new Proxy({}, { get(_, key) {
      if (key === 'getElementById') return id => lookup(doc, id);
      if (key === 'querySelector' || key === 'querySelectorAll') return selector =>
        (/^#(?:sheld|top-settings-holder)$/.test(selector) && !doc.querySelector(selector))
          ? (key === 'querySelector' ? layoutAnchor(selector.slice(1)) : [layoutAnchor(selector.slice(1))].filter(Boolean))
          : /^#(?:send_textarea|send_but)$/.test(selector) ? frame.document[key](selector) : doc[key](selector);
      if (key === 'defaultView') return windowView(doc.defaultView);
      const value = doc[key];
      return typeof value === 'function' ? value.bind(doc) : value;
    }, set(_, key, value) { doc[key] = value; return true; } });
    documents.set(doc, proxy);
    return proxy;
  }
  function jquery(selector, context) {
    if (typeof selector === 'string' && /^#(?:send_textarea|send_but)$/.test(selector)) return jq(frame.document.querySelector(selector));
    if (typeof selector === 'string' && /^#(?:sheld|top-settings-holder)$/.test(selector) && !host.document.querySelector(selector)) return jq(layoutAnchor(selector.slice(1)));
    if (context === documentView(host.document)) context = host.document;
    if (selector === documentView(host.document)) {
      const result = jq(host.document);
      const find = result.find;
      result.find = function (selector) {
        return /^#(?:send_textarea|send_but)$/.test(selector) ? jq(frame.document.querySelector(selector)) : find.call(this, selector);
      };
      return result;
    }
    return jq(selector, context);
  }
  function windowView(target) {
    if (windows.has(target)) return windows.get(target);
    const proxy = new Proxy({}, { get(_, key) {
      if (key === 'window' || key === 'self' || key === 'globalThis') return proxy;
      if (key === 'parent' || key === 'top') return windowView(host);
      if (key === 'document') return target === frame ? frame.document : documentView(target.document);
      if ((key === '$' || key === 'jQuery') && jq) return new Proxy(jq, {apply(_, receiver, args) { return jquery(...args); }});
      const value = target[key];
      return typeof value === 'function' && !value.prototype ? value.bind(target) : value;
    }, set(_, key, value) { target[key] = value; return true; } });
    windows.set(target, proxy);
    return proxy;
  }
  return windowView(frame);
}
