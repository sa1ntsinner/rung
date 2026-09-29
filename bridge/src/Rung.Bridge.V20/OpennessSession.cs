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
using Siemens.Engineering.Library.Types;
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

    public sealed partial class OpennessSession : ITiaSession, IDisposable
    {
        // V20: SD documents for LAD, not FBD.
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
                PortalCandidate chosen;
                try { chosen = PortalSelector.Choose(procs.Select(p => new PortalCandidate(p.Id, p.ProjectPath?.FullName)).ToList(), args.ProjectPath); }
                catch (RpcException e) when (args.OpenHeadless && args.ProjectPath != null && (e.Code == ErrorCodes.TiaNotRunning || e.Code == ErrorCodes.NoProject))
                {
                    return OpenHeadless(args, emit);
                }
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
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    refs.Clear();
                    WalkBlocks(plc, device, plc.BlockGroup, new List<string>(), refs);
                    WalkTypes(plc, device, plc.TypeGroup, new List<string>(), refs);
                    WalkTags(plc, device, plc.TagTableGroup, new List<string>(), refs);
                    WalkWatch(plc, device, plc.WatchAndForceTableGroup, new List<string>(), refs);
                    WalkNetwork(plc, device, refs);
                    break;
                }
                catch (Exception e) when (attempt < 3 && (e is EngineeringObjectDisposedException || e is InvalidOperationException))
                {
                    // someone deleted, replaced or added an object while rung listed them (an edit in TIA, another
                    // Openness client): "access to a disposed object", "collection was modified". List again.
                    plc = Plc(device);
                }
            }
            foreach (var key in _index.Keys.Where(k => k.StartsWith("plc:" + AddressFormat.EscapeSegment(device) + "/", StringComparison.Ordinal)).ToList()) _index.Remove(key);
            foreach (var r in refs) _index[r.Entry.Address] = r;
            return refs.Select(r => r.Entry).ToList();
        }

        static string Addr(string device, string kind, List<string> groups, string name, string ns) =>
            AddressFormat.Format(new AddressParts { Device = device, Kind = kind, Groups = groups.ToArray(), Name = name, Namespace = string.IsNullOrEmpty(ns) ? null : ns });

        static string Dates(params DateTime[] d) => "dt:" + string.Join(":", d.Select(x => x.Ticks));

        // fingerprints cost 25-60 ms per block; an idle watch re-read all of them on every pass.
        // Between full refreshes an object whose modification dates and consistency are unchanged keeps its
        // fingerprint. Revision checks before imports and exports never use the cache (Revision()).
        static readonly TimeSpan FingerprintRefresh = TimeSpan.FromMinutes(5);
        readonly Dictionary<string, (string Key, string Fingerprint, DateTime At)> _fingerprints = new Dictionary<string, (string, string, DateTime)>(StringComparer.Ordinal);

        string CachedFingerprint(string address, IEngineeringServiceProvider obj, bool? consistent, string dates)
        {
            var key = dates + "|" + consistent;
            var now = DateTime.UtcNow;
            if (_fingerprints.TryGetValue(address, out var c) && c.Key == key && now - c.At < FingerprintRefresh) return c.Fingerprint;
            var fp = Fingerprint(obj, consistent, () => dates);
            _fingerprints[address] = (key, fp, now);
            return fp;
        }

        // tying an object to a library type or updating the type changes its modification date
        readonly Dictionary<string, (string Dates, string Type)> _libraryTypes = new Dictionary<string, (string, string)>(StringComparer.Ordinal);

        string CachedLibraryType(string address, IEngineeringServiceProvider obj, string dates)
        {
            if (_libraryTypes.TryGetValue(address, out var c) && c.Dates == dates) return c.Type;
            string type = null;
            try
            {
                var v = obj.GetService<LibraryTypeInstanceInfo>()?.LibraryTypeVersion;
                if (v != null) type = v.TypeObject.Name + " " + v.VersionNumber;
            }
            catch (EngineeringException) { }
            _libraryTypes[address] = (dates, type);
            return type;
        }

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

        void LibraryInstances(string device, PlcBlockGroup group, List<string> path, Dictionary<string, List<string>> into)
        {
            foreach (PlcBlock b in group.Blocks)
            {
                var address = Addr(device, "block", path, b.Name, b.Namespace);
                AddInstance(into, CachedLibraryType(address, b, Dates(b.ModifiedDate, b.CodeModifiedDate, b.InterfaceModifiedDate)), address);
            }
            foreach (PlcBlockUserGroup g in group.Groups) LibraryInstances(device, g, new List<string>(path) { g.Name }, into);
        }

        void LibraryInstances(string device, PlcTypeGroup group, List<string> path, Dictionary<string, List<string>> into)
        {
            foreach (PlcType t in group.Types)
            {
                var address = Addr(device, "type", path, t.Name, t.Namespace);
                AddInstance(into, CachedLibraryType(address, t, Dates(t.ModifiedDate, t.InterfaceModifiedDate)), address);
            }
            foreach (PlcTypeUserGroup g in group.Groups) LibraryInstances(device, g, new List<string>(path) { g.Name }, into);
        }

        static void AddInstance(Dictionary<string, List<string>> into, string type, string address)
        {
            if (type == null) return;
            if (!into.TryGetValue(type, out var list)) into[type] = list = new List<string>();
            list.Add(address);
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
                var dates = Dates(b.ModifiedDate, b.CodeModifiedDate, b.InterfaceModifiedDate);
                entry.Fingerprint = CachedFingerprint(entry.Address, b, entry.IsConsistent, dates);
                entry.LibraryType = CachedLibraryType(entry.Address, b, dates);
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
                    IsFailsafe = false, // V20 offers no way to tell an F-UDT
                    IsConsistent = t.IsConsistent,
                };
                var dates = Dates(t.ModifiedDate, t.InterfaceModifiedDate);
                entry.Fingerprint = CachedFingerprint(entry.Address, t, entry.IsConsistent, dates);
                entry.LibraryType = CachedLibraryType(entry.Address, t, dates);
                refs.Add(new ObjectRef { Entry = entry, Obj = t, ParentGroup = group, Plc = plc });
            }
            foreach (PlcTypeUserGroup g in group.Groups)
                WalkTypes(plc, device, g, new List<string>(path) { g.Name }, refs);
        }

        void WalkTags(PlcSoftware plc, string device, PlcTagTableGroup group, List<string> path, List<ObjectRef> refs)
        {
            foreach (PlcTagTable t in group.TagTables)
            {
                // ModifiedTimeStamp is weak: "dt:" makes rung verify it by hash periodically.
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
                    case DeviceItem _ when r.Entry.Kind == "hardware": return Addr(device, "hardware", groups, NetworkLeaf, null);
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
                case PlcWatchTable w: return ContentRevision(f => w.Export(f, ExportOptions.None, DocumentInfoOptions.None));
                case DeviceItem _ when r.Entry.Kind == "hardware": return NetworkRevision(r);
                default: return "none";
            }
        }

        /// <summary>
        /// A revision from the exported bytes, for objects without dates or fingerprints (watch tables): an import
        /// then notices a change made in TIA Portal meanwhile.
        /// </summary>
        static string ContentRevision(Action<FileInfo> export)
        {
            var dir = Path.Combine(Path.GetTempPath(), "rung-rev-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                var f = new FileInfo(Path.Combine(dir, "obj.xml"));
                export(f);
                return "xh:" + Bundle.Sha256(File.ReadAllBytes(f.FullName)).Substring(0, 16);
            }
            finally
            {
                try { Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        // ---------------------------------------------------------------- export

        public ExportResult Export(string address, string form, string targetDir)
        {
            Alive();
            var r = Resolve(address);
            var leftOnline = false;
            if (form == "auto") form = FormPolicy.Choose(r.Entry, Caps);
            Directory.CreateDirectory(targetDir);
            for (var attempt = 0; attempt < 3; attempt++)
            {
                string before, actualForm;
                var warnings = new List<string>();
                try
                {
                    // a watch table's revision is its exported bytes (ContentRevision): taken from this export
                    var fromContent = r.Obj is PlcWatchTable || r.Entry.Kind == "hardware";
                    before = fromContent ? null : Revision(r);
                    foreach (var f in Directory.GetFiles(targetDir, Stem + ".*")) File.Delete(f);
                    if (r.Entry.IsConsistent == false) warnings.Add(WarningCodes.Inconsistent);
                    actualForm = ExportInto(r, form, targetDir, warnings);
                    if (fromContent) before = "xh:" + Bundle.Sha256(File.ReadAllBytes(Path.Combine(targetDir, Stem + "." + actualForm))).Substring(0, 16);
                    else if (Revision(r) != before) continue; // changed while exporting; bytes may be torn
                }
                catch (EngineeringObjectDisposedException)
                {
                    // TIA replaced the object (seen right after an import and compile): look it up again
                    _index.Clear();
                    r = Resolve(address);
                    continue;
                }
                catch (EngineeringException e) when (!leftOnline && e.Message.IndexOf("online", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // Openness exports nothing in online mode ("This function is not supported in online mode").
                    // A pull exports object after object, so rung leaves online mode and stays offline; compare and
                    // download go online again by themselves.
                    LeaveOnline(AddressFormat.Parse(address).Device);
                    leftOnline = true;
                    continue;
                }
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
                        // blocks with networks in several languages (and other SD gaps) throw instead of
                        // returning a failed result; both cases fall back to SimaticML XML
                        var sdOk = false;
                        try
                        {
                            var res = r.Obj is PlcType t ? t.ExportAsDocuments(new DirectoryInfo(dir), Stem) : ((PlcBlock)r.Obj).ExportAsDocuments(new DirectoryInfo(dir), Stem);
                            sdOk = res.State == DocumentResultState.Success;
                        }
                        catch (EngineeringException) { sdOk = false; }
                        if (sdOk && (r.Obj is PlcType || SdKeepsEverything((PlcBlock)r.Obj, dir))) return form;
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
                    case "yaml" when r.Entry.Kind == "hardware":
                        File.WriteAllText(primary.FullName, NetworkText(AddressFormat.Parse(r.Entry.Address).Device, NetworkNodes((DeviceItem)r.Obj)), new UTF8Encoding(false));
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

        /// <summary>
        /// SD must not lose what the block holds: TIA V20 before Update 4 writes no network titles or comments into
        /// SD, and SD drops the OB type. Compared against the block's SimaticML export; any loss means XML.
        /// </summary>
        bool SdKeepsEverything(PlcBlock block, string sdDir)
        {
            var probe = Path.Combine(Path.GetTempPath(), "rung-sdcheck-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(probe);
            try
            {
                var xmlFile = new FileInfo(Path.Combine(probe, "block.xml"));
                block.Export(xmlFile, ExportOptions.None, DocumentInfoOptions.None);
                var xml = File.ReadAllText(xmlFile.FullName);
                var sd = string.Join("\n", Directory.GetFiles(sdDir, Stem + ".*").Select(File.ReadAllText));
                return !SdCheck.LosesObType(xml) && SdCheck.MissingTexts(xml, sd).Count == 0;
            }
            catch (EngineeringException) { return false; }
            finally
            {
                try { Directory.Delete(probe, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        // ---------------------------------------------------------------- import

        public ExportResult Import(string address, string form, string path, string expectedTiaRevision, string operationId)
        {
            Alive();
            using (OfflineFor(AddressFormat.Parse(address).Device))
                return ImportOffline(address, form, path, expectedTiaRevision, operationId);
        }

        ExportResult ImportOffline(string address, string form, string path, string expectedTiaRevision, string operationId)
        {
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            if (!Guid.TryParseExact(operationId, "D", out var opGuid))
                throw new RpcException(ErrorCodes.BadRequest, "operationId must be a UUID");
            operationId = opGuid.ToString("D");
            var isNew = expectedTiaRevision == "absent";
            if (isNew && AddressFormat.Parse(address).Kind == "hardware")
                throw new RpcException(ErrorCodes.UnsupportedObject, "A PLC's network settings come with the PLC in TIA Portal; rung does not create them (" + address + ")");
            var r = isNew ? NewObjectRef(address, form) : Resolve(address);
            if (r.Entry.Kind == "hardware")
            {
                if (form != "yaml") throw new RpcException(ErrorCodes.BadRequest, "Network settings are imported as yaml");
                return ImportNetwork(r, path, expectedTiaRevision, operationId);
            }
            if (FormPolicy.IsReadOnly(r.Entry) || form == "protected.yaml") throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only: " + (FormPolicy.ReadOnlyReason(r.Entry) ?? "know-how protected"));
            if (!isNew && Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
            var name = r.Entry.Address;
            IList<string> imported;
            // An import replaces a tag or watch table wholesale, and TIA does not always undo a failed one (seen
            // live: a watch table left empty after its entries were refused). A copy is kept to put back.
            var backup = !isNew && (r.Obj is PlcTagTable || r.Obj is PlcWatchTable) ? BackupTable(r, operationId) : null;
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
                    if (imported.Count == 0)
                        throw new RpcException(ErrorCodes.ImportFailed, "The file declares no block or type (empty, or only comments); it must declare \"" + want + "\". Nothing was changed");
                    if (imported.Count != 1 || imported[0] != want)
                        throw new RpcException(ErrorCodes.ImportFailed, "The file declares " + string.Join(", ", imported.Select(n => "\"" + n + "\"")) + " but its name says \"" + want + "\"; a file holds exactly that one object. Nothing was changed");
                    tx.CommitOnDispose();
                }
            }
            catch (Exception e) when (e is EngineeringException || e is RpcException)
            {
                var restored = backup != null && RestoreTable(address, backup);
                var note = restored ? " TIA Portal had changed the table anyway; rung put the previous version back." : "";
                if (e is RpcException rpc) throw new RpcException(rpc.Code, rpc.Message + note);
                throw new RpcException(ErrorCodes.ImportFailed, e.Message + note);
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
            if (_args.SaveAfterImport)
            {
                try { _project.Save(); }
                catch (EngineeringException) { result.Warnings = result.Warnings.Concat(new[] { WarningCodes.SaveFailed }).ToArray(); }
            }
            return result;
        }

        /// <summary>The table as TIA Portal exports it now, to put back if an import fails half-way.</summary>
        string BackupTable(ObjectRef r, string operationId)
        {
            var dir = WorkDir(operationId, "backup");
            Directory.CreateDirectory(dir);
            var f = new FileInfo(Path.Combine(dir, "table.xml"));
            if (r.Obj is PlcTagTable tt) tt.Export(f, ExportOptions.None, DocumentInfoOptions.None);
            else ((PlcWatchTable)r.Obj).Export(f, ExportOptions.None, DocumentInfoOptions.None);
            return f.FullName;
        }

        /// <summary>After a failed import: if the table is no longer what the backup holds, imports the backup. True when it did.</summary>
        bool RestoreTable(string address, string backupFile)
        {
            _index.Clear();
            ObjectRef cur = null;
            try { cur = Resolve(address); } catch (RpcException) { /* gone */ }
            var before = File.ReadAllText(backupFile);
            if (cur != null)
            {
                var probe = new FileInfo(Path.Combine(Path.GetDirectoryName(backupFile), "now.xml"));
                if (cur.Obj is PlcTagTable ct) ct.Export(probe, ExportOptions.None, DocumentInfoOptions.None);
                else if (cur.Obj is PlcWatchTable cw) cw.Export(probe, ExportOptions.None, DocumentInfoOptions.None);
                if (File.ReadAllText(probe.FullName) == before) return false;
            }
            var parts = AddressFormat.Parse(address);
            var plc = Plc(parts.Device);
            using (var access = _portal.ExclusiveAccess("rung: restoring " + parts.Name))
            using (var tx = access.Transaction(_project, "rung restore " + parts.Name))
            {
                var holder = new ObjectRef { Entry = new ObjectEntry { Address = address, Kind = parts.Kind }, Plc = plc };
                var group = EnsureGroup(holder);
                if (group is PlcTagTableGroup tg) tg.TagTables.Import(new FileInfo(backupFile), ImportOptions.Override);
                else if (group is PlcWatchAndForceTableGroup wg) wg.WatchTables.Import(new FileInfo(backupFile), ImportOptions.Override);
                tx.CommitOnDispose();
            }
            _index.Clear();
            return true;
        }

        /// <summary>Target for an object that does not exist yet; its folder is created inside the import transaction.</summary>
        ObjectRef NewObjectRef(string address, string form)
        {
            var parts = AddressFormat.Parse(address);
            if (parts.Unit != null) throw new RpcException(ErrorCodes.UnsupportedObject, "Creating objects in software units is not supported yet");
            ListObjects(parts.Device);
            if (_index.ContainsKey(address)) throw new RpcException(ErrorCodes.StaleRevision, address + " already exists in TIA Portal");
            // GenerateBlocksFromSource replaces a same-named block wherever it lives, so a file copied or moved
            // into another folder would overwrite the original. Names are unique per PLC across blocks and types.
            var want = Identity(parts.Name, parts.Namespace);
            var clashKinds = parts.Kind == "block" || parts.Kind == "type" ? new[] { "block", "type" } : new[] { parts.Kind };
            var clash = _index.Values.FirstOrDefault(v => Array.IndexOf(clashKinds, v.Entry.Kind) >= 0
                && string.Equals(AddressFormat.Parse(v.Entry.Address).Device, parts.Device, StringComparison.Ordinal)
                && string.Equals(Identity(AddressFormat.Parse(v.Entry.Address).Name, AddressFormat.Parse(v.Entry.Address).Namespace), want, StringComparison.OrdinalIgnoreCase));
            if (clash != null)
                throw new RpcException(ErrorCodes.NameTaken, "\"" + parts.Name + "\" already exists at " + clash.Entry.Address + "; TIA Portal names are unique per PLC. To move a block to another folder, move it in TIA Portal and rung follows.");
            var allowed = parts.Kind == "block" ? new[] { "scl", "awl", "db", "s7dcl", "xml" }
                : parts.Kind == "type" ? new[] { "udt", "s7dcl", "xml" }
                : parts.Kind == "tagtable" ? new[] { "tags.xml" }
                : parts.Kind == "watchtable" ? new[] { "xml" } : new string[0];
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
                case "watchtable":
                {
                    PlcWatchAndForceTableGroup g = r.Plc.WatchAndForceTableGroup;
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
            // the project library: type folders, types and their versions (which rung mirrors read-only), master copies
            ["libraries"] = new[] { "Folders", "Types", "Versions", "MasterCopies" },
        };

        public DescribeNode Describe(string scope, int maxNodes)
        {
            Alive();
            if (!ViewCompositions.TryGetValue(scope, out var allowed)) throw new RpcException(ErrorCodes.BadRequest, "Unknown scope " + scope + " (hardware, hmi, techobjects, libraries)");
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
                case "libraries":
                    var libNode = LibraryNode(_project.ProjectLibrary, "ProjectLibrary", "Project library", allowed, ref count, budget);
                    // global libraries open in TIA Portal with their types; the others (system, corporate) as TIA lists them, unopened
                    var open = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (Siemens.Engineering.Library.GlobalLibrary g in _portal.GlobalLibraries)
                    {
                        var gn = LibraryNode(g, "GlobalLibrary", g.Name, allowed, ref count, budget);
                        foreach (var a in new[] { "Author", "Path", "Version", "IsReadOnly" })
                            try { var s = Scalar(g.GetAttribute(a)); if (s != null) gn.Attributes[a] = s; } catch (Exception) { }
                        open.Add(g.Name);
                        Add("GlobalLibraries", gn);
                    }
                    foreach (var info in _portal.GlobalLibraries.GetGlobalLibraryInfos())
                        if (!open.Contains(info.Name)) Add("GlobalLibraries", Node(info, allowed, 0, ref count, budget));
                    // which blocks and PLC data types are instances of each version
                    var instances = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                    foreach (var plc in Plcs())
                    {
                        LibraryInstances(plc.Name, plc.BlockGroup, new List<string>(), instances);
                        LibraryInstances(plc.Name, plc.TypeGroup, new List<string>(), instances);
                    }
                    void Attach(DescribeNode n)
                    {
                        if (n.Attributes.TryGetValue("TypeObject", out var t) && n.Attributes.TryGetValue("VersionNumber", out var v)
                            && instances.TryGetValue(t.Replace("→ ", "") + " " + v, out var used))
                            n.Children["Instances"] = used.OrderBy(a => a, StringComparer.Ordinal).Select(a => new DescribeNode { Type = "Instance", Name = a, Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) }).ToList();
                        foreach (var list in n.Children.Values) foreach (var c in list) Attach(c);
                    }
                    Attach(libNode);
                    Add("ProjectLibrary", libNode);
                    break;
            }
            root.Truncated = count >= budget;
            return root;
        }

        // the type and master copy folders are properties of a library, not compositions
        static DescribeNode LibraryNode(Siemens.Engineering.Library.ILibrary lib, string type, string name, string[] allowed, ref int count, int budget)
        {
            var node = new DescribeNode { Type = type, Name = name, Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) };
            count++;
            var types = Node(lib.TypeFolder, allowed, 1, ref count, budget, "Types");
            if (types != null) node.Children["Types"] = new List<DescribeNode> { types };
            var copies = Node(lib.MasterCopyFolder, allowed, 1, ref count, budget, "Master copies");
            if (copies != null) node.Children["MasterCopies"] = new List<DescribeNode> { copies };
            return node;
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
                case Version ver: return ver.ToString();
                case System.IO.FileSystemInfo fi: return fi.FullName;
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
            // a library type version has no name: its version number is one
            node.Name = nameOverride ?? (node.Attributes.TryGetValue("Name", out var n) ? n : node.Attributes.TryGetValue("VersionNumber", out var vn) ? vn : null);
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

        /// <summary>
        /// Renames a block, PLC data type or tag table. TIA keeps every use symbolic, so callers and instance DBs
        /// follow the new name; their fingerprints stay the same, which is why the client re-exports them.
        /// </summary>
        public string Rename(string address, string newName, string expectedTiaRevision, string operationId)
        {
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            if (!Guid.TryParseExact(operationId, "D", out _)) throw new RpcException(ErrorCodes.BadRequest, "operationId must be a UUID");
            newName = (newName ?? "").Trim();
            if (newName.Length == 0 || newName.Length > 125 || newName.IndexOf('"') >= 0)
                throw new RpcException(ErrorCodes.BadRequest, "\"" + newName + "\" is not a valid name");
            var parts = AddressFormat.Parse(address);
            var newAddress = AddressFormat.Format(new AddressParts { Device = parts.Device, Unit = parts.Unit, Kind = parts.Kind, Groups = parts.Groups, Name = newName, Namespace = parts.Namespace });
            using (OfflineFor(parts.Device))
            {
                var r = Resolve(address);
                if (FormPolicy.IsReadOnly(r.Entry)) throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only: " + FormPolicy.ReadOnlyReason(r.Entry));
                if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
                var clashKinds = parts.Kind == "block" || parts.Kind == "type" ? new[] { "block", "type" } : new[] { parts.Kind };
                var want = Identity(newName, parts.Namespace);
                var clash = _index.Values.FirstOrDefault(v => v.Entry.Address != address && Array.IndexOf(clashKinds, v.Entry.Kind) >= 0
                    && string.Equals(AddressFormat.Parse(v.Entry.Address).Device, parts.Device, StringComparison.Ordinal)
                    && string.Equals(Identity(AddressFormat.Parse(v.Entry.Address).Name, AddressFormat.Parse(v.Entry.Address).Namespace), want, StringComparison.OrdinalIgnoreCase));
                if (clash != null) throw new RpcException(ErrorCodes.NameTaken, "\"" + newName + "\" already exists at " + clash.Entry.Address);
                _inImport = true;
                try
                {
                    using (var access = _portal.ExclusiveAccess("rung: renaming " + parts.Name))
                    using (var tx = access.Transaction(_project, "rung rename " + operationId))
                    {
                        if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
                        switch (r.Obj)
                        {
                            case PlcBlock b: b.Name = newName; break;
                            case PlcType t: t.Name = newName; break;
                            case PlcTagTable tt: tt.Name = newName; break;
                            default: throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot rename " + address);
                        }
                        tx.CommitOnDispose();
                    }
                }
                catch (EngineeringException e) { throw new RpcException(ErrorCodes.ImportFailed, e.Message); }
                finally { _inImport = false; }
                _index.Clear();
                // the users of the old name are inconsistent until compiled, and inconsistent blocks have no fingerprint
                try { Plc(parts.Device).GetService<ICompilable>()?.Compile(); } catch (EngineeringException) { }
                _index.Clear();
                if (_args.SaveAfterImport) { try { _project.Save(); } catch (EngineeringException) { } }
            }
            return newAddress;
        }

        public void Delete(string address, string expectedTiaRevision, string operationId)
        {
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            if (!Guid.TryParseExact(operationId, "D", out _)) throw new RpcException(ErrorCodes.BadRequest, "operationId must be a UUID");
            var r = Resolve(address);
            if (FormPolicy.IsReadOnly(r.Entry)) throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only: " + FormPolicy.ReadOnlyReason(r.Entry));
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
                        case DeviceItem _ when r.Entry.Kind == "hardware": throw new RpcException(ErrorCodes.UnsupportedObject, "A PLC's network settings cannot be deleted; they stay with the PLC in TIA Portal");
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
            var byName = AddressesByName(device);
            var messages = new List<CompileMessage>();
            using (OfflineFor(device))
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
                        if (r.Entry.Kind == "hardware")
                        {
                            // network settings are hardware: the station compiles them (and its software). Its closing
                            // count ("Compiling finished (errors: 1; warnings: 2)") counts the software too: not about the file
                            var top = StationCompiler(device).Compile().Messages.Cast<CompilerResultMessage>().ToList();
                            if (top.Count > 0 && top[top.Count - 1].Messages.Count == 0) top.RemoveAt(top.Count - 1);
                            Flatten(top, a, byName, messages);
                            continue;
                        }
                        var c = (r.Obj as IEngineeringServiceProvider)?.GetService<ICompilable>();
                        if (c == null) continue; // types and tables are compiled together with their users
                        Flatten(c.Compile().Messages, a, byName, messages);
                    }
                }
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.Internal, "compile failed: " + e.Message); }
            return messages;
        }

        /// <summary>Object name → address for the device's mirrored objects; null where a name is ambiguous.</summary>
        Dictionary<string, string> AddressesByName(string device)
        {
            var plc = Plc(device);
            if (!_index.Values.Any(v => plc.Equals(v.Plc))) ListObjects(device);
            return _index.Values.Where(v => plc.Equals(v.Plc))
                .GroupBy(v => AddressFormat.Parse(v.Entry.Address).Name, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Count() == 1 ? g.First().Entry.Address : null, StringComparer.Ordinal);
        }

        static void Flatten(IEnumerable<CompilerResultMessage> list, string address, Dictionary<string, string> byName, List<CompileMessage> into)
        {
            foreach (CompilerResultMessage m in list)
            {
                // a node naming a block ("Fx_Broken (FC3)") sets the address for everything below it
                var here = address;
                if (!string.IsNullOrEmpty(m.Path) && byName.TryGetValue(CompilePath.ObjectName(m.Path), out var hit) && hit != null) here = hit;
                if (m.Messages.Count == 0 && !string.IsNullOrEmpty(m.Description) && m.State != CompilerResultState.Success)
                {
                    var leaf = CompilePath.Leaf(m.Path);
                    into.Add(new CompileMessage
                    {
                        Address = here,
                        Severity = m.State == CompilerResultState.Error ? "error" : m.State == CompilerResultState.Warning ? "warning" : "info",
                        Path = m.Path,
                        Description = m.Description,
                        BodyLine = leaf.BodyLine,
                        Section = leaf.Section,
                    });
                }
                Flatten(m.Messages, here, byName, into);
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
            // watch tables are SimaticML too; force tables stay read-only (FormPolicy)
            if (form == "xml" && r.Entry.Kind == "watchtable" && r.ParentGroup is PlcWatchAndForceTableGroup wg)
                return wg.WatchTables.Import(new FileInfo(path), ImportOptions.Override).Select(t => t.Name).ToList();
            throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot import form " + form + " for " + r.Entry.Address);
        }

        /// <summary>This bridge opened the project itself (no TIA Portal had it): close it again on exit.</summary>
        bool _ownsPortal;

        /// <summary>
        /// Opens the bound project in a TIA Portal without user interface that lives as long as this bridge, so an
        /// engineer never has to start TIA Portal for rung. Nothing is shown on screen.
        /// </summary>
        static OpennessSession OpenHeadless(BridgeArgs args, Action<string, object> emit)
        {
            var file = new FileInfo(Path.GetFullPath(args.ProjectPath));
            if (!file.Exists) throw new RpcException(ErrorCodes.NoProject, "Project file not found: " + file.FullName);
            emit("tia-starting", new { project = file.FullName, headless = true });
            var portal = new TiaPortal(TiaPortalMode.WithoutUserInterface);
            try
            {
                var project = portal.Projects.Open(file);
                var pid = TiaPortal.GetProcesses().FirstOrDefault(p => p.Mode == TiaPortalMode.WithoutUserInterface && p.ProjectPath != null && string.Equals(p.ProjectPath.FullName, file.FullName, StringComparison.OrdinalIgnoreCase))?.Id ?? 0;
                SweepWorkDirs();
                emit("tia-started", new { project = file.FullName, pid });
                return new OpennessSession(portal, project, args, emit, pid) { _ownsPortal = true };
            }
            catch (EngineeringException e)
            {
                try { portal.Dispose(); } catch (Exception) { }
                // typical: the project is locked by a TIA Portal on another PC or was opened by a newer version
                throw new RpcException(ErrorCodes.NoProject, "Could not open " + file.FullName + " in the background: " + e.Message);
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (_ownsPortal)
            {
                try { if (_args.SaveAfterImport) _project.Save(); } catch (Exception) { }
                try { _project.Close(); } catch (Exception) { }
            }
            try { _portal.Confirmation -= OnConfirmation; _portal.Dispose(); } catch (Exception) { }
        }
    }
}
