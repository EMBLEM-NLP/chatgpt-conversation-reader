"""Parse archived HTML using Python's standard HTML parser; never run its scripts."""  # Keep extraction offline.
from html.parser import HTMLParser  # Use a real parser for entity decoding and code boundaries.
from pathlib import Path  # Read only the explicitly supplied local archive.
import hashlib, json, sys  # Return a compact, deterministic inspection to the TypeScript auditor.

def digest(value):  # Hash exact UTF-8 text, including code whitespace.
    return hashlib.sha256(value.encode('utf-8')).hexdigest()  # Never normalize source code before hashing.

class Archive(HTMLParser):  # Locate the single known structured transcript.
    def __init__(self):  # Initialize parser state without evaluating JavaScript.
        super().__init__(convert_charrefs=False); self.active = False; self.parts = []; self.count = 0  # Keep script JSON verbatim.
    def handle_starttag(self, tag, attrs):  # Inspect only the public archive element identifier.
        if tag == 'script' and dict(attrs).get('id') == 'chat-data': self.active = True; self.count += 1  # Reject ambiguity after parsing.
    def handle_endtag(self, tag):  # Stop at the matching script boundary.
        if tag == 'script': self.active = False  # Ignore the reader's executable script.
    def handle_data(self, value):  # Preserve the complete captured JSON payload.
        if self.active: self.parts.append(value)  # No truncation or heuristic content recovery.

class Markup(HTMLParser):  # Inspect response markup without browser execution.
    def __init__(self):  # Keep code blocks distinct from ordinary inline filenames.
        super().__init__(convert_charrefs=True); self.blocks = []; self.inline = []; self.stack = []; self.text = []; self.ignore = 0  # Exact code uses its own buffers.
    def handle_starttag(self, tag, attrs):  # Recognize explicit code semantics only.
        a = dict(attrs)  # Preserve attributes used to label code language.
        if tag in ('script', 'style', 'template'): self.ignore += 1  # Exclude application code from conversation counts.
        if tag == 'pre' or (a.get('data-d-component') == 'code-block' and not any(x['kind'] == 'block' for x in self.stack)):  # Avoid double counting nested code markup.
            item = {'kind': 'block', 'tag': tag, 'language': a.get('data-language', ''), 'parts': []}; self.stack.append(item)  # Start a genuine multiline code block.
        elif tag == 'code' and not self.stack: self.stack.append({'kind': 'inline', 'tag': tag, 'language': '', 'parts': []})  # Keep inline references separate.
        if tag == 'code' and self.stack:  # Read an explicit language class without guessing from the code.
            languages = [x[9:] for x in a.get('class', '').split() if x.startswith('language-')]  # Accept standard language annotations.
            if languages: self.stack[-1]['language'] = languages[0]  # Preserve the provided language label.
        if tag == 'br': self.handle_data('\n')  # Retain source line breaks in code rendered with break elements.
    def handle_endtag(self, tag):  # Close only the owning code element.
        if self.stack and self.stack[-1]['tag'] == tag:  # Nested formatting does not end a block.
            item = self.stack.pop(); value = ''.join(item['parts']); record = {'language': item['language'], 'text': value, 'sha256': digest(value)}  # Hash the original decoded code text.
            (self.blocks if item['kind'] == 'block' else self.inline).append(record)  # Keep separate inventories.
        if tag in ('script', 'style', 'template') and self.ignore: self.ignore -= 1  # Resume visible message text.
    def handle_data(self, value):  # Preserve code and visible-text evidence.
        if self.ignore: return  # Never count the archive implementation as an assistant code response.
        self.text.append(value)  # Retain message text for diagnostic comparison.
        for item in self.stack: item['parts'].append(value)  # Keep all code whitespace and decoded HTML entities.
    def result(self, value):  # Return structured facts with no browser or network claims.
        self.feed(value); self.close()  # Parse the entire supplied message.
        return {'htmlSha256': digest(value), 'htmlCharacters': len(value), 'text': ''.join(self.text), 'blocks': self.blocks, 'inline': self.inline, 'unclosedCodeBlocks': len(self.stack)}  # Surface malformed code instead of dropping it silently.

def inspect(path):  # Accept exactly one local HTML archive.
    raw = Path(path).read_text(encoding='utf-8'); parser = Archive(); parser.feed(raw); parser.close()  # Read all bytes once.
    if parser.count != 1: raise ValueError('Expected exactly one script#chat-data transcript')  # Reject a missing or ambiguous source.
    data = json.loads(''.join(parser.parts)); turns = []  # Decode the existing transcript, not hidden app state.
    for chat, conversation in data['conversations'].items():  # Preserve branch and turn order.
        for turn in conversation['turns']:  # Inspect source and display markup independently.
            roles = {role: {'source': Markup().result(turn.get('source' + role.title() + 'Html', turn[role + 'Html'])), 'display': Markup().result(turn[role + 'Html'])} for role in ('user', 'assistant')}  # Detect dropped or altered code in either role.
            turns.append({'chat': chat, 'id': turn['id'], 'index': turn['index'], 'prompt': turn['prompt'], 'hasAssistant': turn['hasAssistant'], 'htmlComplete': turn.get('htmlComplete'), 'durations': turn.get('durations', []), 'roles': roles, 'activities': turn.get('activityObservations', []), 'toolEvents': turn.get('toolEvents', [])})  # Missing tool inventories remain empty, never inferred.
    return {'schema': 'emblem.chat.content-inspection/1', 'archiveSha256': digest(raw), 'capturedAt': data.get('capturedAt'), 'scope': data.get('scope', {}), 'turns': turns, 'files': [{'id': f['id'], 'name': f['name'], 'extension': f['extension'], 'path': f['path']} for f in data.get('files', [])], 'mediaCount': len(data.get('media', [])), 'gaps': data.get('gaps', []), 'sourceInventoryVerified': False, 'toolInventoryVerified': False}  # A rendered snapshot cannot prove account-export completeness.

if __name__ == '__main__':  # Expose a stdin-free adapter for the TypeScript CLI.
    try: print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))  # Emit one machine-readable result.
    except Exception as error: print(str(error), file=sys.stderr); sys.exit(1)  # Fail without fabricating an empty successful inventory.
