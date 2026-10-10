// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.HW;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        readonly HashSet<string> _hardwareOperations = new HashSet<string>(StringComparer.Ordinal);

        HardwareObject HardwareTarget(string device, int[] positions)
        {
            HardwareObject item = AllDevices().Single(d => d.Name == device);
            foreach (var position in positions) item = item.DeviceItems.Single(i => (int)i.GetAttribute("PositionNumber") == position);
            return item;
        }
        HardwareObject ModuleParent(HardwareModule m)
        {
            var parent = HardwareTarget(m.Device, m.ParentPositions);
            if (m.Action == "create")
            {
                if (!parent.CanPlugNew(m.TypeIdentifier, m.Name, m.Position)) throw new RpcException(ErrorCodes.BadRequest, "TIA refuses this module/name/slot");
            }
            else CheckNativeModule((DeviceItem)HardwareTarget(m.Device, new[] { m.Position }), parent, m);
            return parent;
        }
        static void CheckNativeModule(DeviceItem item, HardwareObject parent, HardwareModule m)
        {
            if (item.IsBuiltIn || !Equals(item.Container, parent) || item.Name != m.Name
                || (string)item.GetAttribute("TypeIdentifier") != m.TypeIdentifier || (int)item.GetAttribute("PositionNumber") != m.Position)
                throw new RpcException(ErrorCodes.BadRequest, "Native module identity or container differs");
        }
        public HardwarePreview PreviewHardware(HardwarePatch patch)
        {
            Alive();
            using (var access = _portal.ExclusiveAccess("rung: hardware preview"))
            {
                var result = HardwarePlan.Preview(Describe("hardware", 4096), patch);
                if (patch.Version == 2) ModuleParent(patch.Module);
                return result;
            }
        }

        public HardwarePreview ApplyHardware(HardwarePatch patch, string operationId)
        {
            Alive();
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            using (var access = _portal.ExclusiveAccess("rung: hardware changes"))
            {
                // The source graph and every setter target are resolved under the same exclusive access.
                HardwarePlan.Preview(Describe("hardware", 4096), patch);
                var parent = patch.Version == 2 ? ModuleParent(patch.Module) : null;
                operationId = HardwarePlan.StartOperation(operationId, _hardwareOperations);
                Action<Action> transaction = work => {
                    using (var tx = access.Transaction(_project, "rung hardware " + operationId))
                    {
                        work();
                        tx.CommitOnDispose();
                    }
                };
                var targets = new Dictionary<HardwareChange, HardwareObject>();
                foreach (var change in patch.Changes ?? new HardwareChange[0])
                {
                    targets.Add(change, HardwareTarget(change.Device, change.Positions));
                }
                var result = patch.Version == 2
                    ? HardwarePlan.ApplyModule(() => Describe("hardware", 4096), patch, () => {
                        var m = patch.Module;
                        if (m.Action == "create")
                        {
                            if (!parent.CanPlugNew(m.TypeIdentifier, m.Name, m.Position)) throw new RpcException(ErrorCodes.BadRequest, "TIA refuses this module/name/slot");
                            CheckNativeModule(parent.PlugNew(m.TypeIdentifier, m.Name, m.Position), parent, m);
                        }
                        else
                        {
                            var item = (DeviceItem)HardwareTarget(m.Device, new[] { m.Position });
                            CheckNativeModule(item, parent, m);
                            item.Delete();
                        }
                    }, transaction)
                    : HardwarePlan.Apply(() => Describe("hardware", 4096), patch, (change, value) => targets[change].SetAttribute(change.Field, value), transaction);
                Receipts.Write(operationId, "hardware:" + _project.Path.FullName);
                _index.Clear();
                result.Saved = false;
                if (_args.SaveAfterImport)
                {
                    try { _project.Save(); result.Saved = true; }
                    catch (EngineeringException) { result.Warnings = new[] { WarningCodes.SaveFailed }; }
                }
                return result;
            }
        }
    }
}
