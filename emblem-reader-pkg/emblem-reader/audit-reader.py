"""Shared offline release gate. Does not claim browser interaction or source completeness."""
from pathlib import Path
from lxml import html
from urllib.parse import unquote, urlsplit
import argparse, json, hashlib


def audit(path, asset_root):
    path = Path(path)
    doc = html.fromstring(path.read_bytes(), parser=html.HTMLParser(huge_tree=True))
    data = json.loads(doc.get_element_by_id('chat-data').text)
    ids = doc.xpath('//*[@id]/@id')
    errors = []
    if len(ids) != len(set(ids)): errors.append('Duplicate DOM IDs')
    chats = {}
    for key, chat in data['conversations'].items():
        section = doc.get_element_by_id('saved-' + key)
        turns = chat['turns']
        articles = section.xpath('./article[@data-turn-id]')
        if section.getparent().get('id') != 'messages': errors.append(key + ': misplaced section')
        if [a.get('data-turn-id') for a in articles] != [t['id'] for t in turns]: errors.append(key + ': turn order/ownership mismatch')
        if section.xpath('.//article//article'): errors.append(key + ': nested turns')
        missing_activity = []
        panels = 0
        for turn, article in zip(turns, articles):
            captured = bool(turn.get('activityObservations') or turn.get('toolEvents') or turn.get('activityPresentation'))
            panel = article.xpath('./details[contains(concat(" ",normalize-space(@class)," ")," activity ")]')
            if captured != bool(panel): errors.append(key + ':' + turn['id'] + ': activity disclosure mismatch')
            if panel:
                panels += 1
                if len(panel[0].xpath('./summary')) != 1: errors.append(turn['id'] + ': invalid summary')
                if not ''.join(panel[0].xpath('./div//text()')).strip(): errors.append(turn['id'] + ': empty activity')
            elif turn.get('durations'): missing_activity.append(turn['id'])
            replies = article.xpath('./section[contains(@class,"assistant-message")]')
            if bool(replies) != bool(turn.get('hasAssistant')): errors.append(turn['id'] + ': reply mismatch')
        chats[key] = {'turns':len(turns), 'replies':sum(bool(t.get('hasAssistant')) for t in turns), 'activityDropdowns':panels, 'durationWithoutCapturedActivity':missing_activity, 'rawToolRecords':sum(len(t.get('toolEvents',[])) for t in turns)}
    broken_anchors = sorted(set(h for h in doc.xpath('//a/@href') if h.startswith('#') and h[1:] and unquote(h[1:]) not in ids))
    if broken_anchors: errors.append('Broken fragment links')
    files = []
    for f in data.get('files', []):
        target = (Path(asset_root) / f['path']).resolve()
        if not target.is_relative_to(Path(asset_root).resolve()): status = 'unsafe-path'
        elif not target.is_file(): status = 'missing'
        else:
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            status = 'verified' if digest == f.get('sha256') else 'hash-mismatch'
        files.append({'id':f['id'], 'path':f['path'], 'status':status})
    return {'schema':'emblem.reader.audit/1','reader':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'chats':chats,'structuralErrors':errors,'brokenAnchors':broken_anchors,'assets':files,'browserInteractions':'not-tested','fullScrollComparison':'blocked-by-prior-candidate-browser-restriction','sourceCompleteness':'unverified','releaseApproved':False}

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('readers', nargs='+')
    p.add_argument('--asset-root', required=True)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    results = [audit(reader,a.asset_root) for reader in a.readers]
    Path(a.out).write_text(json.dumps(results,indent=2))
    print(json.dumps([{k:v for k,v in r.items() if k not in ('assets','chats')} | {'chats':{k:{f:v for f,v in c.items() if f != 'durationWithoutCapturedActivity'} for k,c in r['chats'].items()},'assetCounts':{s:sum(f['status']==s for f in r['assets']) for s in sorted(set(f['status'] for f in r['assets']))}} for r in results],indent=2))
    raise SystemExit(1 if any(r['structuralErrors'] for r in results) else 0)
