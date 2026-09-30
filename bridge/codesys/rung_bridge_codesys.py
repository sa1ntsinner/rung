# -*- coding: utf-8 -*-
# SPDX-License-Identifier: BUSL-1.1
# rung bridge for CODESYS. Runs inside CODESYS (CODESYS.exe --noUI --runscript=...) and answers rung's JSON-RPC
# protocol, the one the TIA Portal bridge speaks, on a TCP port on localhost: one connection, one JSON request per
# line, one JSON reply per line. The first line must carry the token rung put into the environment.
#
# Mirror: POUs are blocks, DUTs are types, GVLs are tag tables (their global variables), each one .st file:
#   plc/<Device>/blocks/<folders>/<POU>.st   the POU's declaration and code, then its METHODs and ACTIONs
# Written for IronPython 2.7 (CODESYS scripting): no f-strings, no type hints.
from __future__ import print_function
import os, sys, re, json, hashlib, traceback, time

import clr
from System.Net import IPAddress
from System.Net.Sockets import TcpListener
from System.IO import StreamReader, StreamWriter
from System.Text import UTF8Encoding

PORT = int(os.environ.get("RUNG_CODESYS_PORT", "0"))
PROJECT = os.environ.get("RUNG_CODESYS_PROJECT", "")
TOKEN = os.environ.get("RUNG_CODESYS_TOKEN", "")
PROTOCOL = 1
VERSION = "0.1.0"

KIND_DIR = {"block": "blocks", "type": "types", "tagtable": "tags"}
DIR_KIND = dict((v, k) for k, v in KIND_DIR.items())
POU_KEYWORDS = {"PROGRAM": "PRG", "FUNCTION_BLOCK": "FB", "FUNCTION": "FC", "INTERFACE": "INTERFACE"}
END = {"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION", "METHOD": "END_METHOD", "PROPERTY": "END_PROPERTY", "ACTION": "END_ACTION", "INTERFACE": "END_INTERFACE"}
SKIP = set(["Library Manager", "Task Configuration", "Symbol Configuration", "Project Settings", "__VisualizationStyle"])


class RpcError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------ escaping (docs/format: rung workspace format 1)

ILLEGAL = set('/\\:*?"<>|%~')
RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", re.I)


def escape(raw):
    out = []
    for ch in raw:
        o = ord(ch)
        if ch in ILLEGAL or o < 0x20 or o == 0x7F:
            out.append("%%%02X" % o)
        else:
            out.append(ch)
    s = "".join(out)
    m = re.search(r"[. ]+$", s)
    if m:
        s = s[: m.start()] + "".join("%%%02X" % ord(c) for c in m.group(0))
    if RESERVED.match(raw):
        s = "%%%02X" % ord(s[0]) + s[1:]
    return s


def unescape(seg):
    return re.sub(r"%([0-9A-F]{2})", lambda m: chr(int(m.group(1), 16)), seg)


def address(device, kind, groups, name):
    return "plc:" + "/".join([escape(device), KIND_DIR[kind]] + [escape(g) for g in groups] + [escape(name)])


def parse_address(addr):
    if not addr.startswith("plc:"):
        raise RpcError("BAD_REQUEST", "not an address: " + addr)
    parts = addr[4:].split("/")
    if len(parts) < 3 or parts[1] not in DIR_KIND:
        raise RpcError("BAD_REQUEST", "not an address rung mirrors for CODESYS: " + addr)
    return unescape(parts[0]), DIR_KIND[parts[1]], [unescape(p) for p in parts[2:-1]], unescape(parts[-1])


# ------------------------------------------------------------------ the project

state = {"project": None}


def project():
    p = state["project"]
    if p is None:
        if not PROJECT or not os.path.exists(PROJECT):
            raise RpcError("NO_PROJECT", "CODESYS project not found: " + PROJECT)
        try:
            p = projects.open(PROJECT, primary=True)
        except Exception as e:
            if "in use" in str(e).lower():
                raise RpcError("PROJECT_IN_USE", "the project is open in another CODESYS (rung watch, or CODESYS itself). While rung watch runs, rung's commands go through it; otherwise close the other CODESYS. (" + str(e).strip() + ")")
            raise
        state["project"] = p
    return p


def devices():
    return [c for c in project().get_children(False) if getattr(c, "is_device", False)]


def device(name):
    for d in devices():
        if d.get_name() == name:
            return d
    raise RpcError("NOT_FOUND", "no device named " + name)


def application(dev):
    """The application under the device's PLC logic (the first one; CODESYS projects normally have one)."""
    for c in dev.get_children(True):
        if getattr(c, "is_application", False):
            return c
    raise RpcError("NOT_FOUND", "device " + dev.get_name() + " has no application")


def text_of(doc):
    return (doc.text or "").replace("\r\n", "\n")


