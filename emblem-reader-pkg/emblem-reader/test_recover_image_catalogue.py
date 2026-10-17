"""Regression checks for archive-member recovery and exact-byte matching."""
import importlib.util,tempfile,unittest,zipfile,json,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('recover',Path(__file__).with_name('recover-image-catalogue.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RecoveryTests(unittest.TestCase):
    def run_case(self,payload):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);sources=root/'sources';sources.mkdir();assets=root/'assets';assets.mkdir()
            expected=b'original-image-bytes';digest=hashlib.sha256(expected).hexdigest()
            record={'id':digest,'sha256':digest,'size':len(expected),'path':'files/image.jpg','name':'image.jpg'}
            reader=root/'reader.html';reader.write_text('<html><script id="chat-data" type="application/json">'+json.dumps({'files':[record]})+'</script></html>')
            with zipfile.ZipFile(sources/'source.zip','w') as z:z.writestr('unknown/member/name.jpg',payload)
            result=module.recover(reader,[sources],assets,root/'report.json')
            return len(result['recovered']),len(result['unresolved'])
    def test_unknown_member_path_recovers_by_hash(self):
        self.assertEqual(self.run_case(b'original-image-bytes'),(1,0))
    def test_same_size_different_bytes_stay_unresolved(self):
        self.assertEqual(self.run_case(b'X'*len(b'original-image-bytes')),(0,1))

if __name__=='__main__':unittest.main()
