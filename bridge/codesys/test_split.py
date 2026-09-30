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
# text_of, the header finders (lead, decl_keyword), what an object is (is_method …), the unit splitting, set_text,
# and the import's plan / apply / snapshot / restore
exec(SOURCE[SOURCE.index("def text_of"):SOURCE.index("def kind_of")], ns)
exec(SOURCE[SOURCE.index("def ensure_nl"):SOURCE.index("def unit_text")], ns)
exec(SOURCE[SOURCE.index("# by object type, not by text"):SOURCE.index("def fingerprint")], ns)
exec(SOURCE[SOURCE.index("# [ \\t]*, not \\s*"):SOURCE.index("def folder")], ns)
exec(SOURCE[SOURCE.index("def plan_units"):SOURCE.index("# ------------------------------------------------------------------ build messages")], ns)

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

    def test_words_in_comments_and_code_are_not_headers_or_sections(self):
        text = "FUNCTION_BLOCK FB_Motor\nVAR\n    variance : REAL;\nEND_VAR\n(* notes:\nProgram flow is simple\nAction required: none *)\nvariance := 0.5;\nEND_FUNCTION_BLOCK\n\nMETHOD Start : BOOL // started\nStart := TRUE;\nEND_METHOD\n"
        units = ns["split_units"](text)
        self.assertEqual([k for k, _ in units], ["FUNCTION_BLOCK", "METHOD"])
        decl, impl = ns["split_decl_impl"](units[0][1])
        self.assertEqual(decl, "FUNCTION_BLOCK FB_Motor\nVAR\n    variance : REAL;\nEND_VAR\n")
        self.assertEqual(impl, "(* notes:\nProgram flow is simple\nAction required: none *)\nvariance := 0.5;\n")
        self.assertEqual(ns["return_type"](units[1][1]), "BOOL")
        self.assertEqual(ns["header_name"]("(* Program flow *)\nPROGRAM PLC_PRG\n"), "PLC_PRG")

    def test_the_header_keyword_past_comments_and_pragmas(self):
        kw = ns["lead_keyword"]
        self.assertEqual(kw("// the motor\nFUNCTION_BLOCK FB_Motor\n"), "FUNCTION_BLOCK")
        self.assertEqual(kw("(* a\n block *)\n{attribute 'qualified_only'}\n  VAR_GLOBAL\n"), "VAR_GLOBAL")
        self.assertEqual(kw("/* c */ TYPE ST_Axis :\n"), "TYPE")
        self.assertEqual(kw("// only a comment\n"), None)

    def test_a_file_is_checked_whole_before_anything_changes(self):
        plan = ns["plan_units"]
        units = lambda t: ns["split_units"](t)[1:]
        with self.assertRaises(RpcError) as e:
            plan("FB_Motor", units(FILE.replace("ACTION Reset:", "PROPERTY P : INT\nGET\nP := 1;\nEND_PROPERTY\n\nACTION Reset:")))
        self.assertIn("END_GET is missing", str(e.exception))
        with self.assertRaises(RpcError) as e:
            plan("FB_Motor", units(FILE + "\nFUNCTION_BLOCK FB_Other\nEND_FUNCTION_BLOCK\n"))
        self.assertIn("second POU", str(e.exception))
        with self.assertRaises(RpcError) as e:
            plan("FB_Motor", units(FILE + "\nMETHOD start : BOOL\nEND_METHOD\n"))
        self.assertIn("two members named start", str(e.exception))
        self.assertEqual([(k, n) for k, n, _ in plan("FB_Motor", units(FILE))], [("METHOD", "Start"), ("ACTION", "Reset")])

    def test_codesys_failing_half_way_puts_the_pou_back(self):
        pou = Obj("FB_Motor", "pou", "FUNCTION_BLOCK FB_Motor\nVAR\nEND_VAR\n", "x := 1;\n")
        old = pou.create_method("Old", "BOOL")
        old.textual_declaration.text = "METHOD Old : BOOL\n"
        old.textual_implementation.text = "Old := TRUE;\n"
        prop = pou.create_property("Speed", "REAL")
        prop.textual_declaration.text = "PROPERTY Speed : REAL\n"
        prop.children = [a for a in prop.children if a.name == "Get"]  # read-only
        before = dump(pou)
        snap = ns["snapshot"](pou)
        # the file: a new body, a new method, SET added to the property (it is made again), Old removed; CODESYS then
        # refuses the new method's code
        text = "FUNCTION_BLOCK FB_Motor\nVAR\nEND_VAR\nx := 2;\nEND_FUNCTION_BLOCK\n\nPROPERTY Speed : REAL\nGET\nSpeed := 1;\nEND_GET\nSET\nEND_SET\nEND_PROPERTY\n\nMETHOD New : INT\nBOOM\nEND_METHOD\n"
        parts = ns["split_units"](text)
        with self.assertRaises(Exception):
            ns["apply_units"](pou, parts[0][1], ns["plan_units"]("FB_Motor", parts[1:]))
        self.assertNotEqual(dump(pou), before)
        ns["restore"](pou, snap)
        self.assertEqual(dump(pou), before)


# a small stand-in for CODESYS' object model: what snapshot, apply_units and restore use
TYPES = {"method": "f8a58466-d7f6-439f-bbb8-d4600e41d099", "property": "5a3b8626-d3e9-4f37-98b5-66420063d91e", "accessor": "792f2eb6-721e-4e64-ba20-bc98351056db", "action": "action", "pou": "pou"}


class Doc:
    def __init__(self, text):
        self.text = text

    def replace(self, text):
        if "BOOM" in text:
            raise Exception("CODESYS refused the text")
        self.text = text


class Obj:
    def __init__(self, name, kind, decl=None, impl=None, parent=None):
        self.name, self.type, self.parent, self.children = name, TYPES[kind], parent, []
        self.has_textual_declaration = decl is not None
        self.has_textual_implementation = impl is not None
        self.textual_declaration = Doc(decl or "")
        self.textual_implementation = Doc(impl or "")

    def get_name(self):
        return self.name

    def get_children(self, recursive):
        return list(self.children)

    def remove(self):
        self.parent.children.remove(self)

    def _add(self, o):
        self.children.append(o)
        return o

    def create_method(self, name, rtype):
        return self._add(Obj(name, "method", "METHOD " + name + (" : " + rtype if rtype else "") + "\n", "", self))

    def create_property(self, name, rtype):
        p = self._add(Obj(name, "property", "PROPERTY " + name + " : " + str(rtype) + "\n", None, self))
        p.children = [Obj("Get", "accessor", "VAR\nEND_VAR\n", "", p), Obj("Set", "accessor", "VAR\nEND_VAR\n", "", p)]
        return p

    def create_action(self, name):
        return self._add(Obj(name, "action", None, "", self))


def dump(o):
    return (o.name, o.type, o.textual_declaration.text if o.has_textual_declaration else None, o.textual_implementation.text if o.has_textual_implementation else None, sorted(dump(c) for c in o.children))


if __name__ == "__main__":
    unittest.main()