def lead(text):
    """Where a declaration's first keyword starts, past what may stand above it: comments (//, (* *), /* */) and
    attribute pragmas ({ }). Export, import and the checks all find the header this one way."""
    i, n = 0, len(text)
    while i < n:
        if text[i].isspace():
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j + 1
        elif text.startswith("(*", i) or text.startswith("/*", i):
            j = text.find("*)" if text[i] == "(" else "*/", i + 2)
            i = n if j < 0 else j + 2
        elif text[i] == "{":
            j = text.find("}", i)
            i = n if j < 0 else j + 1
        else:
            break
    return i


def lead_keyword(text):
    m = re.match(r"[A-Za-z_]+", text[lead(text):])
    return m.group(0).upper() if m else None


def decl_keyword(obj):
    if not getattr(obj, "has_textual_declaration", False):
        return None
    return lead_keyword(text_of(obj.textual_declaration))


def kind_of(obj):
    kw = decl_keyword(obj)
    if kw in POU_KEYWORDS:
        return "block"
    if kw == "TYPE":
        return "type"
    if kw == "VAR_GLOBAL":
        return "tagtable"
    return None


def walk(parent, groups, out):
    for c in parent.get_children(False):
        name = c.get_name()
        if name in SKIP:
            continue
        if c.is_folder:
            walk(c, groups + [name], out)
            continue
        k = kind_of(c)
        if k:
            out.append((c, k, groups))


def ensure_nl(s):
    return s if s.endswith("\n") or s == "" else s + "\n"


def unit_text(obj, kw):
    """One POU, method or action as text: declaration, code, END keyword."""
    decl = ensure_nl(text_of(obj.textual_declaration)) if getattr(obj, "has_textual_declaration", False) else ""
    impl = ensure_nl(text_of(obj.textual_implementation)) if getattr(obj, "has_textual_implementation", False) else ""
    if kw == "ACTION":
        return "ACTION " + obj.get_name() + ":\n" + impl + "END_ACTION\n"
    return decl + impl + END[kw] + "\n"


def property_text(prop):
    """A PROPERTY with its accessors: the declaration, then GET … END_GET and SET … END_SET, then END_PROPERTY."""
    out = ensure_nl(text_of(prop.textual_declaration))
    accessors = dict((c.get_name().upper(), c) for c in prop.get_children(False) if str(c.type).lower() == ACCESSOR_TYPE)
    for name in ("GET", "SET"):
        acc = accessors.get(name)
        if acc is not None:
            out += name + "\n" + ensure_nl(text_of(acc.textual_declaration)) + ensure_nl(text_of(acc.textual_implementation)) + "END_" + name + "\n"
    return out + "END_PROPERTY\n"


def export_text(obj, kind):
    if kind != "block":
        return ensure_nl(text_of(obj.textual_declaration))
    kw = decl_keyword(obj)
    parts = [unit_text(obj, kw)]
    for c in obj.get_children(False):
        if is_method(c):
            parts.append(unit_text(c, "METHOD"))
        elif is_property(c):
            parts.append(property_text(c))
        elif is_action(c):
            parts.append(unit_text(c, "ACTION"))
    return "\n".join(parts)


# by object type, not by text: a method whose declaration is broken is still a method
METHOD_TYPE = "f8a58466-d7f6-439f-bbb8-d4600e41d099"
PROPERTY_TYPE = "5a3b8626-d3e9-4f37-98b5-66420063d91e"
ACCESSOR_TYPE = "792f2eb6-721e-4e64-ba20-bc98351056db"  # a property's Get or Set


def is_method(c):
    return str(c.type).lower() == METHOD_TYPE or decl_keyword(c) == "METHOD"


def is_property(c):
    return str(c.type).lower() == PROPERTY_TYPE


def is_action(c):
    return not is_method(c) and not is_property(c) and not getattr(c, "has_textual_declaration", False) and getattr(c, "has_textual_implementation", False)


def fingerprint(text):
    return "fp:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def entries(devname):
    dev = device(devname)
    out = []
    walk(application(dev), [], out)
    res = []
    for obj, kind, groups in out:
        text = export_text(obj, kind)
        kw = decl_keyword(obj)
        res.append({
            "address": address(devname, kind, groups, obj.get_name()),
            "kind": kind,
            "language": "ST",
            "blockType": POU_KEYWORDS.get(kw) if kind == "block" else None,
            "knowHowProtected": False,
            "isFailsafe": False,
            "isSystem": False,
            "fingerprint": fingerprint(text),
        })
    return res


def find(addr):
    devname, kind, groups, name = parse_address(addr)
    out = []
    walk(application(device(devname)), [], out)
    for obj, k, g in out:
        if k == kind and g == groups and obj.get_name() == name:
            return obj, kind
    raise RpcError("NOT_FOUND", "no object at " + addr)


# ------------------------------------------------------------------ import: a file back into CODESYS objects

# [ \t]*, not \s*: \s* would start a unit at the blank line before its header
HEADER = re.compile(r"^[ \t]*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|ACTION|INTERFACE)\b", re.I | re.M)


COMMENT = re.compile(r"//[^\n]*|\(\*[\s\S]*?\*\)|/\*[\s\S]*?\*/|'(?:\$.|[^'$\n])*'|\"(?:\$.|[^\"$\n])*\"")


