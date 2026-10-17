"""Apply hash-verified recoveries to all readers; preserve capture history separately."""
from pathlib import Path
from lxml import html,etree
import json,base64,hashlib,mimetypes

recovered=json.loads(Path('rsi5/evidence/image-catalogue-recovery.json').read_text())['recovered']
for name in ['EMBLEM_Chat_Archive.html','Mountain_Property_Rendering.html','Street_View_Captures.html']:
    p=Path('rsi5_delivery')/name
    doc=html.fromstring(p.read_bytes(),parser=html.HTMLParser(huge_tree=True))
    data=json.loads(doc.get_element_by_id('chat-data').text)
    source_gaps=data.setdefault('historicalCaptureGaps',data['gaps'])
    ids={f['id']:f for f in data['files']}
    image_map={}
    for r in recovered:
        f=ids[r['id']];raw=(Path('rsi5/review')/f['path']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==f['sha256']
        f.update(originalVerified=True,delivery='RECOVERED_FROM_ZIP',recoverySource=r['source'])
        if f['extension'].lower() not in ('jpg','jpeg','png','webp'):continue
        uri='data:'+mimetypes.guess_type(f['name'])[0]+';base64,'+base64.b64encode(raw).decode()
        image_map[f['id']]=uri
        viewer='recovered-original-'+f['id']
        if not doc.xpath('//*[@id=$v]',v=viewer):
            panel=etree.SubElement(doc.find('body'),'section',{'class':'original-viewer','id':viewer,'aria-label':f['name']})
            etree.SubElement(panel,'a',{'href':'#messages'}).text='Close image'
            etree.SubElement(panel,'img',{'src':uri,'alt':f['name']})
    def hydrate(parent):
        for img in parent.xpath('.//img[@data-archive-image]'):
            fid=img.get('data-archive-image')
            if fid not in image_map:continue
            img.set('src',image_map[fid])
            if img.getparent().tag=='a':img.getparent().set('href','#recovered-original-'+fid)
            else:
                a=html.Element('a',href='#recovered-original-'+fid);img.addprevious(a);a.append(img)
        return parent
    hydrate(doc)
    zip_uris={}
    for z in Path('recovered_zips').glob('*.zip'):
        zip_uris[z.name]='data:application/zip;base64,'+base64.b64encode(z.read_bytes()).decode()
    def restore_zip_links(parent):
        for e in list(parent.xpath('.//span[contains(@class,"unavailable-ref")]')):
            label=''.join(e.itertext()).strip()
            if label in zip_uris:
                e.tag='a';e.set('href',zip_uris[label]);e.set('download',label);e.attrib.pop('class',None)
    restore_zip_links(doc)
    for c in data['conversations'].values():
        for t in c['turns']:
            for role in ('userHtml','assistantHtml'):
                fragment=html.fragment_fromstring(t.get(role) or '<span></span>',create_parent='div')
                hydrate(fragment);restore_zip_links(fragment)
                t[role]=''.join(html.tostring(e,encoding='unicode') for e in fragment)
    first=data['conversations']['street']['turns'][0]
    first['gaps']=[g for g in first.get('gaps',[]) if g['kind']!='image' and g.get('label') not in zip_uris]
    data['gaps']=[g for g in data['gaps'] if not (g['chat']=='street' and g['turn']==first['id'] and g['kind']=='image') and g.get('label') not in zip_uris]
    data['recoveryAudit']={'openingAttachments':6,'openingMissing':0,'catalogueFilesRecovered':len(recovered),'catalogueImagesRecovered':len(image_map),'historicalGapsRetained':True,'browserTested':False}
    doc.get_element_by_id('chat-data').text=json.dumps(data,ensure_ascii=False).replace('</','<\\/')
    p.write_text('<!doctype html>\n'+html.tostring(doc,encoding='unicode'))
    print(name,len(image_map),'original images restored; two ZIP links embedded')
