// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.ExternalSources;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;
using Siemens.Engineering.SW.Units;
using Siemens.Engineering.SW.WatchAndForceTables;

namespace Rung.Bridge.V20
{
    /// <summary>An object found during enumeration, with what export/import need to reach it again.</summary>
    sealed class ObjectRef
    {
        public ObjectEntry Entry;
        public IEngineeringObject Obj;
        public object ParentGroup;   // PlcBlockGroup | PlcTypeGroup | PlcTagTableGroup | PlcWatchAndForceTableGroup
        public PlcSoftware Plc;
    }

    public sealed class OpennessSession : ITiaSession, IDisposable
    {
        // V20 facts (docs/facts/openness-v20.md): SD documents for LAD, not FBD.
        static readonly FormCapabilities Caps = new FormCapabilities { SdLad = true, SdFbd = false, SourceStl = true };
        const string Stem = "obj";

        readonly TiaPortal _portal;
        readonly Project _project;
        readonly BridgeArgs _args;
        readonly Action<string, object> _emit;
        readonly int _tiaPid;
        readonly Dictionary<string, ObjectRef> _index = new Dictionary<string, ObjectRef>(StringComparer.Ordinal);
        volatile bool _disposed;
        volatile bool _inImport;

        OpennessSession(TiaPortal portal, Project project, BridgeArgs args, Action<string, object> emit, int tiaPid)
        {
            _portal = portal; _project = project; _args = args; _emit = emit; _tiaPid = tiaPid;
            portal.Disposed += (s, e) => { _disposed = true; emit("tia-disposed", new { }); };
            portal.Notification += (s, e) =>
            {
                e.IsHandled = true;
                emit("tia-notification", new { caption = e.Caption, text = e.Text, detail = e.DetailText });
            };
            portal.Confirmation += OnConfirmation;
        }

        /// <summary>Runs on a foreign thread; answers synchronously and never touches the owner thread.</summary>
        void OnConfirmation(object sender, ConfirmationEventArgs e)
        {
            // Only answer while rung itself is importing; always the most conservative offered choice.
            if (_inImport)
            {
                foreach (var pair in new[] { (ConfirmationChoices.Cancel, ConfirmationResult.Cancel), (ConfirmationChoices.No, ConfirmationResult.No), (ConfirmationChoices.Abort, ConfirmationResult.Abort) })
                {
                    if ((e.Choices & pair.Item1) != 0)
                    {
                        e.Result = pair.Item2;
                        e.IsHandled = true;
                        break;
                    }
                }
            }
            _emit("tia-confirmation", new { caption = e.Caption, text = e.Text, choices = e.Choices.ToString(), handled = e.IsHandled, result = e.IsHandled ? e.Result.ToString() : null });
        }

        public static OpennessSession Attach(BridgeArgs args, Action<string, object> emit)
        {
            try
            {
                var procs = TiaPortal.GetProcesses();
                var chosen = PortalSelector.Choose(procs.Select(p => new PortalCandidate(p.Id, p.ProjectPath?.FullName)).ToList(), args.ProjectPath);
                var proc = procs.First(p => p.Id == chosen.Pid);
                var portal = proc.Attach();
                var project = portal.Projects.FirstOrDefault(p => args.ProjectPath == null || string.Equals(p.Path.FullName, Path.GetFullPath(args.ProjectPath), StringComparison.OrdinalIgnoreCase));
                if (project == null)
                {
                    if (portal.LocalSessions.Count > 0) throw new RpcException(ErrorCodes.MultiuserUnsupported, "Multiuser local sessions are not supported yet.");
                    throw new RpcException(ErrorCodes.NoProject, "The TIA Portal instance has no matching project open.");
                }
                SweepWorkDirs();
                return new OpennessSession(portal, project, args, emit, proc.Id);
            }
            catch (EngineeringSecurityException e)
            {
                throw new RpcException(ErrorCodes.AccessDenied, e.Message);
            }
            catch (UnauthorizedAccessException e)
            {
                throw new RpcException(ErrorCodes.AccessDenied, e.Message);
            }
        }

        void Alive()
        {
            if (_disposed) throw new RpcException(ErrorCodes.PortalDisposed, "TIA Portal was closed.");
        }

        // ---------------------------------------------------------------- inventory

        IEnumerable<PlcSoftware> Plcs()
        {
            var devices = new List<Device>(_project.Devices);
            void Walk(DeviceUserGroupComposition groups)
            {
                foreach (DeviceUserGroup g in groups) { devices.AddRange(g.Devices); Walk(g.Groups); }
            }
            Walk(_project.DeviceGroups);
            devices.AddRange(_project.UngroupedDevicesGroup.Devices);
            var seen = new HashSet<PlcSoftware>();
            foreach (var d in devices)
                foreach (var sw in Software(d.DeviceItems))
                    if (seen.Add(sw)) yield return sw;
        }