def masked(text):
    """The text with comments and string literals blanked (newlines kept): offsets stay, and a word in a comment,
    such as 'Program flow' on a line of its own, is not taken for a header."""
    return COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def split_units(text):
    """Top-level units of a POU file: [(keyword, text without its END line)]. What stands above a header
    (attribute pragmas, comments) belongs to that unit's declaration, as CODESYS keeps it there."""
    text = text.replace("\r\n", "\n")
    code = masked(text)
    starts = [m for m in HEADER.finditer(code)]
    units = []
    after = 0  # where the previous unit's END line ended
    for i, m in enumerate(starts):
        nxt = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        kw = m.group(1).upper()
        ends = list(re.finditer(r"^[ \t]*" + END[kw] + r"\b[^\n]*(\n|$)", code[m.start():nxt], re.I | re.M))
        stop = m.start() + ends[-1].start() if ends else nxt
        # blank lines between units are layout, not part of a declaration
        body = re.sub(r"^(?:[ \t]*\n)+", "", text[after:stop])
        units.append((kw, body.rstrip() + "\n"))
        after = m.start() + ends[-1].end() if ends else nxt
    return units


# VAR, VAR_INPUT, VAR RETAIN …: not a word that starts with var (variance := 0.5;)
VAR_START = re.compile(r"^\s*VAR(_[A-Za-z_]+)?\b", re.I)
END_VAR_LINE = re.compile(r"^\s*END_VAR\b", re.I)


def header_line(lines):
    """Index of the header line: pragmas and comments may stand above it (lines of masked text)."""
    for k, line in enumerate(lines):
        if HEADER.match(line):
            return k
    return 0


def split_decl_impl(unit):
    """Declaration = what stands above the header, the header and its VAR sections; the code is what follows."""
    lines = unit.split("\n")
    code = masked(unit).split("\n")  # a comment starts neither a section nor the code
    i = header_line(code) + 1
    while i < len(lines) and re.match(r"^\s*\{", code[i]):
        i += 1  # attribute pragmas under the header
    while i < len(lines):
        s = code[i].strip()
        if VAR_START.match(s):
            while i < len(lines) and not END_VAR_LINE.match(code[i]):
                i += 1
            i += 1
            continue
        if s == "":
            # blank lines and comments: part of the declaration when another VAR section follows them
            # ("// inputs" above VAR_INPUT), else a comment is where the code starts
            j = next_code_line(code, i)
            if j < len(lines) and VAR_START.match(code[j].strip()):
                i = j
                continue
            if lines[i].strip() == "":
                i += 1
                continue
        break
    decl = "\n".join(lines[:i]).rstrip() + "\n"
    impl = "\n".join(lines[i:]).strip("\n")
    return decl, (impl + "\n") if impl else ""


def next_code_line(code, i):
    """The first line from i on whose masked text is not blank (neither empty nor only a comment)."""
    while i < len(code) and code[i].strip() == "":
        i += 1
    return i


ACCESSOR = re.compile(r"^[ \t]*(GET|SET)[ \t]*$", re.I | re.M)


def accessor_decl_impl(body):
    """An accessor's VAR sections, then its code."""
    lines = body.split("\n")
    code = masked(body).split("\n")
    i = 0
    while i < len(lines):
        s = code[i].strip()
        if VAR_START.match(s):
            while i < len(lines) and not END_VAR_LINE.match(code[i]):
                i += 1
            i += 1
            continue
        if s == "":
            j = next_code_line(code, i)
            if j < len(lines) and VAR_START.match(code[j].strip()):
                i = j  # comments and blank lines above another VAR section belong to the declaration
                continue
        break
    decl = "\n".join(lines[:i]).strip("\n")
    impl = "\n".join(lines[i:]).strip("\n")
    return (decl + "\n") if decl else "", (impl + "\n") if impl else ""


def split_property(unit):
    """A PROPERTY unit (without END_PROPERTY): its declaration, and {"GET": (decl, impl), "SET": (decl, impl)}."""
    first = ACCESSOR.search(masked(unit))
    decl = (unit[:first.start()] if first else unit).rstrip() + "\n"
    accessors = {}
    rest = unit[first.start():] if first else ""
    while rest.strip():
        rest = re.sub(r"^(?:[ \t]*\n)+", "", rest)
        m = ACCESSOR.match(masked(rest))
        if not m:
            raise RpcError("IMPORT_FAILED", "a PROPERTY holds GET … END_GET and SET … END_SET; found: " + rest.strip().split("\n")[0])
        name = m.group(1).upper()
        end = re.search(r"^[ \t]*END_" + name + r"\b[^\n]*(\n|$)", rest, re.I | re.M)
        if not end:
            raise RpcError("IMPORT_FAILED", "END_" + name + " is missing in the PROPERTY")
        if name in accessors:
            raise RpcError("IMPORT_FAILED", "the PROPERTY has two " + name + " sections")
        accessors[name] = accessor_decl_impl(rest[m.end():end.start()])
        rest = rest[end.end():]
    return decl, accessors


