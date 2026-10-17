"""Repair source labels and embed hash-verified image targets; do not claim device validation."""
from pathlib import Path
from lxml import html, etree
import re,json,hashlib,base64
root=Path(__file__).resolve().parents[1]
p=root/'review/EMBLEM_Chat_Archive.html'
s=p.read_text();assert 'class="original-viewer"' not in s, 'Already repaired; use the retained pre-repair source';dom=html.fromstring(s,parser=html.HTMLParser(huge_tree=True));data=dom.get_element_by_id('chat-data');d=json.loads(data.text)
turns={t['id']:t for c in d['conversations'].values() for t in c['turns']}
removed=0
for article in dom.xpath('//article[@data-turn-id]'):
 t=turns[article.get('data-turn-id')]
 for panel in article.xpath('./details[@class="activity"]'):
  if not(t.get('durations') or t.get('activityObservations') or t.get('toolEvents')):
   panel.getparent().remove(panel);removed+=1
  else: panel.find('summary').text=' · '.join(dict.fromkeys(t.get('durations',[]))) or 'Captured activity'
# Embed exact originals only after checking recorded hashes.
ids=set(dom.xpath('//*[@data-archive-image]/@data-archive-image'))
manifest=[]
for f in d['files']:
 if f['id'] not in ids:continue
 source=root/'review'/f['path']
 if not source.is_file() or not f.get('originalVerified'):continue
 raw=source.read_bytes()
 assert hashlib.sha256(raw).hexdigest()==f['sha256'],f['name']
 mime='image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg' if raw.startswith(b'\xff\xd8') else 'image/webp' if raw[8:12]==b'WEBP' else None
 if not mime:continue
 ident='original-'+f['id'];anchor='return-'+f['id']
 viewer=html.Element('section',id=ident,attrib={'class':'original-viewer','aria-label':f['name']})
 close=etree.SubElement(viewer,'a',href='#'+anchor);close.text='← Back to conversation'
 title=etree.SubElement(viewer,'p');title.text=f['name']+' · verified original'
 etree.SubElement(viewer,'img',src='data:'+mime+';base64,'+base64.b64encode(raw).decode(),alt=f['name'])
 dom.find('body').append(viewer)
 targets=dom.xpath('//*[@data-file="'+f['id']+'" and self::a]')
 for a in targets:
  a.set('href','#'+ident);a.set('data-original-viewer',ident);a.attrib.pop('download',None);a.attrib.pop('target',None)
 imgs=dom.xpath('//*[@data-archive-image="'+f['id']+'"]')
 if imgs:imgs[0].set('id',anchor)
 manifest.append({'id':f['id'],'sha256':f['sha256'],'bytes':len(raw),'viewer':ident})
style=etree.SubElement(dom.find('head'),'style');style.text='''
.original-viewer{display:none}.original-viewer:target{display:block;position:fixed;inset:0;z-index:10000;background:white;overflow:auto;padding:16px;box-sizing:border-box}.original-viewer img{display:block;width:100%;height:auto;max-width:none;border-radius:0}.original-viewer a{display:inline-block;padding:12px 0;color:#222}.original-viewer p{font:14px system-ui;overflow-wrap:anywhere}
'''
js=dom.xpath('//script[not(@type="application/json")]')[0]
js.text=js.text.replace('const activity=true?',"const activity=(t.durations.length||(t.activityObservations||[]).length||(t.toolEvents||[]).length)?")
# Route both interactive attachment links and image buttons to the embedded original.
js.text=js.text.replace("case 'file':case 'image':showFile(el.dataset.file);break;", "case 'file':case 'image':{const target=document.getElementById('original-'+el.dataset.file);if(target)location.hash=target.id;else showFile(el.dataset.file);break;}")
p.write_text('<!doctype html>\n'+html.tostring(dom,encoding='unicode'))
(root/'evidence/screenshot-repair.json').write_text(json.dumps({'removedEmptyPanels':removed,'embeddedOriginals':manifest,'renderedValidation':'PENDING','iphoneValidation':'PENDING'},indent=2))
print(json.dumps({'removedEmptyPanels':removed,'embeddedOriginals':len(manifest),'bytes':sum(x['bytes'] for x in manifest)}))