        static IEnumerable<PlcSoftware> Software(DeviceItemComposition items)
        {
            foreach (DeviceItem item in items)
            {
                var sw = item.GetService<SoftwareContainer>()?.Software as PlcSoftware;
                if (sw != null) yield return sw;
                foreach (var nested in Software(item.DeviceItems)) yield return nested;
            }
        }

        PlcSoftware Plc(string device)
        {
            var matches = Plcs().Where(p => p.Name == device).ToList();
            if (matches.Count == 0) throw new RpcException(ErrorCodes.NotFound, "No PLC named " + device);
            if (matches.Count > 1) throw new RpcException(ErrorCodes.BadRequest, "Several PLCs are named " + device);
            return matches[0];
        }

        static string[] UnitNames(PlcSoftware plc)
        {
            try
            {
                var provider = plc.GetService<PlcUnitProvider>();
                if (provider == null) return new string[0];
                return provider.UnitGroup.Units.Select(u => u.GetAttribute("Name") as string).Where(n => n != null).ToArray();
            }
            catch (EngineeringException) { return new string[0]; }
        }

        public ProjectInfo GetProjectInfo()
        {
            Alive();
            var plcs = Plcs().ToList();
            return new ProjectInfo
            {
                Name = _project.Name,
                Path = _project.Path.FullName,
                TiaVersion = TiaVersion.Name,
                Devices = plcs.Select(p => p.Name).ToArray(),
                IsLocalSession = false,
                Units = plcs.SelectMany(p => UnitNames(p).Select(u => p.Name + "/" + u)).ToArray(),
            };
        }

        public IReadOnlyList<ObjectEntry> ListObjects(string device)
        {
            Alive();
            var plc = Plc(device);
            var refs = new List<ObjectRef>();
            WalkBlocks(plc, device, plc.BlockGroup, new List<string>(), refs);
            WalkTypes(plc, device, plc.TypeGroup, new List<string>(), refs);
            WalkTags(plc, device, plc.TagTableGroup, new List<string>(), refs);
            WalkWatch(plc, device, plc.WatchAndForceTableGroup, new List<string>(), refs);
            foreach (var key in _index.Keys.Where(k => k.StartsWith("plc:" + AddressFormat.EscapeSegment(device) + "/", StringComparison.Ordinal)).ToList()) _index.Remove(key);
            foreach (var r in refs) _index[r.Entry.Address] = r;
            return refs.Select(r => r.Entry).ToList();
        }

        static string Addr(string device, string kind, List<string> groups, string name, string ns) =>
            AddressFormat.Format(new AddressParts { Device = device, Kind = kind, Groups = groups.ToArray(), Name = name, Namespace = string.IsNullOrEmpty(ns) ? null : ns });

        static string Dates(params DateTime[] d) => "dt:" + string.Join(":", d.Select(x => x.Ticks));

        static string Fingerprint(IEngineeringServiceProvider obj, bool? consistent, Func<string> fallback)
        {
            if (consistent == false) return fallback();
            try
            {
                // V20 returns null entries in the list for some objects (seen live): skip them
                var fps = obj.GetService<FingerprintProvider>()?.GetFingerprints()?.Where(f => f != null).ToList();
                if (fps != null && fps.Count > 0)
                    return "fp:" + string.Join("|", fps.OrderBy(f => f.Id.ToString(), StringComparer.Ordinal).Select(f => f.Id + "=" + f.Value));
            }
            catch (EngineeringException) { }
            return fallback();
        }

        static string BlockTypeOf(PlcBlock b)
        {
            if (b is FB) return "FB";
            if (b is FC) return "FC";
            if (b is OB) return "OB";
            if (b is GlobalDB) return "GlobalDB";
            if (b is InstanceDB) return "InstanceDB";
            if (b is ArrayDB) return "ArrayDB";
            return b.GetType().Name;
        }

        static bool IsFailsafeLanguage(ProgrammingLanguage l) => l.ToString().StartsWith("F_", StringComparison.Ordinal);

        void WalkBlocks(PlcSoftware plc, string device, PlcBlockGroup group, List<string> path, List<ObjectRef> refs)
        {
            foreach (PlcBlock b in group.Blocks)
            {
                var lang = b.ProgrammingLanguage;
                var entry = new ObjectEntry
                {
                    Address = Addr(device, "block", path, b.Name, b.Namespace),
                    Kind = "block",
                    Language = lang.ToString(),
                    BlockType = BlockTypeOf(b),
                    Number = b.Number,
                    Namespace = string.IsNullOrEmpty(b.Namespace) ? null : b.Namespace,
                    KnowHowProtected = b.IsKnowHowProtected,
                    IsFailsafe = IsFailsafeLanguage(lang),
                    IsConsistent = b.IsConsistent,
                };
                entry.Fingerprint = Fingerprint(b, entry.IsConsistent, () => Dates(b.ModifiedDate, b.CodeModifiedDate, b.InterfaceModifiedDate));
                refs.Add(new ObjectRef { Entry = entry, Obj = b, ParentGroup = group, Plc = plc });
            }
            foreach (PlcBlockUserGroup g in group.Groups)
                WalkBlocks(plc, device, g, new List<string>(path) { g.Name }, refs);
        }