def header_name(unit):
    unit = masked(unit)  # a comment line such as "Program flow" is no header
    m = re.search(r"^[ \t]*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|ACTION|INTERFACE)\s+(?:(?:ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+)*([A-Za-z_][A-Za-z0-9_]*)", unit, re.I | re.M)
    return m.group(1) if m else None


def return_type(unit):
    unit = masked(unit)  # METHOD Start : BOOL // started: the comment is not the type
    m = re.search(r"^[ \t]*(?:METHOD|FUNCTION|PROPERTY)\s+(?:(?:ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+)*[A-Za-z_][A-Za-z0-9_]*\s*:\s*([^\n;]+)", unit, re.I | re.M)
    return m.group(1).strip() if m else None


def set_text(doc, text):
    if text_of(doc) != text:
        doc.replace(text)


def folder(parent, groups):
    for g in groups:
        find_it = lambda: [c for c in parent.get_children(False) if c.is_folder and c.get_name() == g]
        hit = find_it()
        if not hit:
            parent.create_folder(g)  # returns nothing: look it up
            hit = find_it()
        parent = hit[0]
    return parent


def import_object(addr, path, expected):
    devname, kind, groups, name = parse_address(addr)
    with open(path, "rb") as fh:
        text = fh.read().decode("utf-8-sig").replace("\r\n", "\n")
    try:
        obj, _ = find(addr)
    except RpcError:
        obj = None
    if expected == "absent" and obj is not None:
        raise RpcError("STALE_REVISION", addr + " already exists in CODESYS")
    if expected != "absent":
        if obj is None:
            raise RpcError("NOT_FOUND", "no object at " + addr)
        if fingerprint(export_text(obj, kind)) != expected:
            raise RpcError("STALE_REVISION", addr + " changed in CODESYS since it was exported")
    app = application(device(devname))
    if kind != "block":
        at = lead(text)
        m = re.match(r"TYPE\s+([A-Za-z_][A-Za-z0-9_]*)", text[at:], re.I) if kind == "type" else None
        if kind == "type" and (not m or m.group(1) != name):
            raise RpcError("IMPORT_FAILED", "the file declares " + (m.group(1) if m else "no type") + " but its name says " + name)
        if kind == "tagtable" and lead_keyword(text) != "VAR_GLOBAL":
            raise RpcError("IMPORT_FAILED", "a global variable list starts with VAR_GLOBAL")
        created = obj is None
        if created:
            parent = folder(app, groups)
            obj = parent.create_dut(name) if kind == "type" else parent.create_gvl(name)
        try:
            set_text(obj.textual_declaration, ensure_nl(text))
        except Exception:
            if created:
                obj.remove()
            raise
        return obj, kind
    units = split_units(text)
    if not units or units[0][0] not in POU_KEYWORDS:
        raise RpcError("IMPORT_FAILED", "the file declares no PROGRAM, FUNCTION_BLOCK or FUNCTION")
    kw, main = units[0]
    if header_name(main) != name:
        raise RpcError("IMPORT_FAILED", "the file declares " + str(header_name(main)) + " but its name says " + name)
    if obj is not None and decl_keyword(obj) != kw:
        raise RpcError("IMPORT_FAILED", name + " is a " + str(decl_keyword(obj)) + " in CODESYS; changing it to a " + kw + " is done in CODESYS")
    pou_type = {"PROGRAM": PouType.Program, "FUNCTION_BLOCK": PouType.FunctionBlock, "FUNCTION": PouType.Function}.get(kw)
    if obj is None and pou_type is None:
        raise RpcError("IMPORT_FAILED", "rung creates PROGRAMs, FUNCTION_BLOCKs and FUNCTIONs; create an " + kw + " in CODESYS")
    # the whole file is read and checked before CODESYS is touched: a mistake in the last unit changes nothing
    plan = plan_units(name, units[1:])
    snap = snapshot(obj) if obj is not None else None
    created = obj is None
    try:
        if created:
            # all keywords: create_pou has two C# overloads (see its stub)
            obj = folder(app, groups).create_pou(name=name, type=pou_type, language=None, return_type=return_type(main) if kw == "FUNCTION" else None, base_type=None, interfaces=None)
        apply_units(obj, main, plan)
    except Exception as e:
        # CODESYS refused something half-way: the POU goes back to what it was, so a later save keeps no half import
        why = e.message if isinstance(e, RpcError) else str(e)
        try:
            if created and obj is not None:
                obj.remove()
            elif snap is not None:
                restore(obj, snap)
        except Exception as e2:
            raise RpcError("IMPORT_FAILED", why + "; CODESYS kept part of the file and rung could not put the previous version back (" + str(e2) + "): check " + name + " in CODESYS")
        raise RpcError(e.code if isinstance(e, RpcError) else "IMPORT_FAILED", why + "; nothing was changed")
    return obj, kind


