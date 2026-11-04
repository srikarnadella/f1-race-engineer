const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The dashboard's h() helpers skip a null child, but the DOM's own replaceChildren / append / prepend
// print it as the word "null". It shipped four times (Strategy, Head to head, Manage models, All races)
// before this test: a ternary with a null branch at the top level of one of those calls.
const DIR = path.join(__dirname, '..', 'public');

function nullArgs(src) {
  const found = [];
  const re = /\.(replaceChildren|append|prepend)\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    // Only what sits at the call's own top level: inside h(...) a null is skipped.
    let d = 0;
    let top = '';
    for (const ch of src.slice(m.index + m[0].length, i)) {
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) d--;
      else if (d === 0) top += ch;
    }
    if (/:\s*null\b/.test(top) || /\?\s*null\s*:/.test(top)) found.push(src.slice(0, m.index).split('\n').length);
  }
  return found;
}

test('dom: no replaceChildren / append / prepend is handed a null to print', () => {
  const bad = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).flatMap((f) => nullArgs(fs.readFileSync(path.join(DIR, f), 'utf8')).map((line) => `${f}:${line}`));
  assert.deepStrictEqual(bad, []);
});

test('dom: the check itself catches the pattern', () => {
  assert.deepStrictEqual(nullArgs("el.replaceChildren(a, ok ? b : null);"), [1]);
  assert.deepStrictEqual(nullArgs("el.replaceChildren(h('p', {}, ok ? b : null));"), [], 'inside h() a null is skipped');
});