        void WalkTypes(PlcSoftware plc, string device, PlcTypeGroup group, List<string> path, List<ObjectRef> refs)
        {
            foreach (PlcType t in group.Types)
            {
                var entry = new ObjectEntry
                {
                    Address = Addr(device, "type", path, t.Name, t.Namespace),
                    Kind = "type",
                    Language = "UDT",
                    Namespace = string.IsNullOrEmpty(t.Namespace) ? null : t.Namespace,
                    KnowHowProtected = t.IsKnowHowProtected,
                    IsFailsafe = false, // F-UDT detection is fact F13; unverified in V20
                    IsConsistent = t.IsConsistent,
                };
                entry.Fingerprint = Fingerprint(t, entry.IsConsistent, () => Dates(t.ModifiedDate, t.InterfaceModifiedDate));
                refs.Add(new ObjectRef { Entry = entry, Obj = t, ParentGroup = group, Plc = plc });
            }
            foreach (PlcTypeUserGroup g in group.Groups)
                WalkTypes(plc, device, g, new List<string>(path) { g.Name }, refs);
        }

        void WalkTags(PlcSoftware plc, string device, PlcTagTableGroup group, List<string> path, List<ObjectRef> refs)
        {
            foreach (PlcTagTable t in group.TagTables)
            {
                // ModifiedTimeStamp is weak (fact F25): "dt:" makes rung verify it by hash periodically.
                var entry = new ObjectEntry { Address = Addr(device, "tagtable", path, t.Name, null), Kind = "tagtable", Fingerprint = Dates(t.ModifiedTimeStamp) };
                refs.Add(new ObjectRef { Entry = entry, Obj = t, ParentGroup = group, Plc = plc });
            }
            foreach (PlcTagTableUserGroup g in group.Groups)
                WalkTags(plc, device, g, new List<string>(path) { g.Name }, refs);
        }

        void WalkWatch(PlcSoftware plc, string device, PlcWatchAndForceTableGroup group, List<string> path, List<ObjectRef> refs)
        {
            foreach (PlcWatchTable t in group.WatchTables)
                refs.Add(new ObjectRef { Entry = new ObjectEntry { Address = Addr(device, "watchtable", path, t.Name, null), Kind = "watchtable", Fingerprint = "none" }, Obj = t, ParentGroup = group, Plc = plc });
            foreach (PlcForceTable t in group.ForceTables)
                refs.Add(new ObjectRef { Entry = new ObjectEntry { Address = Addr(device, "forcetable", path, t.Name, null), Kind = "forcetable", Fingerprint = "none" }, Obj = t, ParentGroup = group, Plc = plc });
            foreach (PlcWatchAndForceTableUserGroup g in group.Groups)
                WalkWatch(plc, device, g, new List<string>(path) { g.Name }, refs);
        }

        /// <summary>
        /// Cached references can go stale when objects are renamed, moved or deleted in TIA between
        /// inventory and use; only return one that still sits at exactly this address.
        /// </summary>
        ObjectRef Resolve(string address)
        {
            if (_index.TryGetValue(address, out var r) && CurrentAddress(r) == address) return r;
            var parts = AddressFormat.Parse(address);
            ListObjects(parts.Device);
            if (_index.TryGetValue(address, out r) && CurrentAddress(r) == address) return r;
            throw new RpcException(ErrorCodes.NotFound, "No object at " + address);
        }

        static string CurrentAddress(ObjectRef r)
        {
            try
            {
                var groups = new List<string>();
                object g = r.ParentGroup;
                for (;;)
                {
                    if (g is PlcBlockUserGroup bu) { groups.Insert(0, bu.Name); g = bu.Parent; }
                    else if (g is PlcTypeUserGroup tu) { groups.Insert(0, tu.Name); g = tu.Parent; }
                    else if (g is PlcTagTableUserGroup gu) { groups.Insert(0, gu.Name); g = gu.Parent; }
                    else if (g is PlcWatchAndForceTableUserGroup wu) { groups.Insert(0, wu.Name); g = wu.Parent; }
                    else break;
                }
                var device = AddressFormat.Parse(r.Entry.Address).Device;
                switch (r.Obj)
                {
                    case PlcBlock b: return Addr(device, "block", groups, b.Name, b.Namespace);
                    case PlcType t: return Addr(device, "type", groups, t.Name, t.Namespace);
                    case PlcTagTable tt: return Addr(device, "tagtable", groups, tt.Name, null);
                    case PlcWatchTable w: return Addr(device, "watchtable", groups, w.Name, null);
                    case PlcForceTable f: return Addr(device, "forcetable", groups, f.Name, null);
                    default: return null;
                }
            }
            catch (EngineeringException) { return null; } // deleted or otherwise unreachable
            catch (AddressException) { return null; }
        }