def plan_units(owner, units):
    """The METHODs, PROPERTYs and ACTIONs of a POU file, each split and checked: [(keyword, name, parts)]."""
    plan = []
    for ukw, unit in units:
        uname = header_name(unit)
        if ukw not in ("METHOD", "PROPERTY", "ACTION"):
            raise RpcError("IMPORT_FAILED", "a file holds one POU with its METHODs, PROPERTYs and ACTIONs; " + ukw + " " + str(uname) + " is a second POU: give it a file of its own")
        if not uname:
            raise RpcError("IMPORT_FAILED", "a " + ukw + " in " + owner + " has no name")
        if uname.upper() in [p[1].upper() for p in plan]:
            raise RpcError("IMPORT_FAILED", owner + " has two members named " + uname)
        if ukw == "METHOD":
            plan.append((ukw, uname, split_decl_impl(unit) + (return_type(unit),)))
        elif ukw == "PROPERTY":
            decl, accs = split_property(unit)
            plan.append((ukw, uname, (decl, accs, return_type(unit))))
        else:
            head = re.search(r"^[ \t]*ACTION\s+[A-Za-z_][A-Za-z0-9_]*\s*:?[ \t]*\n?", unit, re.I | re.M)
            # an action has no declaration: a comment above it would have nowhere to go in CODESYS
            if unit[:head.start()].strip():
                raise RpcError("IMPORT_FAILED", "the text above ACTION " + uname + " has no place in CODESYS (an action has no declaration); put it inside the action")
            plan.append((ukw, uname, ensure_nl(unit[head.end():].strip("\n"))))
    return plan


def apply_units(obj, main, plan):
    decl, impl = split_decl_impl(main)
    set_text(obj.textual_declaration, decl)
    if getattr(obj, "has_textual_implementation", False):
        set_text(obj.textual_implementation, impl)
    # methods, properties and actions: the file is the list; what it no longer has is removed (last)
    for ukw, uname, parts in plan:
        child = [c for c in obj.get_children(False) if c.get_name() == uname]
        if ukw == "METHOD":
            d, i, rtype = parts
            child = child[0] if child else obj.create_method(uname, rtype)
            set_text(child.textual_declaration, d)
            set_text(child.textual_implementation, i)
        elif ukw == "PROPERTY":
            pdecl, accs, rtype = parts
            child = [c for c in child if is_property(c)]
            child = child[0] if child else None
            if child is not None and not set(accs) <= set(a.get_name().upper() for a in child.get_children(False)):
                # CODESYS adds no accessor to an existing property: it is made again, with the file's texts
                child.remove()
                child = None
            if child is None:
                child = obj.create_property(uname, rtype)  # with a Get and a Set
            set_text(child.textual_declaration, pdecl)
            for a in child.get_children(False):
                aname = a.get_name().upper()
                if aname not in accs:
                    a.remove()  # a property without SET is read-only
                    continue
                d, i = accs[aname]
                set_text(a.textual_declaration, d)
                set_text(a.textual_implementation, i)
        else:
            child = child[0] if child else obj.create_action(uname)
            set_text(child.textual_implementation, parts)
    wanted = [p[1] for p in plan]
    for c in obj.get_children(False):
        if (is_method(c) or is_property(c) or is_action(c)) and c.get_name() not in wanted:
            c.remove()


def texts(o):
    return (text_of(o.textual_declaration) if getattr(o, "has_textual_declaration", False) else None,
            text_of(o.textual_implementation) if getattr(o, "has_textual_implementation", False) else None)


def put_texts(o, t):
    if t[0] is not None:
        set_text(o.textual_declaration, t[0])
    if t[1] is not None and getattr(o, "has_textual_implementation", False):
        set_text(o.textual_implementation, t[1])


def snapshot(obj):
    """What an import of a POU may change: its texts and those of its methods, properties (with accessors) and actions."""
    kids = []
    for c in obj.get_children(False):
        if is_method(c):
            kids.append(("METHOD", c.get_name(), texts(c), None))
        elif is_property(c):
            kids.append(("PROPERTY", c.get_name(), texts(c), dict((a.get_name().upper(), texts(a)) for a in c.get_children(False) if str(a.type).lower() == ACCESSOR_TYPE)))
        elif is_action(c):
            kids.append(("ACTION", c.get_name(), texts(c), None))
    return texts(obj), kids


def restore(obj, snap):
    """Puts a POU back as snapshot() saw it: texts, members made by the failed import removed, removed ones made again."""
    main, kids = snap
    put_texts(obj, main)
    names = [k[1] for k in kids]
    for c in obj.get_children(False):
        if (is_method(c) or is_property(c) or is_action(c)) and c.get_name() not in names:
            c.remove()
    for kind, name, t, accs in kids:
        hit = [c for c in obj.get_children(False) if c.get_name() == name]
        c = hit[0] if hit else None
        if c is not None and kind == "PROPERTY" and not set(accs) <= set(a.get_name().upper() for a in c.get_children(False)):
            # the failed import took an accessor away (SET of a read-only property); CODESYS adds none back: made again
            c.remove()
            c = None
        if c is None:
            if kind == "METHOD":
                c = obj.create_method(name, return_type(t[0] or ""))
            elif kind == "PROPERTY":
                c = obj.create_property(name, return_type(t[0] or ""))
            else:
                c = obj.create_action(name)
        put_texts(c, t)
        if kind == "PROPERTY":
            for a in c.get_children(False):
                an = a.get_name().upper()
                if an not in accs:
                    a.remove()
                else:
                    put_texts(a, accs[an])


