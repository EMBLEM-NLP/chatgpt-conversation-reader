"""Apply independently checked reader repair loops; retain captured source markup."""
from pathlib import Path
from lxml import html, etree
import re, json, base64, hashlib, sys
root = Path(__file__).resolve().parent.parent
path = root/'review/EMBLEM_Chat_Archive.html'
loop = int(sys.argv[1])
text = path.read_text()
pattern = r'(<script[^>]*id="chat-data"[^>]*>)(.*?)(</script>)'
data = json.loads(re.search(pattern,text,re.S)[2])
original_source = {t['id']:(t.get('sourceUserHtml'),t.get('sourceAssistantHtml')) for c in data['conversations'].values() for t in c['turns']}
dom = html.fromstring(text,parser=html.HTMLParser(huge_tree=True))
script = next(e for e in dom.xpath('//script') if e.get('type') != 'application/json')
js = script.text
evidence = root/'evidence/five-loops'
checks = []
def replace(old,new):
    global js
    if old not in js: raise ValueError('Expected code missing: '+old[:90])
    js=js.replace(old,new)
def check(name,condition):
    checks.append({'test':name,'pass':bool(condition)})
    if not condition: raise AssertionError(name)
if loop == 2:
    assets={a['id']:a for a in json.loads((evidence/'assets.json').read_text())}
    files={f['id']:f for f in data['files']}
    for f in data['files']:
        f['originalVerified']=assets[f['id']]['verified']
        f['delivery']='EXTRACTED_BUNDLE' if f['originalVerified'] else 'UNAVAILABLE'
        if 'text' in f and f['originalVerified']:
            raw=(path.parent/f['path']).read_bytes()
            f['downloadData']='data:application/octet-stream;base64,'+base64.b64encode(raw).decode()
            f['delivery']='EMBEDDED_EXACT_BYTES'
    # Source DOM links become real anchors only for verified originals.
    for e in dom.xpath('//*[@data-file or @data-archive-file]'):
        f=files.get(e.get('data-file') or e.get('data-archive-file'))
        if f is None or e.tag not in ('a','span'): continue
        if f['originalVerified']:
            if e.tag=='span' and e.get('data-archive-file'): e.tag='a'
            if e.tag=='a':
                e.set('href',f.get('downloadData',f['path']));e.set('download',f['name'])
        elif e.tag=='a':
            e.tag='span';e.attrib.pop('href',None);e.attrib.pop('download',None)
            e.set('class',e.get('class','')+' unavailable-ref');e.set('title','Original unavailable; embedded preview is not the original')
    replace("const fileChip=(f,label='')=>`", "const fileChip=(f,label='')=>!f.originalVerified?`<span class=\"file-chip unavailable-ref\" data-action=\"coverage\">${esc(label||f.name)} · Original unavailable</span>`:`")
    replace('href="${esc(f.path)}"', 'href="${esc(f.downloadData||f.path)}"')
    replace("const f=files.get(id);if(!f)return;const a=document.createElement('a');a.href=f.path;a.download=f.name;a.click();toast('Original downloads require the extracted asset ZIPs.');", "const f=files.get(id);if(!f)return;if(!f.originalVerified){toast('Original unavailable. Preview is not an original.');return}const a=document.createElement('a');a.href=f.downloadData||f.path;a.download=f.name;a.click();toast(f.downloadData?'Exact embedded file download requested.':'Verified original download requested; extract all asset parts beside this HTML first.');")
    replace('preview+`<div class="preview-actions"><a href="${esc(f.downloadData||f.path)}" download="${esc(f.name)}">Download original · ${size(f.size)}</a>', 'preview+`<div class="preview-actions">${f.originalVerified?`<a href="${esc(f.downloadData||f.path)}" download="${esc(f.name)}">Download original · ${size(f.size)}</a>`:`<p>Original unavailable. The displayed preview is not the original file.</p>`}')
    replace("if(f){const wrapper=document.createElement('div');", "if(f){if(!f.originalVerified){a.textContent+=' · Original unavailable';a.classList.add('unavailable-ref');return}const wrapper=document.createElement('div');")
    replace('Original downloads require the Reader ZIP and all seven asset ZIPs extracted together.', '584 text downloads are embedded. Other verified originals require all supplied asset parts extracted beside this HTML. Unavailable originals are not downloadable.')
    data['assetCoverage']={'verified':677,'unavailable':19,'embeddedExactText':584,'browserDownloadsVerified':False}
    for f in data['files']:
        if f.get('downloadData'):
            check('embedded hash '+f['id'],hashlib.sha256(base64.b64decode(f['downloadData'].split(',')[1])).hexdigest()==f['sha256'])
    check('missing-file download is guarded',"if(!f.originalVerified){toast('Original unavailable." in js)
    check('all native file anchors resolve',all(a.get('href','').startswith('data:') or (path.parent/a.get('href','')).is_file() for a in dom.xpath('//a[starts-with(@href,"files/") or starts-with(@href,"data:")]')))
