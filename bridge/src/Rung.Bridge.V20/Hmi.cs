// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.HW.Features;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        /// <summary>
        /// A Basic/Comfort panel's tag tables, screens, screen templates and text lists, as TIA Portal exports each of them
        /// (SimaticML XML): read-only, for review and diff. The Openness model of these panels shows little more than names.
        /// </summary>
        public IReadOnlyList<HmiArtifact> ExportHmi(string device)
        {
            Alive();
            var panel = AllDevices().Where(d => d.Name == device).SelectMany(d => SoftwareOf(d.DeviceItems)).OfType<Siemens.Engineering.Hmi.HmiTarget>().FirstOrDefault()
                ?? throw new RpcException(ErrorCodes.NotFound, "No Basic or Comfort panel " + device + " (HMI Unified is shown by rung views)");
            var items = new List<HmiArtifact>();
            long total = 0;
            var dir = Path.Combine(Path.GetTempPath(), "rung-hmi-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                using (_portal.ExclusiveAccess("rung: HMI export"))
                {
                    void Export(string kind, IEnumerable<IEngineeringObject> objects, List<string> folders)
                    {
                        foreach (var obj in objects)
                        {
                            var name = (string)obj.GetAttribute("Name");
                            var file = new FileInfo(Path.Combine(dir, items.Count + ".xml"));
                            var export = obj.GetType().GetMethod("Export", new[] { typeof(FileInfo), typeof(ExportOptions) })
                                ?? throw new RpcException(ErrorCodes.UnsupportedObject, kind + " " + name + " cannot be exported");
                            try { export.Invoke(obj, new object[] { file, ExportOptions.WithDefaults }); }
                            catch (System.Reflection.TargetInvocationException e) { throw new RpcException(ErrorCodes.ExportFailed, kind + " " + name + ": " + (e.InnerException?.Message ?? e.Message)); }
                            total += file.Length;
                            if (total > 64L * 1048576 || items.Count >= 4096) throw new RpcException(ErrorCodes.ResourceLimit, "The panel's export exceeds 64 MB or 4096 objects");
                            items.Add(new HmiArtifact { Kind = kind, Folders = folders.ToArray(), Name = name, Xml = File.ReadAllText(file.FullName) });
                        }
                    }
                    // a folder holds objects and user folders: both are compositions, walked by name
                    void Walk(string kind, IEngineeringObject folder, string objects, List<string> path)
                    {
                        if (folder == null) return;
                        if (folder.GetComposition(objects) is System.Collections.IEnumerable list) Export(kind, list.OfType<IEngineeringObject>(), path);
                        if (folder.GetComposition("Folders") is System.Collections.IEnumerable sub)
                            foreach (var child in sub.OfType<IEngineeringObject>()) Walk(kind, child, objects, new List<string>(path) { (string)child.GetAttribute("Name") });
                    }
                    Walk("tags", panel.TagFolder, "TagTables", new List<string>());
                    Walk("screens", panel.ScreenFolder, "Screens", new List<string>());
                    Walk("templates", panel.ScreenTemplateFolder, "ScreenTemplates", new List<string>());
                    Export("textlists", panel.TextLists.OfType<IEngineeringObject>(), new List<string>());
                }
            }
            finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
            return items;
        }
    }
}
