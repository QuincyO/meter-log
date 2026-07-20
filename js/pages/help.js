/* Help page: fetch USER-GUIDE.md (the single copy of the user guide) and
 * render it. Both files ride the service-worker shell, so this works offline.
 *
 * The renderer handles only the subset the guide is written in — #/##/###
 * headings, paragraphs, - bullets, 1. numbered lists, --- rules, **bold**,
 * `code` — keep USER-GUIDE.md inside that subset. */

import { $, esc } from '../dom.js';

// **bold** and `code`, applied after escaping
function inline(s){
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function renderMd(md){
  const out = [];
  let list = null;            // 'ul' | 'ol' while inside a list
  const closeList = () => { if(list){ out.push(`</${list}>`); list = null; } };

  for(const raw of md.split('\n')){
    const line = raw.trimEnd();
    let m;
    if(!line.trim()){ closeList(); continue; }
    if(/^---+$/.test(line)){ closeList(); out.push('<hr>'); continue; }
    if((m = line.match(/^(#{1,3})\s+(.*)$/))){
      closeList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      continue;
    }
    if((m = line.match(/^-\s+(.*)$/))){
      if(list !== 'ul'){ closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if((m = line.match(/^\d+\.\s+(.*)$/))){
      if(list !== 'ol'){ closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

async function load(){
  try{
    const resp = await fetch('USER-GUIDE.md');
    if(!resp.ok) throw new Error(resp.status);
    $('guide').innerHTML = renderMd(await resp.text());
  }catch(e){
    $('guide').innerHTML =
      '<p class="muted">Couldn’t load the guide — check your connection and reload. ' +
      'Once it has loaded on this device once, it works offline.</p>';
  }
}
load();

$('backBtn').onclick = () => {
  if(document.referrer && history.length > 1) history.back();
  else window.location.href = 'index.html';
};
