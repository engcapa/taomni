"""Wrapped links keep trusted pointer input and cannot bypass an overlay."""
import json
import subprocess
import unittest

from native_pointer import TARGET_GEOMETRY


class InlinePointerGeometryTests(unittest.TestCase):
    def observe(self, covered=False):
        script = r"""
const data = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const a = {left:100, top:160, right:380, bottom:173, width:280, height:13};
const b = {left:100, top:182, right:280, bottom:195, width:180, height:13};
const el = {isConnected:true, closest:()=>null, contains:hit=>hit===el,
  getBoundingClientRect:()=>({...a, bottom:195, height:35}),
  getClientRects:()=>[a,b]};
global.innerWidth=800; global.innerHeight=600;
global.document={elementFromPoint:(x,y)=>!data.covered && [a,b].some(r=>
  x>=r.left && x<r.right && y>=r.top && y<r.bottom) ? el : {}};
process.stdout.write(JSON.stringify(new Function(data.script)(el, false)));
"""
        result = subprocess.run(["node", "-e", script], input=json.dumps({
            "script": TARGET_GEOMETRY, "covered": covered,
        }), capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_click_uses_rendered_text_instead_of_the_gap_between_lines(self):
        point = self.observe()
        self.assertTrue(point["ready"])
        self.assertTrue(100 <= point["x"] < 380 and 160 <= point["y"] < 173)

    def test_covered_fragments_do_not_authorize_input(self):
        self.assertFalse(self.observe(covered=True)["ready"])


if __name__ == "__main__":
    unittest.main()
