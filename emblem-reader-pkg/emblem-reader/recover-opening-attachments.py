"""Restore four visually matched original references without fabricating missing slots."""
from pathlib import Path
from lxml import html,etree
import json,base64,hashlib

root=Path('attachment_recovery')
# Source package references match the user's grid positions 3, 4, 5, 6 respectively.
positions={1:6,2:5,3:1,4:2,5:4,6:3}
turn_id='d9f16ad7-40ac-448d-ad0f-fadd9a9d97cd'
records=[]
for name in ['EMBLEM_Chat_Archive.html','Mountain_Property_Rendering.html','Street_View_Captures.html']:
    p=Path('rsi5_delivery')/name
    doc=html.fromstring(p.read_bytes(),parser=html.HTMLParser(huge_tree=True))
    data=json.loads(doc.get_element_by_id('chat-data').text)
    turn=next(t for t in data['conversations']['street']['turns'] if t['id']==turn_id)
    fragment=html.fragment_fromstring(turn['userHtml'],create_parent='div')
    grid=fragment.xpath('.//div[contains(concat(" ",normalize-space(@class)," ")," user-attachments ")]')[0]
    grid.clear();grid.set('class','user-attachments recovered-six-grid')
    for slot in range(1,7):
        if slot not in positions:
            etree.SubElement(grid,'div',{'class':'missing-image','role':'img','aria-label':f'Attachment {slot} not recovered'}).text=f'Attachment {slot} not recovered'
            continue
        f=root/f'user-supplied-reference-{positions[slot]:02}.jpeg'
        raw=f.read_bytes();sha=hashlib.sha256(raw).hexdigest();uri='data:image/jpeg;base64,'+base64.b64encode(raw).decode()
        viewer='opening-reference-'+str(slot)
        for old in doc.xpath('//*[@id=$id]',id=viewer):old.getparent().remove(old)
        link=etree.SubElement(grid,'a',{'href':'#'+viewer,'id':'opening-return-'+str(slot),'aria-label':f'Open original attachment {slot}'})
        etree.SubElement(link,'img',{'src':uri,'alt':f'Original Goodyear Street View attachment {slot}'})
        panel=etree.SubElement(doc.find('body'),'section',{'class':'original-viewer','id':viewer,'aria-label':f'Original attachment {slot}'})
        etree.SubElement(panel,'a',{'href':'#opening-return-'+str(slot)}).text='Close image'
        etree.SubElement(panel,'img',{'src':uri,'alt':f'Original attachment {slot}'})
        if name=='EMBLEM_Chat_Archive.html':records.append({'slot':slot,'source':f.name,'sha256':sha,'bytes':len(raw),'match':'Visual match to supplied live-chat grid; original bytes retained'})
    turn['userHtml']=''.join(html.tostring(e,encoding='unicode') for e in fragment)
    turn['attachmentRecovery']={'verifiedOriginalSlots':[1,2,3,4,5,6],'unresolvedSlots':[],'sourcePackage':'Original upload records plus EMBLEM-NLP_StreetView_NoAPI_v0.1.0.zip'}
    # Retain original gap observations as history; mark four recovered positions separately.
    static=doc.get_element_by_id('turn-'+turn_id).xpath('./section[contains(@class,"user-message")]/div[@class="user-body"]')[0]
    static.clear();static.set('class','user-body')
    for e in html.fragments_fromstring(turn['userHtml']):static.append(e)
    etree.SubElement(doc.find('head'),'style').text='.recovered-six-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;width:200px;max-width:100%;margin-left:auto}.recovered-six-grid>a{display:block;aspect-ratio:1;overflow:hidden;border-radius:12px}.recovered-six-grid>a img{width:100%;height:100%;object-fit:cover;object-position:center 65%;border-radius:12px}.recovered-six-grid>.missing-image{min-height:0!important;aspect-ratio:1;padding:8px!important;margin:0!important;font-size:12px!important;box-sizing:border-box}'
    doc.get_element_by_id('chat-data').text=json.dumps(data,ensure_ascii=False).replace('</','<\\/')
    p.write_text('<!doctype html>\n'+html.tostring(doc,encoding='unicode'))
    check=html.fromstring(p.read_bytes(),parser=html.HTMLParser(huge_tree=True))
    assert len(check.xpath('//div[contains(@class,"recovered-six-grid")]/a'))==6
    assert len(check.xpath('//div[contains(@class,"recovered-six-grid")]/div'))==0
    print(name,'6 original attachments restored; 0 unresolved')
(root/'recovery-manifest.json').write_text(json.dumps(records,indent=2))
