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
END = {"PROGRAM": "END_PROGRAM", "FUNCTION_BLOCK": "END_FUNCTION_BLOCK", "FUNCTION": "END_FUNCTION", "METHOD": "END_METHOD", "ACTION": "END_ACTION", "INTERFACE": "END_INTERFACE"}
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


def decl_keyword(obj):
    if not getattr(obj, "has_textual_declaration", False):
        return None
    head = text_of(obj.textual_declaration).lstrip()
    head = re.sub(r"^(\{[^}]*\}\s*)+", "", head)  # attribute pragmas before the header
    m = re.match(r"([A-Za-z_]+)", head)
    return m.group(1).upper() if m else None


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


def export_text(obj, kind):
    if kind != "block":
        return ensure_nl(text_of(obj.textual_declaration))
    kw = decl_keyword(obj)
    parts = [unit_text(obj, kw)]
    for c in obj.get_children(False):
        if is_method(c):
            parts.append(unit_text(c, "METHOD"))
        elif is_action(c):
            parts.append(unit_text(c, "ACTION"))
    return "\n".join(parts)


# by object type, not by text: a method whose declaration is broken is still a method
METHOD_TYPE = "f8a58466-d7f6-439f-bbb8-d4600e41d099"


def is_method(c):
    return str(c.type).lower() == METHOD_TYPE or decl_keyword(c) == "METHOD"


def is_action(c):
    return not is_method(c) and not getattr(c, "has_textual_declaration", False) and getattr(c, "has_textual_implementation", False)


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
HEADER = re.compile(r"^[ \t]*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|ACTION|INTERFACE)\b", re.I | re.M)


def split_units(text):
    """Top-level units of a POU file: [(keyword, text without its END line)]. What stands above a header
    (attribute pragmas, comments) belongs to that unit's declaration, as CODESYS keeps it there."""
    text = text.replace("\r\n", "\n")
    starts = [m for m in HEADER.finditer(text)]
    units = []
    after = 0  # where the previous unit's END line ended
    for i, m in enumerate(starts):
        nxt = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        kw = m.group(1).upper()
        ends = list(re.finditer(r"^[ \t]*" + END[kw] + r"\b[^\n]*(\n|$)", text[m.start():nxt], re.I | re.M))
        stop = m.start() + ends[-1].start() if ends else nxt
        # blank lines between units are layout, not part of a declaration
        body = re.sub(r"^(?:[ \t]*\n)+", "", text[after:stop])
        units.append((kw, body.rstrip() + "\n"))
        after = m.start() + ends[-1].end() if ends else nxt
    return units


def header_line(lines):
    """Index of the header line: pragmas and comments may stand above it."""
    for k, line in enumerate(lines):
        if HEADER.match(line):
            return k
    return 0


def split_decl_impl(unit):
    """Declaration = what stands above the header, the header and its VAR sections; the code is what follows."""
    lines = unit.split("\n")
    i = header_line(lines) + 1
    while i < len(lines) and re.match(r"^\s*\{", lines[i]):
        i += 1  # attribute pragmas under the header
    while i < len(lines):
        s = lines[i].strip()
        if re.match(r"^VAR\w*\b", s, re.I):
            while i < len(lines) and not re.match(r"^\s*END_VAR\b", lines[i], re.I):
                i += 1
            i += 1
            continue
        if s == "":
            i += 1
            continue
        break
    decl = "\n".join(lines[:i]).rstrip() + "\n"
    impl = "\n".join(lines[i:]).strip("\n")
    return decl, (impl + "\n") if impl else ""


def header_name(unit):
    m = re.search(r"^[ \t]*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|ACTION|INTERFACE)\s+(?:(?:ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+)*([A-Za-z_][A-Za-z0-9_]*)", unit, re.I | re.M)
    return m.group(1) if m else None