# ------------------------------------------------------------------ build messages

POS = re.compile(r"Line\s+(\d+)(?:,\s*Column\s+(\d+))?(?:\s*\((Decl|Impl)\))?", re.I)


def build_categories():
    """The message categories of a build (Build, code checks): script output and others stay out."""
    out = []
    for cat in system.get_message_categories():
        try:
            d = str(system.get_message_category_description(cat) or "")
        except Exception:
            d = ""
        if re.search(r"build|code check|compile", d, re.I):
            out.append(cat)
    return out


def compile_messages(devname):
    app = application(device(devname))
    cats = build_categories()
    for cat in cats:
        system.clear_messages(cat)
    app.build()
    byguid = {}
    out = []
    walk(app, [], out)
    for obj, kind, groups in out:
        byguid[str(obj.guid)] = (obj, kind, groups)
        for c in obj.get_children(False):
            byguid[str(c.guid)] = (c, kind, groups, obj)
    res = []
    for cat in cats or system.get_message_categories():
        for m in system.get_message_objects(cat):
            sev = str(m.severity).lower()
            severity = "error" if "error" in sev else "warning" if "warn" in sev else "info"
            # progress lines say nothing; the summary stays ("Compile complete -- 0 errors, 0 warnings")
            if severity == "info" and not re.search(r"complete --", str(m.text)):
                continue
            item = {"severity": severity, "description": m.text}
            try:
                o = m.object
                hit = byguid.get(str(o.guid)) if o is not None else None
            except Exception:
                hit = None
            if hit:
                owner = hit[3] if len(hit) > 3 else hit[0]
                item["address"] = address(devname, hit[1], hit[2], owner.get_name())
                pos = POS.search(str(getattr(m, "position_text", "") or ""))
                if pos:
                    line = int(pos.group(1))
                    # the file puts the code right after the declaration (split_decl_impl), so a code line is
                    # counted from there; a method's lines from where the method starts in the file
                    obj = hit[0]
                    text = export_text(owner, hit[1])
                    start = 0
                    if obj is not owner:
                        head = re.search(r"^\s*(METHOD|ACTION)\s+(?:\w+\s+)*" + re.escape(obj.get_name()) + r"\b", text, re.I | re.M)
                        start = text[: head.start()].count("\n") if head else 0
                    decl_lines = text_of(obj.textual_declaration).rstrip("\n").count("\n") + 1 if getattr(obj, "has_textual_declaration", False) else 1
                    item["line"] = start + (line if (pos.group(3) or "Decl").lower() == "decl" else decl_lines + line)
                    if pos.group(2):
                        item["column"] = int(pos.group(2))
            res.append(item)
    return res


# ------------------------------------------------------------------ online

online_apps = {}


def online_app(devname, simulation):
    dev = device(devname)
    if simulation is not None:
        dev.set_simulation_mode(bool(simulation))
    key = devname
    oa = online_apps.get(key)
    if oa is None:
        oa = online.create_online_application(application(dev))
        online_apps[key] = oa
    return oa


LITERAL = re.compile(r"^(?:[A-Z_]+#)?(.*)$", re.S)


def value_of(text):
    """CODESYS answers typed literals (DINT#76, TRUE, REAL#1.5, 'text'): plain JSON values."""
    if text is None:
        return None
    s = str(text)
    if s in ("TRUE", "FALSE"):
        return s == "TRUE"
    m = LITERAL.match(s)
    v = m.group(1) if m else s
    if re.match(r"^-?\d+$", v):
        return int(v)
    if re.match(r"^-?\d+\.\d*(E[+-]?\d+)?$", v, re.I):
        return float(v)
    if v.startswith("'") and v.endswith("'"):
        return v[1:-1]
    return s


def connect_to(devname, target):
    """[plc.<device>] of rung.toml: mode "simulation" is CODESYS's own simulation; otherwise pc_interface is the
    IP address of the PLC (the local CODESYS Control Win: 127.0.0.1), reached through the first gateway."""
    dev = device(devname)
    mode = str((target or {}).get("mode", "")).lower()
    if mode == "simulation":
        dev.set_simulation_mode(True)
    elif target and target.get("pcInterface"):
        dev.set_simulation_mode(False)
        gws = list(online.gateways)
        if not gws:
            raise RpcError("NO_TARGET", "CODESYS has no gateway configured")
        dev.set_gateway_and_ip_address(gws[0], str(target["pcInterface"]))


