// Small presentation fragments share the trusted card's host DOM so its shared
// styles and hydration observers can reach them. Executable documents stay framed.
function parseTavernInlineFragment(content, doc) {
    if (!doc?.createElement || /<!doctype|<\/?(?:html|head|body)\b/i.test(content)) return null;
    const template = doc.createElement('template');
    template.innerHTML = String(content);
    const allowed = new Set(['DIV','SPAN','P','IMG','BR','HR','B','STRONG','I','EM','U','S','SMALL','SUB','SUP','BLOCKQUOTE','PRE','CODE','UL','OL','LI','DL','DT','DD','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','CAPTION','COLGROUP','COL','H1','H2','H3','H4','H5','H6','A','DETAILS','SUMMARY','SECTION','ARTICLE','FIGURE','FIGCAPTION']);
    for (const node of template.content.querySelectorAll('*')) {
        if (!allowed.has(node.tagName)) return null;
        for (const attr of node.attributes) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on') || name === 'srcdoc' || name === 'is') return null;
            if (['href','src','xlink:href'].includes(name)) {
                const value = attr.value.replace(/[\u0000-\u0020]/g, '');
                if (/^(?:javascript|vbscript):/i.test(value) || (/^data:/i.test(value) && !(node.tagName === 'IMG' && name === 'src' && /^data:image\//i.test(value)))) return null;
            }
        }
    }
    return template.content;
}

function TavernInlineFragment(props) {
    const ref = React.useRef(null);
    React.useLayoutEffect(function () {
        const root = ref.current;
        if (!root) return;
        const fragment = parseTavernInlineFragment(props.content, root.ownerDocument);
        if (fragment) root.replaceChildren(fragment);
        return function () { root.replaceChildren(); };
    }, [props.content]);
    return React.createElement('div', {ref, className:'mes_text dsh-tavern-inline-fragment'});
}