def return_type(unit):
    m = re.search(r"^[ \t]*(?:METHOD|FUNCTION)\s+(?:(?:ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+)*[A-Za-z_][A-Za-z0-9_]*\s*:\s*([^\n;]+)", unit, re.I | re.M)
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
        m = re.match(r"^\s*TYPE\s+([A-Za-z_][A-Za-z0-9_]*)", text, re.I) if kind == "type" else None
        if kind == "type" and (not m or m.group(1) != name):
            raise RpcError("IMPORT_FAILED", "the file declares " + (m.group(1) if m else "no type") + " but its name says " + name)
        if kind == "tagtable" and not re.search(r"^\s*VAR_GLOBAL\b", text, re.I | re.M):
            raise RpcError("IMPORT_FAILED", "a global variable list starts with VAR_GLOBAL")
        if obj is None:
            parent = folder(app, groups)
            obj = parent.create_dut(name) if kind == "type" else parent.create_gvl(name)
        set_text(obj.textual_declaration, ensure_nl(text))
        return obj, kind
    units = split_units(text)
    if not units or units[0][0] not in POU_KEYWORDS:
        raise RpcError("IMPORT_FAILED", "the file declares no PROGRAM, FUNCTION_BLOCK or FUNCTION")
    kw, main = units[0]
    if header_name(main) != name:
        raise RpcError("IMPORT_FAILED", "the file declares " + str(header_name(main)) + " but its name says " + name)
    if obj is not None and decl_keyword(obj) != kw:
        raise RpcError("IMPORT_FAILED", name + " is a " + str(decl_keyword(obj)) + " in CODESYS; changing it to a " + kw + " is done in CODESYS")
    if obj is None:
        parent = folder(app, groups)
        pou_type = {"PROGRAM": PouType.Program, "FUNCTION_BLOCK": PouType.FunctionBlock, "FUNCTION": PouType.Function}.get(kw)
        if pou_type is None:
            raise RpcError("IMPORT_FAILED", "rung creates PROGRAMs, FUNCTION_BLOCKs and FUNCTIONs; create an " + kw + " in CODESYS")
        # all keywords: create_pou has two C# overloads (see its stub)
        obj = parent.create_pou(name=name, type=pou_type, language=None, return_type=return_type(main) if kw == "FUNCTION" else None, base_type=None, interfaces=None)
    decl, impl = split_decl_impl(main)
    set_text(obj.textual_declaration, decl)
    if getattr(obj, "has_textual_implementation", False):
        set_text(obj.textual_implementation, impl)
    # methods and actions: the file is the list; what it no longer has is removed
    wanted = []
    for ukw, unit in units[1:]:
        uname = header_name(unit)
        wanted.append(uname)
        child = [c for c in obj.get_children(False) if c.get_name() == uname]
        if ukw == "METHOD":
            child = child[0] if child else obj.create_method(uname, return_type(unit))
            d, i = split_decl_impl(unit)
            set_text(child.textual_declaration, d)
            set_text(child.textual_implementation, i)
        elif ukw == "ACTION":
            head = re.search(r"^[ \t]*ACTION\s+[A-Za-z_][A-Za-z0-9_]*\s*:?[ \t]*\n?", unit, re.I | re.M)
            # an action has no declaration: a comment above it would have nowhere to go in CODESYS
            if unit[:head.start()].strip():
                raise RpcError("IMPORT_FAILED", "the text above ACTION " + uname + " has no place in CODESYS (an action has no declaration); put it inside the action")
            child = child[0] if child else obj.create_action(uname)
            set_text(child.textual_implementation, ensure_nl(unit[head.end():].strip("\n")))
    for c in obj.get_children(False):
        if (is_method(c) or is_action(c)) and c.get_name() not in wanted:
            c.remove()
    return obj, kind


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
    allow = set(params.get("allow") or [])
    connect_to(devname, params.get("target"))
    oa = online_app(devname, None)
    full_ok = "stop-cpu" in allow
    base = {"device": devname, "errors": 0, "warnings": 0, "messages": [], "decisions": [], "needsAllow": []}
    # the application's state before: afterwards rung starts it only if it ran (and this download stopped it) or
    # did not exist yet (a first download); one that was stopped stays stopped
    before = None  # None: no application on the device yet
    try:
        if not oa.is_logged_in:
            oa.login(OnlineChangeOption.Keep, False)  # Keep: logs in, downloads nothing
        state = str(oa.application_state).lower()
        # ApplicationState.none: nothing loaded yet
        before = "run" if "run" in state else None if "none" in state else "stop"
        oa.logout()
    except Exception:
        before = None
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
    if params.get("startAfter", True) and (before != "stop" or simulated) and not running:
        oa.start()  # stopped by this download, loaded for the first time, or the simulation
    elif not running:
        base["messages"].append("the application is stopped" + ("; it was stopped before the download, so rung leaves it" if before == "stop" else ""))
    base.update({"state": "Success", "messages": base["messages"] + ["application " + str(oa.application_state)]})
    return base


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
