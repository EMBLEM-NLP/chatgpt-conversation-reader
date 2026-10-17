"""Recover only byte-verified originals; ZIP access uses Python's standard library."""
from pathlib import Path
import json, re, hashlib, shutil, zipfile
root = Path(__file__).resolve().parent.parent
archive = root / 'review/EMBLEM_Chat_Archive.html'
data = json.loads(re.search(r'<script[^>]*id="chat-data"[^>]*>(.*?)</script>', archive.read_text(), re.S)[1])
sha = lambda raw: hashlib.sha256(raw).hexdigest()
source = root.parent / 'rsi5_sources'
index = {sha(p.read_bytes()): p for p in source.iterdir() if p.is_file()}
results = []
for f in data['files']:
    raw, method = None, 'UNAVAILABLE'
    if 'text' in f:
        variants = [(f['text'].encode(), 'EMBEDDED_EXACT'), (f['text'].replace('\r\n','\n').replace('\n','\r\n').encode(), 'EMBEDDED_CRLF_RESTORED')]
        for candidate, label in variants:
            if sha(candidate) == f['sha256'] and len(candidate) == f['size']:
                raw, method = candidate, label
                break
    if raw is None and f['sha256'] in index:
        raw, method = index[f['sha256']].read_bytes(), 'RECOVERED_SOURCE'
    if raw is None and f.get('pack') and f.get('member'):
        pack = next((p for p in data['files'] if p['name'] == f['pack'] and p['sha256'] in index), None)
        if pack:
            with zipfile.ZipFile(index[pack['sha256']]) as z:
                if f['member'] in z.namelist():
                    raw, method = z.read(f['member']), 'VERIFIED_ZIP_MEMBER'
    valid = raw is not None and sha(raw) == f['sha256'] and len(raw) == f['size']
    target = (archive.parent / f['path']).resolve()
    if not target.is_relative_to(archive.parent.resolve() / 'files'): raise ValueError('Unsafe catalogue path')
    if valid:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        assert sha(target.read_bytes()) == f['sha256']
    results.append({'id':f['id'], 'name':f['name'], 'path':f['path'], 'sha256':f['sha256'], 'bytes':f['size'], 'verified':valid, 'method':method if valid else 'UNAVAILABLE_OR_HASH_MISMATCH', 'libraryId':f.get('libraryId')})
evidence = root / 'evidence/five-loops'
evidence.mkdir(exist_ok=True)
(evidence/'assets.json').write_text(json.dumps(results, indent=2))
summary = {'loop':1, 'change':'Recover original bytes from embedded text, source files, and exact ZIP members', 'verified':sum(r['verified'] for r in results), 'unavailable':sum(not r['verified'] for r in results), 'bytes':sum(r['bytes'] for r in results if r['verified']), 'browserVerified':False}
(evidence/'loop-1.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary))