def plc_online(params):
    devname = params["device"]
    action = params.get("action", "state")
    if action == "online":
        connect_to(devname, params.get("target"))
    oa = online_app(devname, None)
    if action == "online" and not oa.is_logged_in:
        oa.login(OnlineChangeOption.Keep, False)  # log in only: never download on "go online"
    elif action == "offline" and oa.is_logged_in:
        oa.logout()
    return {"device": devname, "state": "Online" if oa.is_logged_in else "Offline"}


def plc_download(params):
    """Online change by default. A full download stops the application, like TIA's "stop the CPU": only with
    allow stop-cpu (the person named it); otherwise nothing is changed and rung says what to allow."""
    devname = params["device"]
    if os.environ.get("RUNG_CODESYS_ALLOW_DOWNLOAD") != "1":
        raise RpcError("DOWNLOAD_DISABLED", "This bridge was not started for downloads: only rung download starts one that may download. Nothing was downloaded.")
    allow = set(params.get("allow") or [])
    connect_to(devname, params.get("target"))
    oa = online_app(devname, None)
    full_ok = "stop-cpu" in allow
    base = {"device": devname, "errors": 0, "warnings": 0, "messages": [], "decisions": [], "needsAllow": []}
    # the application's state before: afterwards rung starts it only if it ran (and this download stopped it) or
    # did not exist yet (a first download); one that was stopped stays stopped, and so does one whose state rung
    # could not read (it may have been stopped on purpose)
    before = "unknown"
    try:
        if not oa.is_logged_in:
            oa.login(OnlineChangeOption.Keep, False)  # Keep: logs in, downloads nothing
        state = str(oa.application_state).lower()
        # ApplicationState.none: nothing loaded yet
        before = "run" if "run" in state else "none" if "none" in state else "stop"
        oa.logout()
    except Exception:
        before = "unknown"
    try:
        oa.login(OnlineChangeOption.Try if full_ok else OnlineChangeOption.Force, "reset-module" in allow)
    except Exception as e:
        msg = str(e)
        if not full_ok:
            base["decisions"].append({"phase": "pre", "kind": "FullDownload", "name": "stop-cpu", "message": "an online change is not possible; a full download stops the application", "choice": "cancel", "allowed": False, "blocks": True})
            base.update({"state": "Cancelled", "needsAllow": ["stop-cpu"], "messages": ["An online change is not possible (" + msg.strip().splitlines()[0] + "). A full download stops the application: allow stop-cpu to do it."]})
            return base
        base.update({"state": "Error", "errors": 1, "messages": [msg]})
        return base
    if full_ok:
        base["decisions"].append({"phase": "pre", "kind": "FullDownload", "name": "stop-cpu", "message": "online change where possible, else a full download", "choice": "allowed", "allowed": True, "blocks": False})
    else:
        base["decisions"].append({"phase": "pre", "kind": "OnlineChange", "name": "online-change", "message": "the running application changed without a stop", "choice": "online change", "allowed": True, "blocks": False})
    running = "run" in str(oa.application_state).lower()
    # CODESYS's simulation loads its boot application stopped; there is no machine to keep still, so it runs
    simulated = str((params.get("target") or {}).get("mode", "")).lower() == "simulation"
    if params.get("startAfter", True) and (before in ("run", "none") or simulated) and not running:
        oa.start()  # stopped by this download, loaded for the first time, or the simulation
    elif not running:
        why = {"stop": "; it was stopped before the download, so rung leaves it",
               "unknown": "; rung could not read its state before the download, so it does not start it: start it in CODESYS if it should run"}
        base["messages"].append("the application is stopped" + why.get(before, ""))
    base.update({"state": "Success", "messages": base["messages"] + ["application " + str(oa.application_state)]})
    return base


def describe(params):
    """Read-only views (rung views). CODESYS: its library managers, with each library or placeholder and its version."""
    scope = params.get("scope")
    pr = project()
    root = {"type": "Project", "name": os.path.splitext(os.path.basename(pr.path))[0], "attributes": {}, "children": {}}
    if scope != "libraries":
        return root  # hardware, HMI and technology objects are TIA Portal's
    managers = []

    def attr(o, name):
        try:
            v = getattr(o, name)
            return None if v is None else str(v)
        except Exception:
            return None

    for c in pr.get_children(True):
        if not getattr(c, "is_libman", False):
            continue
        refs = []
        for r in c.references:
            a = {}
            for key, name in (("namespace", "namespace"), ("systemLibrary", "system_library"), ("qualifiedOnly", "qualified_only"), ("optional", "optional")):
                v = attr(r, name)
                if v is not None:
                    a[key] = v
            if getattr(r, "is_placeholder", False):
                for key, name in (("defaultResolution", "default_resolution"), ("effectiveResolution", "effective_resolution")):
                    v = attr(r, name)
                    if v is not None:
                        a[key] = v
                refs.append({"type": "Placeholder", "name": attr(r, "placeholder_name") or attr(r, "name"), "attributes": a, "children": {}})
                continue
            lib = getattr(r, "managed_library", None) if getattr(r, "is_managed", False) else None
            if lib is not None:
                for key in ("title", "company", "version", "displayname"):
                    v = attr(lib, key)
                    if v is not None:
                        a[key] = v
            refs.append({"type": "Library", "name": attr(r, "name"), "attributes": a, "children": {}})
        parent = c.parent.get_name() if getattr(c, "parent", None) is not None else "Project"
        managers.append({"type": "LibraryManager", "name": parent, "attributes": {}, "children": {"References": sorted(refs, key=lambda x: (x["type"], x["name"] or ""))}})
    root["children"]["LibraryManagers"] = managers
    return root


