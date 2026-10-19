'use strict';
/* XC Wiki — dependency-free WYSIWYG rich-text editor.
   Tabs: Write (contenteditable) | HTML (raw source with highlighting) | Preview.
   Usage: const ed = createWysiwyg(mountEl, { initialHtml, onPickImage });
   ed.getHtml() / ed.setHtml(html) / ed.focus() */

function createWysiwyg(mount, opts = {}) {
  const initial = opts.initialHtml || '';
  const onPickImage = opts.onPickImage || null;

  mount.innerHTML = `
    <div class="wysi">
      <div class="wysi-tabs">
        <button class="wt active" data-tab="write">✏️ Write</button>
        <button class="wt" data-tab="html">&lt;&gt; HTML</button>
        <button class="wt" data-tab="preview">👁 Preview</button>
      </div>
      <div class="wysi-toolbar" data-pane="write">
        <div class="wt-group">
          <button data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
        </div>
        <div class="wt-group">
          <button data-block="h1" title="Heading 1" style="font-weight:800">H1</button>
          <button data-block="h2" title="Heading 2" style="font-weight:800">H2</button>
          <button data-block="h3" title="Heading 3" style="font-weight:800">H3</button>
          <button data-block="p" title="Paragraph">¶</button>
        </div>
        <div class="wt-group">
          <button data-cmd="insertUnorderedList" title="Bullet list">•☰</button>
          <button data-cmd="insertOrderedList" title="Numbered list">1.☰</button>
          <button data-block="blockquote" title="Quote">❝</button>
          <button data-block="pre" title="Code block">{ }</button>
        </div>
        <div class="wt-group">
          <button data-act="link" title="Insert link">🔗</button>
          <button data-act="image" title="Insert image">🖼️</button>
          <button data-act="table" title="Insert table">▦</button>
          <button data-cmd="insertHorizontalRule" title="Horizontal rule">―</button>
        </div>
        <div class="wt-group">
          <button data-cmd="justifyLeft" title="Align left">⇤</button>
          <button data-cmd="justifyCenter" title="Align center">⇔</button>
          <button data-cmd="justifyRight" title="Align right">⇥</button>
        </div>
        <div class="wt-group">
          <label class="wt-color" title="Text color">A<input type="color" data-color="foreColor"></label>
          <label class="wt-color hl" title="Highlight">A<input type="color" data-color="hiliteColor" value="#fef08a"></label>
        </div>
        <div class="wt-group">
          <button data-cmd="undo" title="Undo (Ctrl+Z)">↩</button>
          <button data-cmd="redo" title="Redo (Ctrl+Y)">↪</button>
          <button data-cmd="removeFormat" title="Clear formatting">🧹</button>
        </div>
      </div>
      <div class="wysi-pane" data-pane="write"><div class="wysi-edit" contenteditable="true" spellcheck="true"></div></div>
      <div class="wysi-pane hidden" data-pane="html">
        <div class="html-wrap">
          <pre class="html-hl" aria-hidden="true"><code></code></pre>
          <textarea class="html-src" spellcheck="false" placeholder="<p>Edit the raw HTML source…"></textarea>
        </div>
      </div>
      <div class="wysi-pane hidden" data-pane="preview"><div class="md wysi-preview"></div></div>
      <div class="wysi-status"><span data-role="words"></span><span data-role="hint">Tip: paste from Word/Google Docs — formatting is preserved.</span></div>
    </div>`;

  const edit = mount.querySelector('.wysi-edit');
  const htmlSrc = mount.querySelector('.html-src');
  const htmlHl = mount.querySelector('.html-hl code');
  const htmlWrap = mount.querySelector('.html-wrap');
  const preview = mount.querySelector('.wysi-preview');
  const wordsEl = mount.querySelector('[data-role="words"]');
  let currentTab = 'write';

  function highlightHtml(src) {
    const e = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return e.replace(/(&lt;\/?)([a-zA-Z][a-zA-Z0-9-]*)/g, '$1<span class="tok-tag">$2</span>')
            .replace(/([a-zA-Z-]+)=(&quot;|")([^"&]*)(&quot;|")/g, '<span class="tok-attr">$1</span>=<span class="tok-str">"$3"</span>');
  }

  function syncWords() {
    const words = edit.innerText.trim().split(/\s+/).filter(Boolean).length;
    wordsEl.textContent = words + ' words';
  }

  function toHtmlTab() { htmlSrc.value = edit.innerHTML; htmlHl.innerHTML = highlightHtml(edit.innerHTML) + '\n'; }
  function toWriteTab() { edit.innerHTML = htmlSrc.value; syncWords(); }
  function toPreviewTab() { preview.innerHTML = currentTab === 'html' ? htmlSrc.value : edit.innerHTML; }

  function showTab(name) {
    if (currentTab === 'write' && name !== 'write') toHtmlTab();
    if (currentTab === 'html' && name !== 'html') toWriteTab();
    currentTab = name;
    mount.querySelectorAll('.wysi-tabs .wt').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    mount.querySelectorAll('.wysi-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== name));
    mount.querySelector('.wysi-toolbar').style.display = name === 'write' ? '' : 'none';
    if (name === 'preview') toPreviewTab();
    if (name === 'write') edit.focus();
  }

  mount.querySelectorAll('.wysi-tabs .wt').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

  htmlSrc.addEventListener('input', () => { htmlHl.innerHTML = highlightHtml(htmlSrc.value) + '\n'; });
  htmlSrc.addEventListener('scroll', () => {
    htmlWrap.querySelector('.html-hl').scrollTop = htmlSrc.scrollTop;
    htmlWrap.querySelector('.html-hl').scrollLeft = htmlSrc.scrollLeft;
  });

  // paste as rich HTML (default), but strip scripts/styles/event handlers
  edit.addEventListener('paste', () => setTimeout(() => {
    edit.querySelectorAll('script, style').forEach(n => n.remove());
    edit.querySelectorAll('*').forEach(n => {
      [...n.attributes].forEach(a => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); });
    });
    syncWords();
  }, 0));
  edit.addEventListener('input', syncWords);
  edit.addEventListener('keyup', syncWords);

  function exec(cmd, val = null) { edit.focus(); document.execCommand(cmd, false, val); syncWords(); }
  function block(tag) { edit.focus(); document.execCommand('formatBlock', false, tag); syncWords(); }

  mount.querySelectorAll('[data-cmd]').forEach(b => { b.onclick = (e) => { e.preventDefault(); exec(b.dataset.cmd); }; });
  mount.querySelectorAll('[data-block]').forEach(b => { b.onclick = (e) => { e.preventDefault(); block(b.dataset.block); }; });
  mount.querySelectorAll('[data-color]').forEach(inp => {
    inp.addEventListener('input', () => exec(inp.dataset.color, inp.value));
    inp.addEventListener('click', (e) => e.stopPropagation());
  });

  mount.querySelectorAll('[data-act]').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    const act = b.dataset.act;
    if (act === 'link') {
      const url = prompt('Link URL (https://…):', 'https://');
      if (url) exec('createLink', url);
    } else if (act === 'image') {
      if (onPickImage) onPickImage((url, alt) => exec('insertImage', url));
      else {
        const url = prompt('Image URL:');
        if (url) exec('insertImage', url);
      }
    } else if (act === 'table') {
      const rows = parseInt(prompt('Rows:', '3') || '3', 10);
      const cols = parseInt(prompt('Columns:', '3') || '3', 10);
      let t = '<table><tbody>';
      for (let r = 0; r < Math.min(20, rows || 3); r++) {
        t += '<tr>';
        for (let c = 0; c < Math.min(10, cols || 3); c++) t += '<td> </td>';
        t += '</tr>';
      }
      exec('insertHTML', t + '</tbody></table><p></p>');
    }
  });

  // keyboard: tab inserts two spaces in HTML tab
  htmlSrc.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = htmlSrc.selectionStart;
      htmlSrc.value = htmlSrc.value.slice(0, s) + '  ' + htmlSrc.value.slice(htmlSrc.selectionEnd);
      htmlSrc.selectionStart = htmlSrc.selectionEnd = s + 2;
      htmlHl.innerHTML = highlightHtml(htmlSrc.value) + '\n';
    }
  });

  edit.innerHTML = initial;
  syncWords();

  return {
    el: mount.querySelector('.wysi'),
    getHtml() {
      if (currentTab === 'html') return htmlSrc.value;
      return edit.innerHTML;
    },
    setHtml(html) {
      if (currentTab === 'html') { htmlSrc.value = html; htmlHl.innerHTML = highlightHtml(html) + '\n'; }
      else { edit.innerHTML = html; syncWords(); }
    },
    focus() { showTab('write'); },
  };
}
