// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering.Library;
using Siemens.Engineering.Library.Types;
using Siemens.Engineering.SW.Blocks;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        readonly HashSet<string> _libraryOperations = new HashSet<string>(StringComparer.Ordinal);
        static IEnumerable<LibraryType> ProjectTypes(LibraryTypeFolder folder)
        {
            foreach (var type in folder.Types) yield return type;
            foreach (var child in folder.Folders) foreach (var type in ProjectTypes(child)) yield return type;
        }
        static IEnumerable<PlcBlock> LibraryTargetBlocks(PlcBlockGroup group)
        {
            foreach (var block in group.Blocks) yield return block;
            foreach (var child in group.Groups) foreach (var block in LibraryTargetBlocks(child)) yield return block;
        }
        public LibraryImportPreview PreviewLibrary(LibraryPackage package, string device)
        {
#if TIA_V19 || TIA_V21
            throw new RpcException(ErrorCodes.UnsupportedCapability, "Native library packages are validated for V20 only");
#else
            Alive();
            using (var access = _portal.ExclusiveAccess("rung: library import preview"))
            {
                var plc = Plc(device);
                LibraryPreflight(package, plc);
                return new LibraryImportPreview { Package = package, Device = plc.Name, Revision = LibraryImportPlan.Revision(LibraryState()) };
            }
#endif
        }
        void LibraryPreflight(LibraryPackage package, Siemens.Engineering.SW.PlcSoftware plc)
        {
            // ponytail: PLC root test environment only; no software-unit target is accepted.
            if (ProjectTypes(_project.ProjectLibrary.TypeFolder).Any(t => t.Guid.ToString("D") == package.TypeGuid
                || string.Equals(t.Name, package.TypeName, StringComparison.OrdinalIgnoreCase)
                || t.Versions.Any(v => v.Guid.ToString("D") == package.SourceVersionGuid)))
                throw new RpcException(ErrorCodes.BadRequest, "Project library type/name/version identity already exists");
            if (LibraryTargetBlocks(plc.BlockGroup).Any(b => string.Equals(b.Name, package.TypeName, StringComparison.OrdinalIgnoreCase)))
                throw new RpcException(ErrorCodes.BadRequest, "Library test block name already exists in the selected PLC; no existing block will be renamed");
        }
        LibraryImportState LibraryState() => LibraryReadState(null);
        LibraryImportState LibraryReadState(string contentTypeGuid,bool instantiated=false)
        {
            _libraryTypes.Clear();
            var objects = new SortedDictionary<string,string>(StringComparer.Ordinal);
            foreach (var plc in Plcs().OrderBy(p => p.Name,StringComparer.Ordinal))
                foreach (var entry in ListObjects(plc.Name).OrderBy(e => e.Address,StringComparer.Ordinal))
                {
                    if (objects.Count >= 4096) throw new RpcException(ErrorCodes.BadRequest,"Library import project object limit exceeded");
                    var obj = _index[entry.Address];
                    var binding = (entry.Kind == "block" || entry.Kind == "type")
                        ? ((Siemens.Engineering.IEngineeringServiceProvider)obj.Obj).GetService<LibraryTypeInstanceInfo>()?.LibraryTypeVersion : null;
                    // Native release changes engineering dates while preserving the exported LAD definition.
                    var revision=contentTypeGuid!=null && binding?.TypeObject.Guid.ToString("D")==contentTypeGuid && obj.Obj is FB fb && fb.ProgrammingLanguage.ToString()=="LAD" && !fb.IsKnowHowProtected
                        ? ContentRevision(file=> {
                            if(binding.State==LibraryTypeVersionState.InWork)fb.Export(file,Siemens.Engineering.ExportOptions.WithDefaults,Siemens.Engineering.DocumentInfoOptions.None);
                            else binding.Export(file,Siemens.Engineering.ExportOptions.WithDefaults,Siemens.Engineering.DocumentInfoOptions.None);
                        },64,bytes=>LibraryReleasePlan.DefinitionHash(bytes,instantiated)) : Revision(obj);
                    objects.Add(entry.Address,JsonSerializer.Serialize(new { entry.Kind, entry.Language, entry.BlockType, entry.Number, entry.Namespace, entry.Unit,
                        entry.KnowHowProtected, entry.IsFailsafe, entry.IsSystem, entry.IsConsistent, revision,
                        libraryTypeGuid = binding?.TypeObject.Guid.ToString("D"), libraryVersionGuid = binding?.Guid.ToString("D") },RpcWire.Json));
                }
            return new LibraryImportState { Libraries = Describe("libraries",4096), Hardware = Describe("hardware",4096), Objects = objects };
        }
        LibraryTypeVersion ReleaseTarget(LibraryReleaseRequest request)
        {
            LibraryReleasePlan.Check(request);
            var type=ProjectTypes(_project.ProjectLibrary.TypeFolder).SingleOrDefault(t=>t.Guid.ToString("D")==request.TypeGuid);
            var version=type?.Versions.SingleOrDefault(v=>v.Guid.ToString("D")==request.VersionGuid);
            if(!(version is CodeBlockLibraryTypeVersion) || type.Versions.Count!=1 || version.State!=LibraryTypeVersionState.InWork || version.Dependencies.Any() || version.Comment.Items.Count>1)
                throw new RpcException(ErrorCodes.UnsupportedCapability,"Release initially supports one dependency-free InWork code-block version; edited multi-version test environments are unavailable");
            var instances=Plcs().SelectMany(plc=>version.FindInstances(plc)).ToArray();
            if(instances.Length!=1 || !(instances[0].LibraryTypeInstance is FB block) || block.ProgrammingLanguage.ToString()!="LAD"
                || block.IsKnowHowProtected || !string.IsNullOrEmpty(block.Namespace) || !Plcs().Any(plc=>plc.BlockGroup.Blocks.Any(b=>b.Equals(block))))
                throw new RpcException(ErrorCodes.UnsupportedCapability,"Release requires one unprotected LAD FB test instance in a PLC root without namespace");
            if(!block.IsConsistent)throw new RpcException(ErrorCodes.BadRequest,"Compile and test the library FB before release; inconsistent definitions cannot be verified");
            return version;
        }
        public LibraryReleasePreview PreviewLibraryRelease(LibraryReleaseRequest request)
        {
#if TIA_V19 || TIA_V21
            throw new RpcException(ErrorCodes.UnsupportedCapability,"Native library release is validated for V20 only");
#else
            Alive();using(var access=_portal.ExclusiveAccess("rung: library release preview")) {
                ReleaseTarget(request);var state=LibraryReadState(request.TypeGuid);
                var addresses=state.Objects.Where(o=> { using(var doc=JsonDocument.Parse(o.Value))return doc.RootElement.TryGetProperty("libraryVersionGuid",out var guid)&&guid.GetString()==request.VersionGuid; }).Select(o=>o.Key).ToArray();
                return new LibraryReleasePreview { Request=request,Revision=LibraryImportPlan.Revision(state),Addresses=addresses };
            }
#endif
        }
        public LibraryImportResult ReleaseLibrary(LibraryReleaseRequest request,string expectedRevision,string operationId)
        {
#if TIA_V19 || TIA_V21
            throw new RpcException(ErrorCodes.UnsupportedCapability,"Native library release is validated for V20 only");
#else
            Alive();FixtureGuard.CheckImport(_args.AllowImport,_args.AllowFixtureImport,_project.Path.FullName);
            using(var access=_portal.ExclusiveAccess("rung: library release")) {
                ReleaseTarget(request);LibraryImportPlan.CheckRevision(expectedRevision);
                if(LibraryImportPlan.Revision(LibraryReadState(request.TypeGuid))!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project changed since the release preview");
                operationId=HardwarePlan.StartOperation(operationId,_libraryOperations,"Library");LibraryImportResult result;_inImport=true;
                try {
                    result=LibraryReleasePlan.Apply(()=>LibraryReadState(request.TypeGuid),request,expectedRevision,()=> {
                        var version=ReleaseTarget(request);
                        version.Release(CreateOrReleaseDependenciesMode.DoNotAutomaticallyCreateOrReleaseDependencies,Version.Parse(request.VersionNumber),request.Author,request.Comment);
                        if(version.State!=LibraryTypeVersionState.Committed || version.VersionNumber.ToString()!=request.VersionNumber || version.Author!=request.Author
                            || version.Comment.Items.Count>1 || (version.Comment.Items.Count==0 ? request.Comment.Length!=0 : version.Comment.Items.Single().Text!=request.Comment)
                            || version.TypeObject.Guid.ToString("D")!=request.TypeGuid || version.TypeObject.Versions.Count!=1 || version.Dependencies.Any())throw new RpcException(ErrorCodes.ImportFailed,"Native release differs: "+JsonSerializer.Serialize(new { guid=version.Guid.ToString("D"),state=version.State.ToString(),number=version.VersionNumber.ToString(),author=version.Author,dependencies=version.Dependencies.Count() },RpcWire.Json));
                        return version.Guid.ToString("D");
                    },work=>{using(var tx=access.Transaction(_project,"rung library release "+operationId)){work();tx.CommitOnDispose();}});
                } finally { _inImport=false;_index.Clear();_libraryTypes.Clear(); }
                Receipts.Write(operationId,"library:"+_project.Path.FullName);
                if(_args.SaveAfterImport)try{_project.Save();result.Saved=true;}catch(Siemens.Engineering.EngineeringException){result.Warnings=new[]{WarningCodes.SaveFailed};}
                return result;
            }
#endif
        }
        public LibraryImportResult ImportLibrary(LibraryPackage package, string device, string dir, string stem, string expectedRevision, string operationId)
        {
#if TIA_V19 || TIA_V21
            throw new RpcException(ErrorCodes.UnsupportedCapability,"Native library packages are validated for V20 only");
#else
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport,_args.AllowFixtureImport,_project.Path.FullName);
            using (var access = _portal.ExclusiveAccess("rung: library import"))
            {
                var plc = Plc(device); LibraryPreflight(package,plc);
                LibraryImportPlan.CheckRevision(expectedRevision);
                if (LibraryImportPlan.Revision(LibraryState()) != expectedRevision)
                    throw new RpcException(ErrorCodes.StaleRevision,"Project changed since the library import preview");
                operationId = HardwarePlan.StartOperation(operationId,_libraryOperations,"Library");
                _inImport = true;
                LibraryImportResult result;
                try {
                    result = LibraryImportPlan.Apply(LibraryState,package,expectedRevision,() => {
                        var transfer = _project.ProjectLibrary.TypeFolder.Types.CreateFromDocuments(new DirectoryInfo(dir),stem,plc.BlockGroup,LibraryImportOptions.None);
                        var type = transfer.CreatedType;
                        if (transfer.TransferResultState != TransferResultState.Success || !(type is CodeBlockLibraryType) || type.Name != package.TypeName || type.Versions.Count != 1)
                            throw new RpcException(ErrorCodes.ImportFailed,"TIA did not create the expected code-block library type");
                        var version = type.Versions.Single(); var block = plc.BlockGroup.Blocks.Find(package.TypeName);
                        if (!(version is CodeBlockLibraryTypeVersion) || version.Dependencies.Any() || !(block is FB)
                            || block.ProgrammingLanguage.ToString() != "LAD" || block.IsKnowHowProtected || !string.IsNullOrEmpty(block.Namespace)
                            || block.GetService<LibraryTypeInstanceInfo>()?.LibraryTypeVersion?.Guid != version.Guid
                            || version.FindInstances(plc).Count() != 1)
                            throw new RpcException(ErrorCodes.ImportFailed,"Native import test block, binding or dependencies differ");
                        return new LibraryImportResult { TypeGuid = type.Guid.ToString("D"),VersionGuid = version.Guid.ToString("D"),
                            VersionNumber = version.VersionNumber.ToString(),State = version.State.ToString(),Address = Addr(plc.Name,"block",new List<string>(),block.Name,null) };
                    }, work => { using (var tx = access.Transaction(_project,"rung library import " + operationId)) { work(); tx.CommitOnDispose(); } });
                } finally { _inImport = false; _index.Clear(); _libraryTypes.Clear(); }
                Receipts.Write(operationId,"library:" + _project.Path.FullName);
                if (_args.SaveAfterImport)
                    try { _project.Save(); result.Saved = true; } catch (Siemens.Engineering.EngineeringException) { result.Warnings = new[] { WarningCodes.SaveFailed }; }
                return result;
            }
#endif
        }
        public IReadOnlyDictionary<string, byte[]> ExportLibrary(string typeGuid, string versionGuid, string targetDir)
        {
#if TIA_V19 || TIA_V21
            throw new RpcException(ErrorCodes.UnsupportedCapability, "Native library packages are validated for V20 only");
#else
            Alive();
            using (var access = _portal.ExclusiveAccess("rung: library export"))
            {
                var type = ProjectTypes(_project.ProjectLibrary.TypeFolder).SingleOrDefault(t => t.Guid.ToString("D") == typeGuid);
                var version = type?.Versions.SingleOrDefault(v => v.Guid.ToString("D") == versionGuid);
                if (!(version is CodeBlockLibraryTypeVersion) || version.State != LibraryTypeVersionState.Committed || !version.IsDefault || version.Dependencies.Any())
                    throw new RpcException(ErrorCodes.BadRequest, "A released default dependency-free project code-block library version is required");
                const string format = "SimaticMLWithExportOptionsNone";
                if (!type.GetSupportedExportFormats().Contains(format))
                    throw new RpcException(ErrorCodes.UnsupportedCapability, "Native library XML export is unavailable");
                var result = version.ExportAsDocuments(new DirectoryInfo(targetDir), "type", format, LibraryExportOptions.WithLibraryVersionInfoFile);
                if (result.TransferResultState != TransferResultState.Success)
                    throw new RpcException(ErrorCodes.BadRequest, "TIA did not complete the native library export successfully");
                var paths = Directory.GetFiles(targetDir);
                if (paths.Length != 2 || paths.Any(p => Path.GetFileName(p) != "type.xml" && Path.GetFileName(p) != "type.libinfo")
                    || paths.Sum(p => new FileInfo(p).Length) > 4 * 1024 * 1024)
                    throw new RpcException(ErrorCodes.BadRequest, "Unsupported native library export document set or size");
                var files = paths.ToDictionary(Path.GetFileName, File.ReadAllBytes, StringComparer.Ordinal);
                LibraryPackage.Check(files, "type");
                return files;
            }
#endif
        }
    }
}
