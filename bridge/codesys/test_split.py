# SPDX-License-Identifier: BUSL-1.1
# The text functions of rung_bridge_codesys.py under CPython (the bridge itself runs in CODESYS' IronPython):
#   python bridge/codesys/test_split.py
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = open(os.path.join(HERE, "rung_bridge_codesys.py"), encoding="utf-8").read()
# END and the import helpers are plain Python; the rest needs CODESYS
class RpcError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code


ns = {"re": re, "RpcError": RpcError}
exec(re.search(r"^END = .*$", SOURCE, re.M).group(0), ns)
exec(SOURCE[SOURCE.index("# [ \\t]*, not \\s*"):SOURCE.index("def set_text")], ns)

FILE = """{attribute 'qualified_only'}
// the motor
FUNCTION_BLOCK FB_Motor
VAR_INPUT
    x : BOOL;
END_VAR
x := TRUE;
END_FUNCTION_BLOCK

{attribute 'monitoring' := 'call'}
METHOD Start : BOOL
VAR_INPUT
    a : INT;
END_VAR
Start := TRUE;
END_METHOD

ACTION Reset:
x := FALSE;
END_ACTION
"""


class SplitTests(unittest.TestCase):
    def test_what_stands_above_a_header_stays_with_its_declaration(self):
        units = ns["split_units"](FILE)
        self.assertEqual([k for k, _ in units], ["FUNCTION_BLOCK", "METHOD", "ACTION"])
        fb, method, action = [u for _, u in units]
        self.assertTrue(fb.startswith("{attribute 'qualified_only'}\n// the motor\nFUNCTION_BLOCK FB_Motor\n"))
        self.assertNotIn("END_FUNCTION_BLOCK", fb)
        self.assertNotIn("monitoring", fb)
        self.assertTrue(method.startswith("{attribute 'monitoring' := 'call'}\nMETHOD Start : BOOL\n"))
        self.assertTrue(action.startswith("ACTION Reset:\n"))
        self.assertEqual(ns["header_name"](fb), "FB_Motor")
        self.assertEqual(ns["header_name"](method), "Start")
        self.assertEqual(ns["return_type"](method), "BOOL")
        decl, impl = ns["split_decl_impl"](fb)
        self.assertEqual(decl, "{attribute 'qualified_only'}\n// the motor\nFUNCTION_BLOCK FB_Motor\nVAR_INPUT\n    x : BOOL;\nEND_VAR\n")
        self.assertEqual(impl, "x := TRUE;\n")
        mdecl, mimpl = ns["split_decl_impl"](method)
        self.assertTrue(mdecl.startswith("{attribute 'monitoring' := 'call'}\nMETHOD Start : BOOL\n"))
        self.assertEqual(mimpl, "Start := TRUE;\n")

    def test_a_property_with_its_accessors(self):
        text = FILE.replace("ACTION Reset:", """{attribute 'monitoring' := 'variable'}
PROPERTY PUBLIC Speed : REAL
GET
VAR
END_VAR
Speed := _speed;
END_GET
SET
_speed := Speed;
END_SET
END_PROPERTY

ACTION Reset:""")
        units = ns["split_units"](text)
        self.assertEqual([k for k, _ in units], ["FUNCTION_BLOCK", "METHOD", "PROPERTY", "ACTION"])
        prop = units[2][1]
        self.assertEqual(ns["header_name"](prop), "Speed")
        self.assertEqual(ns["return_type"](prop), "REAL")
        decl, accs = ns["split_property"](prop)
        self.assertEqual(decl, "{attribute 'monitoring' := 'variable'}\nPROPERTY PUBLIC Speed : REAL\n")
        self.assertEqual(accs, {"GET": ("VAR\nEND_VAR\n", "Speed := _speed;\n"), "SET": ("", "_speed := Speed;\n")})
        # read-only: GET only
        self.assertEqual(sorted(ns["split_property"]("PROPERTY P : INT\nGET\nP := 1;\nEND_GET\n")[1]), ["GET"])
        with self.assertRaises(RpcError):
            ns["split_property"]("PROPERTY P : INT\nGET\nP := 1;\n")

    def test_a_plain_file_is_unchanged(self):
        units = ns["split_units"]("PROGRAM PLC_PRG\nVAR\n    n : INT;\nEND_VAR\nn := n + 1;\nEND_PROGRAM\n")
        self.assertEqual(units, [("PROGRAM", "PROGRAM PLC_PRG\nVAR\n    n : INT;\nEND_VAR\nn := n + 1;\n")])


if __name__ == "__main__":
    unittest.main()