        /// <summary>Re-reads the revision of one object without a full inventory.</summary>
        string Revision(ObjectRef r)
        {
            switch (r.Obj)
            {
                case PlcBlock b: return Fingerprint(b, b.IsConsistent, () => Dates(b.ModifiedDate, b.CodeModifiedDate, b.InterfaceModifiedDate));
                case PlcType t: return Fingerprint(t, t.IsConsistent, () => Dates(t.ModifiedDate, t.InterfaceModifiedDate));
                case PlcTagTable tt: return Dates(tt.ModifiedTimeStamp);
                default: return "none";
            }
        }

        // ---------------------------------------------------------------- export

        public ExportResult Export(string address, string form, string targetDir)
        {
            Alive();
            var r = Resolve(address);
            if (form == "auto") form = FormPolicy.Choose(r.Entry, Caps);
            Directory.CreateDirectory(targetDir);
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var before = Revision(r);
                foreach (var f in Directory.GetFiles(targetDir, Stem + ".*")) File.Delete(f);
                var warnings = new List<string>();
                if (r.Entry.IsConsistent == false) warnings.Add(WarningCodes.Inconsistent);
                var actualForm = ExportInto(r, form, targetDir, warnings);
                if (Revision(r) != before) continue; // changed while exporting; bytes may be torn
                var files = Directory.GetFiles(targetDir, Stem + ".*").OrderBy(f => f, StringComparer.Ordinal)
                    .Select(f => TextNormalizer.NormalizeFile(f, Path.GetFileName(f) == Stem + "." + actualForm ? "primary" : "companion" + Path.GetFileName(f).Substring(Stem.Length)))
                    .ToArray();
                return new ExportResult { Address = address, Form = actualForm, Files = files, Warnings = warnings.ToArray(), Fingerprint = before, BundleHash = Bundle.Hash(files) };
            }
            throw new RpcException(ErrorCodes.StaleSnapshot, address + " kept changing during export");
        }

        string ExportInto(ObjectRef r, string form, string dir, List<string> warnings)
        {
            var primary = new FileInfo(Path.Combine(dir, Stem + "." + form));
            try
            {
                switch (form)
                {
                    case "scl":
                    case "awl":
                    case "db":
                    case "udt":
                        r.Plc.ExternalSourceGroup.GenerateSource(new[] { (IGenerateSource)r.Obj }, primary, GenerateOptions.None);
                        return form;
                    case "s7dcl":
                    {
                        var res = r.Obj is PlcType t ? t.ExportAsDocuments(new DirectoryInfo(dir), Stem) : ((PlcBlock)r.Obj).ExportAsDocuments(new DirectoryInfo(dir), Stem);
                        if (res.State == DocumentResultState.Success) return form;
                        warnings.Add(WarningCodes.SdFallback);
                        foreach (var f in Directory.GetFiles(dir, Stem + ".*")) File.Delete(f);
                        return ExportInto(r, "xml", dir, warnings);
                    }
                    case "xml":
                    case "tags.xml":
                        switch (r.Obj)
                        {
                            case PlcBlock b: b.Export(primary, ExportOptions.None, DocumentInfoOptions.None); break;
                            case PlcType t: t.Export(primary, ExportOptions.None, DocumentInfoOptions.None); break;
                            case PlcTagTable tt: tt.Export(primary, ExportOptions.None, DocumentInfoOptions.None); break;
                            case PlcWatchTable w: w.Export(primary, ExportOptions.None, DocumentInfoOptions.None); break;
                            case PlcForceTable f:
                                // no DocumentInfoOptions overload: strip the timestamped DocumentInfo so exports stay byte-stable (seen live)
                                f.Export(primary, ExportOptions.None);
                                File.WriteAllText(primary.FullName, System.Text.RegularExpressions.Regex.Replace(File.ReadAllText(primary.FullName), @"[ \t]*<DocumentInfo>[\s\S]*?</DocumentInfo>\r?\n?", ""), new UTF8Encoding(true));
                                break;
                            default: throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot export " + r.Entry.Address + " as XML");
                        }
                        return form;
                    case "protected.yaml":
                        File.WriteAllText(primary.FullName, ProtectedYaml.Render(r.Entry), new UTF8Encoding(false));
                        return form;
                    default:
                        throw new RpcException(ErrorCodes.BadRequest, "Unknown form " + form);
                }
            }
            catch (EngineeringException e)
            {
                throw new RpcException(ErrorCodes.ExportFailed, e.Message);
            }
        }

        // ---------------------------------------------------------------- import (fixture only in M1)

