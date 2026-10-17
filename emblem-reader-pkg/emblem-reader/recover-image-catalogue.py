"""Recover catalogue assets by exact SHA-256 from files, ZIP members and embedded images."""
from pathlib import Path
from lxml import html
import argparse,base64,hashlib,json,zipfile

def recover(reader, roots, asset_root, report):
    doc=html.fromstring(Path(reader).read_bytes(),parser=html.HTMLParser(huge_tree=True))
    data=json.loads(doc.get_element_by_id('chat-data').text)
    missing={f['sha256']:f for f in data['files'] if not (Path(asset_root)/f['path']).is_file()}
    found=[]; errors=[]; scanned=0
    sizes={f['size'] for f in missing.values()}
    def accept(raw,source):
        digest=hashlib.sha256(raw).hexdigest()
        if digest not in missing:return
        f=missing.pop(digest);target=(Path(asset_root)/f['path']).resolve()
        if not target.is_relative_to(Path(asset_root).resolve()):raise ValueError('Unsafe catalogue path')
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        found.append({'id':f['id'],'name':f['name'],'sha256':digest,'source':source,'path':f['path']})
    for img in doc.xpath('//img[starts-with(@src,"data:")]'):
        value=img.get('src')
        if ';base64,' in value:
            accept(base64.b64decode(value.split(',',1)[1]),'embedded reader image')
    for root in roots:
        for p in Path(root).rglob('*'):
            if not p.is_file():continue
            if p.stat().st_size in sizes:accept(p.read_bytes(),str(p))
            if '.zip' not in p.name.lower() or not zipfile.is_zipfile(p):continue
            try:
                with zipfile.ZipFile(p) as z:
                    for member in z.infolist():
                        scanned+=1
                        if member.file_size in sizes:accept(z.read(member),str(p)+'!'+member.filename)
            except (OSError,zipfile.BadZipFile,RuntimeError) as e:errors.append({'path':str(p),'error':str(e)})
    result={'recovered':found,'unresolved':list(missing.values()),'zipMembersExamined':scanned,'errors':errors,'matching':'exact SHA-256 only; no filename or visual substitution'}
    Path(report).write_text(json.dumps(result,indent=2))
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--reader',required=True);p.add_argument('--roots',nargs='+',required=True);p.add_argument('--asset-root',required=True);p.add_argument('--report',required=True);p.add_argument('--require-complete',action='store_true');a=p.parse_args()
    r=recover(a.reader,a.roots,a.asset_root,a.report)
    print(json.dumps({'recovered':len(r['recovered']),'unresolved':len(r['unresolved']),'zipMembersExamined':r['zipMembersExamined'],'errors':r['errors']}))

    if a.require_complete and (r["unresolved"] or r["errors"]):raise SystemExit(2)