elif loop == 3:
    turn=data['conversations']['mountain']['turns'][4]
    target=dom.xpath('//article[@data-turn-id="'+turn['id']+'"]')[0]
    static_body=target.xpath('.//*[@class="assistant-body"]')[0]
    def gallery(body, live):
        figures=body.xpath('.//figure[contains(@class,"image-figure")][img[@data-archive-image]]')
        check(('live' if live else 'static')+' gallery has ten images',len(figures)==10)
        g=etree.Element('div',{'class':'archive-gallery','aria-label':'Generated image gallery'})
        stage=etree.Element('div',{'class':'gallery-stage'})
        rail=etree.Element('div',{'class':'gallery-rail','aria-label':'Choose an image'})
        for i,fig in enumerate(figures):
            img=fig.xpath('.//img')[0]
            selector='gallery-'+turn['id']+'-'+str(i)
            radio=etree.SubElement(g,'input',{'type':'radio','name':'gallery-'+turn['id'],'id':selector,'class':'gallery-radio','aria-label':'Select image '+str(i+1)})
            if i==0: radio.set('checked','checked')
            panel=etree.SubElement(stage,'div',{'class':'gallery-panel component-image','data-index':str(i)})
            panel.append(etree.fromstring(etree.tostring(img,method='xml')))
            label=etree.SubElement(rail,'label',{'for':selector,'title':'Select image '+str(i+1)})
            thumb=etree.fromstring(etree.tostring(img,method='xml'))
            thumb.set('data-gallery-thumb',thumb.attrib.pop('data-archive-image'))
            thumb.attrib.pop('data-action',None);thumb.set('alt','Thumbnail '+str(i+1))
            label.append(thumb)
        g.append(stage);g.append(rail)
        figures[0].addprevious(g)
        for fig in figures: fig.getparent().remove(fig)
        return g
    gallery(static_body,False)
    live=html.fragment_fromstring(turn['assistantHtml'],create_parent='div')
    gallery(live,True)
    turn['assistantHtml']=''.join(etree.tostring(e,encoding='unicode',method='html') for e in live)
    css='''.archive-gallery{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 56px;gap:10px;align-items:start;margin:18px 0}.gallery-radio{position:absolute;opacity:0;width:1px;height:1px}.gallery-stage{min-width:0}.gallery-panel{display:none;margin:0!important}.gallery-panel img{width:100%!important;height:auto!important;border-radius:36px!important}.gallery-rail{display:flex;flex-direction:column;gap:10px;max-height:240px;overflow-y:auto;padding:3px}.gallery-rail label{cursor:pointer;border-radius:12px;display:block;flex:none}.gallery-rail img{width:50px!important;height:50px!important;object-fit:cover!important;border-radius:10px!important;margin:0!important}.gallery-radio:focus-visible~.gallery-rail{outline:2px solid #8952ee}.no-js .archive-gallery{display:grid}'''
    for i in range(10): css+='#gallery-'+turn['id']+'-'+str(i)+':checked~.gallery-stage>[data-index="'+str(i)+'"]{display:block}#gallery-'+turn['id']+'-'+str(i)+':checked~.gallery-rail>label:nth-child('+str(i+1)+'){outline:2px solid #aaa;outline-offset:2px}'
    etree.SubElement(dom.find('head'),'style',id='gallery-rsi').text=css
    replace('function hydrateMessages(){', "function hydrateMessages(){\n $$('[data-gallery-thumb]').forEach(img=>{img.src=D.previews[img.dataset.galleryThumb]||files.get(img.dataset.galleryThumb)?.path||''});")
    check('native radio controls',len(dom.xpath('//input[contains(@class,"gallery-radio")]'))==10)
    check('source markup unchanged',turn['sourceAssistantHtml']==original_source[turn['id']][1])