        public ExportResult Import(string address, string form, string path, string expectedTiaRevision, string operationId)
        {
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            if (!Guid.TryParseExact(operationId, "D", out var opGuid))
                throw new RpcException(ErrorCodes.BadRequest, "operationId must be a UUID");
            operationId = opGuid.ToString("D");
            var isNew = expectedTiaRevision == "absent";
            var r = isNew ? NewObjectRef(address, form) : Resolve(address);
            if (FormPolicy.IsReadOnly(r.Entry) || form == "protected.yaml") throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only");
            if (!isNew && Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
            var name = r.Entry.Address;
            IList<string> imported;
            _inImport = true;
            var guard = new PasswordPromptGuard(_tiaPid);
            try
            {
                using (var access = _portal.ExclusiveAccess("rung: importing " + AddressFormat.Parse(address).Name))
                using (var tx = access.Transaction(_project, "rung import " + operationId))
                {
                    if (isNew) r.ParentGroup = EnsureGroup(r);
                    else if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
                    imported = ImportForm(r, form, path, operationId);
                    var parts = AddressFormat.Parse(address);
                    var want = Identity(parts.Name, parts.Namespace);
                    if (imported.Count != 1 || imported[0] != want)
                        throw new RpcException(ErrorCodes.ImportFailed, "Import would change [" + string.Join(", ", imported) + "] instead of exactly " + want + "; rolled back");
                    tx.CommitOnDispose();
                }
            }
            catch (EngineeringException e)
            {
                throw new RpcException(ErrorCodes.ImportFailed, e.Message);
            }
            finally
            {
                _inImport = false;
                guard.Dispose();
                try { Directory.Delete(WorkDir(operationId, "src"), true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }

            // Compile outside the transaction (Siemens forbids compile inside it), then return the fresh export.
            _index.Clear();
            var fresh = Resolve(address);
            var cancelled = guard.Cancelled;
            using (var compileGuard = new PasswordPromptGuard(_tiaPid))
            {
                try { (fresh.Obj as IEngineeringServiceProvider)?.GetService<ICompilable>()?.Compile(); }
                catch (EngineeringException) { }
                cancelled += compileGuard.Cancelled;
            }
            _index.Clear();
            var outDir = WorkDir(operationId, "out");
            var result = Export(address, "auto", outDir);
            if (cancelled > 0) result.Warnings = result.Warnings.Concat(new[] { WarningCodes.PasswordPromptCancelled }).ToArray();
            return result;
        }

        /// <summary>Target for an object that does not exist yet; its folder is created inside the import transaction.</summary>
        ObjectRef NewObjectRef(string address, string form)
        {
            var parts = AddressFormat.Parse(address);
            if (parts.Unit != null) throw new RpcException(ErrorCodes.UnsupportedObject, "Creating objects in software units is not supported yet");
            ListObjects(parts.Device);
            if (_index.ContainsKey(address)) throw new RpcException(ErrorCodes.StaleRevision, address + " already exists in TIA Portal");
            var allowed = parts.Kind == "block" ? new[] { "scl", "awl", "db", "s7dcl", "xml" }
                : parts.Kind == "type" ? new[] { "udt", "s7dcl", "xml" }
                : parts.Kind == "tagtable" ? new[] { "tags.xml" } : new string[0];
            if (Array.IndexOf(allowed, form) < 0) throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot create a " + parts.Kind + " from form " + form);
            return new ObjectRef { Entry = new ObjectEntry { Address = address, Kind = parts.Kind, Fingerprint = "absent" }, Plc = Plc(parts.Device) };
        }

        /// <summary>Finds or creates the user-group chain named in the address (called inside the transaction).</summary>
        static object EnsureGroup(ObjectRef r)
        {
            var parts = AddressFormat.Parse(r.Entry.Address);
            switch (parts.Kind)
            {
                case "block":
                {
                    PlcBlockGroup g = r.Plc.BlockGroup;
                    foreach (var name in parts.Groups) g = g.Groups.Find(name) ?? g.Groups.Create(name);
                    return g;
                }
                case "type":
                {
                    PlcTypeGroup g = r.Plc.TypeGroup;
                    foreach (var name in parts.Groups) g = g.Groups.Find(name) ?? g.Groups.Create(name);
                    return g;
                }
                case "tagtable":
                {
                    PlcTagTableGroup g = r.Plc.TagTableGroup;
                    foreach (var name in parts.Groups) g = g.Groups.Find(name) ?? g.Groups.Create(name);
                    return g;
                }
                default:
                    throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot create " + parts.Kind);
            }
        }

        // ---------------------------------------------------------------- read-only model views (hardware, HMI, technology objects)

        static readonly Dictionary<string, string[]> ViewCompositions = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["hardware"] = new[] { "DeviceItems", "Addresses", "Nodes", "Subnets", "IoSystems" },
            ["hmi"] = new[] { "Screens", "ScreenItems", "Tags", "Connections", "AlarmClasses", "DiscreteAlarms", "AnalogAlarms", "HmiTextLists", "Scripts", "Dynamizations", "EventHandlers" },
            ["techobjects"] = new[] { "TechnologicalObjects", "Groups" },
        };

        public DescribeNode Describe(string scope, int maxNodes)
        {
            Alive();
            if (!ViewCompositions.TryGetValue(scope, out var allowed)) throw new RpcException(ErrorCodes.BadRequest, "Unknown scope " + scope + " (hardware, hmi, techobjects)");
            var budget = Math.Max(10, Math.Min(maxNodes, 200000));
            var count = 0;
            var root = new DescribeNode { Type = "Project", Name = _project.Name, Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) };
            void Add(string key, DescribeNode child)
            {
                if (child == null) return;
                if (!root.Children.TryGetValue(key, out var list)) root.Children[key] = list = new List<DescribeNode>();
                list.Add(child);
            }
            switch (scope)
            {
                case "hardware":
                    foreach (var d in AllDevices()) Add("Devices", Node(d, allowed, 0, ref count, budget));
                    foreach (IEngineeringObject s in _project.Subnets) Add("Subnets", Node(s, allowed, 0, ref count, budget));
                    break;
                case "hmi":
                    foreach (var d in AllDevices())
                        foreach (var sw in SoftwareOf(d.DeviceItems))
                            if (sw is Siemens.Engineering.HmiUnified.HmiSoftware hmi) Add("HmiUnified", Node(hmi, allowed, 0, ref count, budget));
                    break;
                case "techobjects":
                    foreach (var plc in Plcs()) Add("Plcs", Node(plc.TechnologicalObjectGroup, allowed, 0, ref count, budget, plc.Name));
                    break;
            }
            root.Truncated = count >= budget;
            return root;
        }

        List<Device> AllDevices()
        {
            var devices = new List<Device>(_project.Devices);
            void Walk(DeviceUserGroupComposition groups) { foreach (DeviceUserGroup g in groups) { devices.AddRange(g.Devices); Walk(g.Groups); } }
            Walk(_project.DeviceGroups);
            devices.AddRange(_project.UngroupedDevicesGroup.Devices);
            return devices;
        }

        static IEnumerable<object> SoftwareOf(DeviceItemComposition items)
        {
            foreach (DeviceItem item in items)
            {
                var sw = item.GetService<SoftwareContainer>()?.Software;
                if (sw != null) yield return sw;
                foreach (var nested in SoftwareOf(item.DeviceItems)) yield return nested;
            }
        }

        static string Scalar(object v)
        {
            switch (v)
            {
                case null: return null;
                case string s: return s;
                case bool b: return b ? "true" : "false";
                case Enum e: return e.ToString();
                case DateTime dt: return dt.ToString("o");
                case IFormattable f when v.GetType().IsPrimitive || v is decimal: return f.ToString(null, System.Globalization.CultureInfo.InvariantCulture);
                case IEngineeringObject o:
                    try { return "→ " + (o.GetAttribute("Name") as string ?? o.GetType().Name); } catch (EngineeringException) { return "→ " + o.GetType().Name; }
                default: return null; // compositions, lists and complex values are not attributes
            }
        }

        static DescribeNode Node(IEngineeringObject obj, string[] allowed, int depth, ref int count, int budget, string nameOverride = null)
        {
            if (obj == null || count >= budget || depth > 12) return null;
            count++;
            var node = new DescribeNode { Type = obj.GetType().Name, Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) };
            try
            {
                foreach (var info in obj.GetAttributeInfos())
                {
                    if (info.AccessMode == EngineeringAttributeAccessMode.Write) continue;
                    try
                    {
                        var s = Scalar(obj.GetAttribute(info.Name));
                        if (s != null) node.Attributes[info.Name] = s;
                    }
                    catch (Exception) { /* some attributes throw depending on configuration */ }
                }
            }
            catch (EngineeringException) { }
            node.Name = nameOverride ?? (node.Attributes.TryGetValue("Name", out var n) ? n : null);
            try
            {
                foreach (var ci in obj.GetCompositionInfos())
                {
                    if (Array.IndexOf(allowed, ci.Name) < 0) continue;
                    var comp = obj.GetComposition(ci.Name);
                    var list = new List<DescribeNode>();
                    if (comp is System.Collections.IEnumerable items)
                        foreach (var item in items)
                            if (item is IEngineeringObject child) { var c = Node(child, allowed, depth + 1, ref count, budget); if (c != null) list.Add(c); }
                    if (list.Count > 0) node.Children[ci.Name] = list;
                }
            }
            catch (EngineeringException) { }
            // network interfaces are services, not compositions: surface their nodes (IP addresses) explicitly
            if (obj is DeviceItem di)
            {
                try
                {
                    var ni = di.GetService<NetworkInterface>();
                    if (ni != null)
                    {
                        var nodes = new List<DescribeNode>();
                        foreach (Siemens.Engineering.HW.Node nn in ni.Nodes) { var c = Node(nn, allowed, depth + 1, ref count, budget); if (c != null) nodes.Add(c); }
                        if (nodes.Count > 0) node.Children["NetworkNodes"] = nodes;
                    }
                }
                catch (EngineeringException) { }
            }
            return node;
        }

