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
        readonly Dictionary<string, ObjectRef> _index = new Dictionary<string, ObjectRef>(StringComparer.Ordinal);
        volatile bool _disposed;
        volatile bool _inImport;

        OpennessSession(TiaPortal portal, Project project, BridgeArgs args, Action<string, object> emit)
        {
            _portal = portal; _project = project; _args = args; _emit = emit;
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
                return new OpennessSession(portal, project, args, emit);
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
                TiaVersion = "V20",
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
                var fps = obj.GetService<FingerprintProvider>()?.GetFingerprints();
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

        ObjectRef Resolve(string address)
        {
            if (_index.TryGetValue(address, out var r)) return r;
            var parts = AddressFormat.Parse(address);
            ListObjects(parts.Device);
            if (_index.TryGetValue(address, out r)) return r;
            throw new RpcException(ErrorCodes.NotFound, "No object at " + address);
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
                            case PlcForceTable f: f.Export(primary, ExportOptions.None); break;
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
            FixtureGuard.Check(_args.AllowFixtureImport, _project.Path.FullName);
            var r = Resolve(address);
            if (FormPolicy.IsReadOnly(r.Entry)) throw new RpcException(ErrorCodes.ReadOnly, address + " is read-only");
            if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
            var name = r.Entry.Address;
            IList<string> imported;
            _inImport = true;
            try
            {
                using (var access = _portal.ExclusiveAccess("rung: importing " + AddressFormat.Parse(address).Name))
                using (var tx = access.Transaction(_project, "rung import " + operationId))
                {
                    if (Revision(r) != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
                    imported = ImportForm(r, form, path, operationId);
                    var want = AddressFormat.Parse(address).Name;
                    if (imported.Count != 1 || imported[0] != want)
                        throw new RpcException(ErrorCodes.ImportFailed, "Import would change [" + string.Join(", ", imported) + "] instead of exactly " + want + "; rolled back");
                    tx.CommitOnDispose();
                }
            }
            catch (EngineeringException e)
            {
                throw new RpcException(ErrorCodes.ImportFailed, e.Message);
            }
            finally { _inImport = false; }

            // Compile outside the transaction (Siemens forbids compile inside it), then return the fresh export.
            _index.Clear();
            var fresh = Resolve(address);
            try { (fresh.Obj as IEngineeringServiceProvider)?.GetService<ICompilable>()?.Compile(); }
            catch (EngineeringException) { }
            _index.Clear();
            var outDir = Path.Combine(Path.GetTempPath(), "rung-bridge", operationId);
            return Export(address, "auto", outDir);
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
                    var tmp = Path.Combine(Path.GetTempPath(), "rung-bridge", operationId, Stem + "." + form);
                    Directory.CreateDirectory(Path.GetDirectoryName(tmp));
                    File.WriteAllBytes(tmp, TextNormalizer.WithBom(File.ReadAllBytes(path)));
                    var source = r.Plc.ExternalSourceGroup.ExternalSources.CreateFromFile("rung_" + operationId.Replace("-", ""), tmp);
                    try
                    {
                        IList<IEngineeringObject> created;
                        if (r.ParentGroup is PlcBlockUserGroup bg) created = source.GenerateBlocksFromSource(bg, GenerateBlockOption.None);
                        else if (r.ParentGroup is PlcTypeUserGroup tg) created = source.GenerateBlocksFromSource(tg, GenerateBlockOption.None);
                        else created = source.GenerateBlocksFromSource(GenerateBlockOption.None);
                        return created.Select(o => o.GetAttribute("Name") as string).ToList();
                    }
                    finally { source.Delete(); }
                }
                case "s7dcl":
                {
                    var dir = new DirectoryInfo(Path.GetDirectoryName(path));
                    var stem = Path.GetFileNameWithoutExtension(path);
                    if (r.ParentGroup is PlcBlockGroup bg)
                        return bg.Blocks.ImportFromDocuments(dir, stem, ImportDocumentOptions.Override).ImportedPlcBlocks.Select(b => b.Name).ToList();
                    if (r.ParentGroup is PlcTypeGroup tg)
                        return tg.Types.ImportFromDocuments(dir, stem, ImportDocumentOptions.Override).ImportedPlcTypes.Select(t => t.Name).ToList();
                    break;
                }
                case "xml":
                    if (r.ParentGroup is PlcBlockGroup xb) return xb.Blocks.Import(new FileInfo(path), ImportOptions.Override, SWImportOptions.None).Select(b => b.Name).ToList();
                    if (r.ParentGroup is PlcTypeGroup xt) return xt.Types.Import(new FileInfo(path), ImportOptions.Override, SWImportOptions.None).Select(t => t.Name).ToList();
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