def plc_read(params):
    oa = online_app(params["device"], None)
    if not oa.is_logged_in:
        raise RpcError("NOT_ONLINE", params["device"] + " is not online; rung online first")
    names = list(params["expressions"])
    values = oa.read_values(names)
    return [{"name": n, "value": value_of(v)} for n, v in zip(names, values)]


# ------------------------------------------------------------------ dispatch

def handle(method, p):
    if method == "bridge.hello":
        return {"protocol": PROTOCOL, "tiaVersion": "CODESYS", "bridgeVersion": VERSION, "capabilities": ["import", "compile", "online", "download", "read"]}
    if method == "project.info":
        pr = project()
        return {"name": os.path.splitext(os.path.basename(pr.path))[0], "path": pr.path, "tiaVersion": "CODESYS", "devices": [d.get_name() for d in devices()], "isLocalSession": True}
    if method == "objects.list":
        return entries(p["device"])
    if method == "objects.export":
        obj, kind = find(p["address"])
        text = export_text(obj, kind)
        if not os.path.isdir(p["dir"]):
            os.makedirs(p["dir"])
        f = os.path.join(p["dir"], "obj.st")
        with open(f, "wb") as fh:  # closed at once: IronPython flushes an unclosed file only when it is collected
            fh.write(text.encode("utf-8"))
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return {"address": p["address"], "form": "st", "files": [{"path": f, "role": "primary", "sha256": sha}], "warnings": [], "fingerprint": fingerprint(text), "bundleHash": sha}
    if method == "objects.import":
        if p.get("form") != "st":
            raise RpcError("UNSUPPORTED_OBJECT", "CODESYS objects are mirrored as .st files")
        obj, kind = import_object(p["address"], p["path"], p["expectedTiaRevision"])
        project().save()
        return handle("objects.export", {"address": p["address"], "dir": os.path.join(os.environ.get("TEMP", "."), "rung-cds-out", p["operationId"])})
    if method == "objects.delete":
        obj, kind = find(p["address"])
        if fingerprint(export_text(obj, kind)) != p["expectedTiaRevision"]:
            raise RpcError("STALE_REVISION", p["address"] + " changed in CODESYS; delete not confirmed")
        obj.remove()
        project().save()
        return {"deleted": True}
    if method == "plc.compile":
        return compile_messages(p["device"])
    if method == "plc.online":
        return plc_online(p)
    if method == "plc.download":
        return plc_download(p.get("request", p))
    if method == "model.describe":
        return describe(p)
    if method == "plc.read":
        return plc_read(p)
    if method == "debug.texts":
        obj, kind = find(p["address"])
        rows = []
        for o in [obj] + list(obj.get_children(False)):
            rows.append({"name": o.get_name(), "type": str(o.type), "decl": text_of(o.textual_declaration) if getattr(o, "has_textual_declaration", False) else None, "impl": text_of(o.textual_implementation) if getattr(o, "has_textual_implementation", False) else None})
        return rows
    if method == "bridge.shutdown":
        raise SystemExit(0)
    raise RpcError("BAD_REQUEST", "unknown method " + method)


def serve():
    listener = TcpListener(IPAddress.Loopback, PORT)
    listener.Start()
    client = listener.AcceptTcpClient()
    stream = client.GetStream()
    reader = StreamReader(stream, UTF8Encoding(False))
    writer = StreamWriter(stream, UTF8Encoding(False))
    writer.AutoFlush = True
    first = json.loads(reader.ReadLine() or "{}")
    if not TOKEN or first.get("token") != TOKEN:
        return
    while True:
        line = reader.ReadLine()
        if line is None:
            break
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            res = handle(req.get("method"), req.get("params") or {})
            reply = {"id": rid, "result": res}
        except SystemExit:
            writer.WriteLine(json.dumps({"id": rid, "result": {"stopped": True}}))
            break
        except RpcError as e:
            reply = {"id": rid, "error": {"code": e.code, "message": e.message}}
        except Exception as e:
            reply = {"id": rid, "error": {"code": "INTERNAL", "message": "%s: %s" % (type(e).__name__, e)}}
            sys.stderr.write(traceback.format_exc())
        writer.WriteLine(json.dumps(reply))
    client.Close()
    listener.Stop()


try:
    serve()
finally:
    try:
        if state["project"] is not None:
            state["project"].close()
    except Exception:
        pass
