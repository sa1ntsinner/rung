# -*- coding: utf-8 -*-
# SPDX-License-Identifier: BUSL-1.1
# Generates the CODESYS fixture project for rung's tests (run inside CODESYS: CODESYS.exe --noUI --runscript=...).
#   RUNG_CODESYS_FIXTURE  path of the .project to (re)create
# A Control Win V3 x64 device, a cyclic MainTask calling PLC_PRG, an FB with a method, a DUT, a GVL and a folder.
from __future__ import print_function
import os, traceback

path = os.environ["RUNG_CODESYS_FIXTURE"]
if not os.path.isdir(os.path.dirname(path)):
    os.makedirs(os.path.dirname(path))
log = open(path + ".log", "w")
try:
    if os.path.exists(path):
        os.remove(path)
    proj = projects.create(path, True)
    win = [d for d in device_repository.get_all_devices() if d.device_info.name == "CODESYS Control Win V3 x64"]
    proj.add("Device", win[0].device_id)
    app = proj.active_application
    # Standard is required by the corpus and by the library-manager views test.
    libman = app.get_library_manager()
    if not any(r.name == "#Standard" or r.name.startswith("Standard,") for r in libman.references):
        libraries = [lib for lib in librarymanager.get_all_libraries()
                     if lib.title == "Standard" and lib.company == "System"]
        if not libraries:
            raise Exception("Standard library is not installed in the CODESYS library repository")
        latest = max(libraries, key=lambda lib: tuple(int(n) for n in str(lib.version).split(".")))
        libman.add_library(latest)
    for reference in libman.references:
        if reference.name == "#Standard" or reference.name.startswith("Standard,"):
            reference.qualified_only = False
    tc = app.create_task_configuration()
    tc.create_task("MainTask")
    task = [c for c in tc.get_children(False) if c.get_name() == "MainTask"][0]

    def pou(parent, name, kind, decl, impl):
        o = parent.create_pou(name=name, type=kind, language=None, return_type=None, base_type=None, interfaces=None)
        o.textual_declaration.replace(decl)
        o.textual_implementation.replace(impl)
        return o

    app.create_folder("Motion")
    motion = [c for c in app.get_children(False) if c.is_folder and c.get_name() == "Motion"][0]
    fb = pou(motion, "FB_Count", PouType.FunctionBlock,
             "FUNCTION_BLOCK FB_Count\nVAR_INPUT\n\tbOn : BOOL;\nEND_VAR\nVAR_OUTPUT\n\tnCount : INT;\nEND_VAR\n",
             "IF bOn THEN\n\tnCount := nCount + 1;\nEND_IF\n")
    m = fb.create_method("Reset", "BOOL")
    m.textual_declaration.replace("METHOD Reset : BOOL\n")
    m.textual_implementation.replace("nCount := 0;\nReset := TRUE;\n")
    dut = app.create_dut("ST_Axis")
    dut.textual_declaration.replace("TYPE ST_Axis :\nSTRUCT\n\tfPos : REAL;\n\tbHomed : BOOL;\nEND_STRUCT\nEND_TYPE\n")
    gvl = app.create_gvl("GVL_Plant")
    gvl.textual_declaration.replace("VAR_GLOBAL\n\tnSpeed : INT := 100;\n\tstAxis : ST_Axis;\nEND_VAR\n")
    pou(app, "PLC_PRG", PouType.Program,
        "PROGRAM PLC_PRG\nVAR\n\tfbCount : FB_Count;\n\tnCycles : DINT;\nEND_VAR\n",
        "nCycles := nCycles + 1;\nfbCount(bOn := TRUE);\nGVL_Plant.stAxis.fPos := GVL_Plant.stAxis.fPos + 0.5;\n")
    task.pous.add("PLC_PRG")
    proj.save()
    proj.close()
    log.write("ok\n")
except Exception:
    log.write(traceback.format_exc())
finally:
    log.close()
