"""Restore image viewer return targets after rebuilding transcript markup."""
from pathlib import Path
from lxml import html
import sys

def repair(path):
    p = Path(path)
    doc = html.fromstring(p.read_bytes(),parser=html.HTMLParser(huge_tree=True))
    ids = set(doc.xpath('//*[@id]/@id'))
    restored = 0
    for href in sorted(set(doc.xpath('//a[starts-with(@href,"#return-")]/@href'))):
        target = href[1:]
        if target in ids: continue
        original = '#original-' + target[len('return-'):]
        links = doc.xpath('//a[@href=$href]',href=original)
        if not links:
            for close in doc.xpath('//a[@href=$href]',href=href): close.set('href','#messages')
            restored += 1
            continue
        anchor = html.Element('span',id=target)
        links[0].addprevious(anchor)
        ids.add(target)
        restored += 1
    p.write_text('<!doctype html>\n' + html.tostring(doc,encoding='unicode'))
    return restored

if __name__ == '__main__':
    for p in sys.argv[1:]: print(p,repair(p))
