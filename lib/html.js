'use strict';
/* Article HTML sanitization — single source of truth used by the API
   and by the Markdown→HTML migration. Tables, media and common rich-text
   elements are allowed; scripts, iframes, forms and event handlers are not. */

const sanitizeHtml = require('sanitize-html');

const ARTICLE_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'input',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'video', 'source', 'hr', 'details', 'summary',
  'mark', 'kbd', 'abbr', 'sub', 'sup', 'del', 'ins', 'u',
]);

function sanitizeArticleHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      video: ['src', 'controls', 'width', 'height', 'poster'],
      source: ['src', 'type'],
      code: ['class'],
      pre: ['class'],
      span: ['class', 'id', 'style'],
      p: ['style', 'class'],
      div: ['class', 'style'],
      td: ['colspan', 'rowspan', 'style', 'align'],
      th: ['colspan', 'rowspan', 'style', 'align', 'scope'],
      table: ['class', 'style'],
      h1: ['id', 'style'], h2: ['id', 'style'], h3: ['id', 'style'],
      h4: ['id', 'style'], h5: ['id', 'style'], h6: ['id', 'style'],
      input: ['type', 'checked', 'disabled'],
      abbr: ['title'],
    },
    allowedStyles: {
      '*': {
        'color': [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/],
        'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/],
        'text-align': [/^(left|right|center|justify)$/],
        'font-size': [/^\d+(px|pt|em|rem|%)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowDataImages: true,
    transformTags: {
      a: (tagName, attribs) => {
        const out = { tagName, attribs: { ...attribs } };
        const href = String(attribs.href || '');
        if (/^https?:\/\//i.test(href)) {
          out.attribs.target = '_blank';
          out.attribs.rel = 'noopener noreferrer';
        }
        return out;
      },
    },
  });
}

/** Remove `</style>` breakouts and script tags from admin-supplied custom CSS. */
function sanitizeCustomCss(css) {
  return String(css || '')
    .replace(/<\/style/gi, '')
    .replace(/<script/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .slice(0, 20000);
}

module.exports = { sanitizeArticleHtml, sanitizeCustomCss };