        // ---------------------------------------------------------------- cross references

        public IReadOnlyList<XRefEntry> XRef(string address)
        {
            Alive();
            var r = Resolve(address);
            var svc = (r.Obj as IEngineeringServiceProvider)?.GetService<Siemens.Engineering.CrossReference.CrossReferenceService>();
            if (svc == null) throw new RpcException(ErrorCodes.UnsupportedCapability, "No cross references for " + address);
            var byObject = _index.Values.Where(v => v.Obj != null).ToList();
            string AddressOf(IEngineeringObject o) => o == null ? null : byObject.FirstOrDefault(v => ReferenceEquals(v.Obj, o) || v.Obj.Equals(o))?.Entry.Address;
            var list = new List<XRefEntry>();
            void Walk(Siemens.Engineering.CrossReference.SourceObjectComposition sources)
            {
                foreach (Siemens.Engineering.CrossReference.SourceObject s in sources)
                {
                    foreach (Siemens.Engineering.CrossReference.ReferenceObject refObj in s.References)
                    {
                        foreach (Siemens.Engineering.CrossReference.Location loc in refObj.Locations)
                        {
                            list.Add(new XRefEntry
                            {
                                Source = AddressOf(s.UnderlyingObject) ?? address,
                                SourceName = s.Name,
                                Target = AddressOf(refObj.UnderlyingObject),
                                TargetName = refObj.Name,
                                TargetType = refObj.TypeName,
                                TargetAddress = refObj.Address,
                                Access = loc.Access.ToString(),
                                ReferenceType = loc.ReferenceType.ToString(),
                                Location = loc.ReferenceLocation,
                            });
                        }
                    }
                    Walk(s.Children);
                }
            }
            try { Walk(svc.GetCrossReferences(Siemens.Engineering.CrossReference.CrossReferenceFilter.AllObjects).Sources); }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.Internal, "cross references failed: " + e.Message); }
            return list;
        }

        // ---------------------------------------------------------------- delete

        public void Delete(string address, string expectedTiaRevision, string operationId)
        {
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            if (!Guid.TryParseExact(operationId, "D", out _)) throw new RpcException(ErrorCodes.BadRequest, "operationId must be a UUID");
            var r = Resolve(address);
            if (FormPolicy.IsReadOnly(r.Entry)) throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only");
            if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal; delete not confirmed");
            _inImport = true;
            try
            {
                using (var access = _portal.ExclusiveAccess("rung: deleting " + AddressFormat.Parse(address).Name))
                using (var tx = access.Transaction(_project, "rung delete " + operationId))
                {
                    if (CurrentAddress(r) != address || Revision(r) != expectedTiaRevision)
                        throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal; delete not confirmed");
                    switch (r.Obj)
                    {
                        case PlcBlock b: b.Delete(); break;
                        case PlcType t: t.Delete(); break;
                        case PlcTagTable tt: tt.Delete(); break;
                        case PlcWatchTable w: w.Delete(); break;
                        default: throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot delete " + address);
                    }
                    tx.CommitOnDispose();
                }
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.ImportFailed, e.Message); }
            finally { _inImport = false; }
            _index.Remove(address);
        }

        // ---------------------------------------------------------------- compile

        public IReadOnlyList<CompileMessage> Compile(string device, string[] addresses)
        {
            Alive();
            var plc = Plc(device);
            if (!_index.Values.Any(v => v.Plc == plc)) ListObjects(device);
            var byName = _index.Values.Where(v => v.Plc == plc)
                .GroupBy(v => AddressFormat.Parse(v.Entry.Address).Name, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Count() == 1 ? g.First().Entry.Address : null, StringComparer.Ordinal);
            var messages = new List<CompileMessage>();
            try
            {
                if (addresses.Length == 0)
                {
                    var compiler = plc.GetService<ICompilable>();
                    if (compiler == null) throw new RpcException(ErrorCodes.UnsupportedCapability, "PLC software cannot be compiled");
                    Flatten(compiler.Compile().Messages, null, byName, messages);
                }
                else
                {
                    foreach (var a in addresses)
                    {
                        var r = Resolve(a);
                        var c = (r.Obj as IEngineeringServiceProvider)?.GetService<ICompilable>();
                        if (c == null) continue; // types and tables are compiled together with their users
                        Flatten(c.Compile().Messages, a, byName, messages);
                    }
                }
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.Internal, "compile failed: " + e.Message); }
            return messages;
        }

        static void Flatten(CompilerResultMessageComposition list, string address, Dictionary<string, string> byName, List<CompileMessage> into)
        {
            foreach (CompilerResultMessage m in list)
            {
                if (m.Messages.Count == 0 && !string.IsNullOrEmpty(m.Description) && m.State != CompilerResultState.Success)
                {
                    var target = address;
                    if (target == null && !string.IsNullOrEmpty(m.Path))
                    {
                        // The path ends with the object name, sometimes followed by " (FB1)" (exact shape: fact F7).
                        var last = m.Path.Split(new[] { '>', '/', '\\' }).Last().Trim();
                        var paren = last.LastIndexOf(" (", StringComparison.Ordinal);
                        if (paren > 0) last = last.Substring(0, paren);
                        if (byName.TryGetValue(last.Trim('"'), out var hit)) target = hit;
                    }
                    into.Add(new CompileMessage
                    {
                        Address = target,
                        Severity = m.State == CompilerResultState.Error ? "error" : m.State == CompilerResultState.Warning ? "warning" : "info",
                        Path = m.Path,
                        Description = m.Description,
                    });
                }
                Flatten(m.Messages, address, byName, into);
            }
        }

        static string Identity(string name, string ns) => string.IsNullOrEmpty(ns) ? name : ns + "~" + name;

        static string TryNamespace(IEngineeringObject o)
        {
            try { return o.GetAttribute("Namespace") as string; } catch (EngineeringException) { return null; }
        }

        /// <summary>Per-operation scratch space in %TEMP%/rung-bridge/{uuid}/{part} (operationId is validated as a UUID).</summary>
        static string WorkDir(string operationId, string part)
        {
            var d = Path.Combine(Path.GetTempPath(), "rung-bridge", operationId, part);
            Directory.CreateDirectory(d);
            return d;
        }

        /// <summary>Removes scratch folders of earlier bridge runs.</summary>
        static void SweepWorkDirs()
        {
            try
            {
                foreach (var d in Directory.GetDirectories(Path.Combine(Path.GetTempPath(), "rung-bridge")))
                    if (Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddDays(-1)) Directory.Delete(d, true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        IList<string> ImportForm(ObjectRef r, string form, string path, string operationId)
        {
            switch (form)
            {
                case "scl":
                case "awl":
                case "db":
                case "udt":
                {
                    var tmp = Path.Combine(WorkDir(operationId, "src"), Stem + "." + form);
                    Directory.CreateDirectory(Path.GetDirectoryName(tmp));
                    File.WriteAllBytes(tmp, TextNormalizer.ForSourceImport(File.ReadAllBytes(path)));
                    var source = r.Plc.ExternalSourceGroup.ExternalSources.CreateFromFile("rung_" + operationId.Replace("-", ""), tmp);
                    try
                    {
                        IList<IEngineeringObject> created;
                        if (r.ParentGroup is PlcBlockUserGroup bg) created = source.GenerateBlocksFromSource(bg, GenerateBlockOption.None);
                        else if (r.ParentGroup is PlcTypeUserGroup tg) created = source.GenerateBlocksFromSource(tg, GenerateBlockOption.None);
                        else created = source.GenerateBlocksFromSource(GenerateBlockOption.None);
                        return created.Select(o => Identity(o.GetAttribute("Name") as string, TryNamespace(o))).ToList();
                    }
                    finally { source.Delete(); }
                }
                case "s7dcl":
                {
                    var dir = new DirectoryInfo(Path.GetDirectoryName(path));
                    var stem = Path.GetFileNameWithoutExtension(path);
                    if (r.ParentGroup is PlcBlockGroup bg)
                        return bg.Blocks.ImportFromDocuments(dir, stem, ImportDocumentOptions.Override).ImportedPlcBlocks.Select(b => Identity(b.Name, b.Namespace)).ToList();
                    if (r.ParentGroup is PlcTypeGroup tg)
                        return tg.Types.ImportFromDocuments(dir, stem, ImportDocumentOptions.Override).ImportedPlcTypes.Select(t => Identity(t.Name, t.Namespace)).ToList();
                    break;
                }
                case "xml":
                    if (r.ParentGroup is PlcBlockGroup xb) return xb.Blocks.Import(new FileInfo(path), ImportOptions.Override, SWImportOptions.None).Select(b => Identity(b.Name, b.Namespace)).ToList();
                    if (r.ParentGroup is PlcTypeGroup xt) return xt.Types.Import(new FileInfo(path), ImportOptions.Override, SWImportOptions.None).Select(t => Identity(t.Name, t.Namespace)).ToList();
                    break;
                case "tags.xml":
                    if (r.ParentGroup is PlcTagTableGroup tt) return tt.TagTables.Import(new FileInfo(path), ImportOptions.Override).Select(t => t.Name).ToList();
                    break;
            }
            throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot import form " + form + " for " + r.Entry.Address);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _portal.Confirmation -= OnConfirmation; _portal.Dispose(); } catch (Exception) { }
        }
    }
}