elif loop == 4:
    # Disable only fallback controls; active startup explicitly restores them.
    for e in dom.xpath('//button | //textarea'):
        if e.tag=='button' and (e.get('id')=='send-draft' or e.get('disabled') is not None): continue
        e.set('data-static-disabled','true')
        if e.tag=='textarea': e.set('readonly','readonly')
        else: e.set('disabled','disabled')
        e.set('title','Unavailable in a read-only file preview; open the live chat')
    zone=dom.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," composer-zone ")]')[0]
    note=etree.SubElement(zone,'div',{'class':'static-mode-note'})
    note.text='Read-only preview · Open live: '
    for key,c in data['conversations'].items():
        link=etree.SubElement(note,'a',href=c['url'],target='_blank',rel='noopener');link.text=key.title()+' chat';link.tail='  '
    etree.SubElement(dom.find('head'),'style',id='static-rsi').text='.static-mode-note{display:none}.no-js .static-mode-note{display:block;font-size:11px;text-align:center;padding:3px 8px;color:#777}.no-js [data-static-disabled]{cursor:default!important}.no-js .composer-row button{opacity:.35!important}.no-js .static-mode-note a{color:#6942b4}.activity summary:after{content:"⌄";font-size:18px;margin-left:4px}.activity[open] summary:after{content:"⌃"}'
    replace('function renderChat(options={}){', "function renderChat(options={}){\n $$('[data-static-disabled]').forEach(el=>{el.disabled=false;el.readOnly=false;el.removeAttribute('data-static-disabled');el.removeAttribute('title')});")
    count=sum(len(t.get('activityObservations',[])) for c in data['conversations'].values() for t in c['turns'])
    data['scope']['activitySummaries']=str(count)+' public activity summaries recovered; the remaining detailed activity inventory is unverified.'
    data['contentCoverage']['totals']['activitySummaries']=count
    check('read-only fallback has live links',len(note.xpath('.//a'))==2)
    check('static composer controls disabled',all(e.get('disabled') is not None for e in zone.xpath('.//button')))
    check('active startup restores controls',"el.disabled=false;el.readOnly=false" in js)
else: raise ValueError('Supported repair loops: 2, 3, 4')
for c in data['conversations'].values():
    for t in c['turns']: check('source unchanged '+t['id'],original_source[t['id']]==(t.get('sourceUserHtml'),t.get('sourceAssistantHtml')))
dom.set('data-reader-revision',str(9+loop-1))
dom.xpath('//script[@id="chat-data"]')[0].text=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
script.text=js
out=etree.tostring(dom,encoding='unicode',method='html',doctype='<!doctype html>')
path.write_text(out)
(evidence/('loop-'+str(loop)+'.json')).write_text(json.dumps({'loop':loop,'tests':len(checks),'passed':sum(c['pass'] for c in checks),'checks':checks,'readerSha256':hashlib.sha256(out.encode()).hexdigest(),'browserVerified':False},indent=2))
print(json.dumps({'loop':loop,'checks':len(checks),'passed':sum(c['pass'] for c in checks),'bytes':len(out.encode())}))
